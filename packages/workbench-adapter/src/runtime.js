import { Service } from '@deepseek-ai/cordis'
import { nativeTurn } from './native-turn.js'

export class WorkbenchRuntime extends Service {
  constructor(ctx, database, ownerId) {
    super(ctx, 'workbenchRuntime', true)
    this.database = database
    this.ownerId = ownerId
    this.agents = ctx.agents
    this.childRuns = new WeakMap()
  }

  rootOf(agent) {
    const seen = new Set()
    while (agent && !seen.has(agent.id)) {
      seen.add(agent.id)
      if (this.database.getChatBySession(agent.session?.id ?? agent.id)) return agent
      agent = this.agents.list?.().find(parent => this.agents.isOwnedBy?.(agent.id, parent))
    }
  }

  bindChild(agent) {
    if (this.database.getChatBySession(agent.session?.id ?? agent.id)) return
    const parent = this.agents.list?.().find(parent => this.agents.isOwnedBy?.(agent.id, parent))
    const root = this.rootOf(agent)
    const chat = root && this.database.getChatBySession(root.session?.id ?? root.id)
    const existing = chat && this.database.listRuns(this.ownerId, chat.id)
      .find(run => run.selection?.subagent_ids?.includes(agent.id))
    const run = existing ?? (parent && this.executionRun(parent.session?.id ?? parent.id))
    if (run?.ownerId === this.ownerId) {
      this.childRuns.set(agent, run.id)
      const current = this.database.getRun(this.ownerId, run.id)
      const ids = [...new Set([...(current.selection?.subagent_ids ?? []), agent.id])]
      this.database.updateRunResources(current, { ...current.selection, subagent_ids: ids }, current.mcpTools)
    }
  }

  ownsRunBinding(binding, runId) {
    if (runId === undefined || binding === runId) return true
    const run = this.database.getRun(this.ownerId, runId)
    return run?.selection?.native_notice === true && run.parentRunId === binding
  }

  hasOwnedWork(sessionId, runId) {
    const root = this.agents?.get(sessionId)
    return Boolean(root && this.agents.list?.().some(child => child !== root && child.status === 'running'
      && this.rootOf(child) === root && this.ownsRunBinding(this.childRuns.get(child), runId)))
  }

  cancelOwned(sessionId, runId) {
    const root = this.agents?.get(sessionId)
    if (!root) return
    for (const child of this.agents.list?.() ?? []) if (child !== root && this.rootOf(child) === root
      && this.ownsRunBinding(this.childRuns.get(child), runId))
      child.cancel({ kind: 'user' }, { keepInbox: true })
  }

  executionRun(sessionId) {
    const visited = new Set()
    let agent = this.agents?.get(sessionId)
    while (agent && !visited.has(agent.id)) {
      visited.add(agent.id)
      const binding = this.childRuns.get(agent)
      if (binding) {
        const bound = this.database.getRun(this.ownerId, binding)
        const root = this.rootOf(agent)
        if (bound && root?.id === bound.sessionId) return bound.status === 'completed' && agent.status === 'running'
          ? { ...bound, status: 'running', background: true } : bound
      }
      const id = agent.session?.id ?? agent.id
      const turn = nativeTurn(agent)?.lastTurn
      const run = Number.isInteger(turn) ? this.database.runForTurn(id, turn) : this.database.activeRunBySession(id)
      if (run) return run.ownerId !== this.ownerId ? undefined : run.status === 'completed' && this.hasOwnedWork(run.sessionId, run.id)
        ? { ...run, status: 'running', background: true } : run
      // Durable parentSession alone is not authority: require live registry ownership.
      agent = this.agents.list?.().find(parent => this.agents.isOwnedBy?.(agent.id, parent))
    }
    return undefined
  }

  authorizeMcp(sessionId, resourceId, version) {
    const run = this.executionRun(sessionId)
    if (!run || run.status !== 'running' || run.ownerId !== this.ownerId) return undefined
    if (this.scheduler && !this.scheduler.hasAdmission(run.sessionId)) return undefined
    const resource = (run.mcpTools ?? []).find((item) => item.id === resourceId && item.version === version)
    return resource ? { runId: run.id, ownerId: run.ownerId, resource } : undefined
  }

  authorizeRunMcp(ownerId, runId, resourceId, version) {
    if (ownerId !== this.ownerId) return false
    const run = this.database.getRun(ownerId, runId)
    if (!run) return false
    if (run.status === 'completed' && this.hasOwnedWork(run.sessionId, run.id)) {
      return (!this.scheduler || this.scheduler.hasAdmission(run.sessionId))
        && run.mcpTools.some(resource => resource.id === resourceId && resource.version === version)
    }
    return this.authorizeMcp(run.sessionId, resourceId, version)?.runId === runId
  }
}
