import { Service } from '@deepseek-ai/cordis'

export class WorkbenchRuntime extends Service {
  constructor(ctx, database, ownerId) {
    super(ctx, 'workbenchRuntime', true)
    this.database = database
    this.ownerId = ownerId
    this.agents = ctx.agents
  }

  executionRun(sessionId) {
    const visited = new Set()
    let agent = this.agents?.get(sessionId)
    while (agent && !visited.has(agent.id)) {
      visited.add(agent.id)
      const id = agent.session?.id ?? agent.id
      const turn = agent.session?.snapshotEvents?.().findLast(event => event.type === 'turn/start')?.data.turn
      const run = Number.isInteger(turn) ? this.database.runForTurn(id, turn) : this.database.activeRunBySession(id)
      if (run) return run.ownerId === this.ownerId ? run : undefined
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
    return this.authorizeMcp(run.sessionId, resourceId, version)?.runId === runId
  }
}
