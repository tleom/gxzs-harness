import { Service } from '@deepseek-ai/cordis'
import { nativeTurn } from './native-turn.js'

export class WorkbenchRuntime extends Service {
  constructor(ctx, database, ownerId) {
    super(ctx, 'workbenchRuntime', true)
    this.database = database
    this.ownerId = ownerId
    this.agents = ctx.agents
    this.projections = ctx.sessionProjections
    this.childRuns = new WeakMap()
    this.childPrompts = new Map()
    this.childPromptMutations = new Map()
  }

  rootOf(agent) {
    const seen = new Set()
    while (agent && !seen.has(agent.id)) {
      seen.add(agent.id)
      if (this.database.getChatBySession(agent.session?.id ?? agent.id)) return agent
      agent = this.agents.list?.().find(parent => this.agents.isOwnedBy?.(agent.id, parent))
    }
  }

  bindChild(agent, { activation = false } = {}) {
    if (this.database.getChatBySession(agent.session?.id ?? agent.id)) return
    const parent = this.agents.list?.().find(parent => this.agents.isOwnedBy?.(agent.id, parent))
    const root = this.rootOf(agent)
    const chat = root && this.database.getChatBySession(root.session?.id ?? root.id)
    const existing = chat && this.database.runForSubagent(this.ownerId, chat.id, agent.id)
    const inherited = parent && this.executionRun(parent.session?.id ?? parent.id)
    const run = this.childPrompts.get(agent.id) && this.database.getRun(this.ownerId, this.childPrompts.get(agent.id))
      || (activation && inherited?.status === 'running' && (existing?.stopConfirmation?.fenced || ['completed','cancelled','failed','interrupted'].includes(existing?.status)) ? inherited : existing ?? inherited)
    if (run?.ownerId === this.ownerId) {
      this.childRuns.set(agent, run.id)
      const current = this.database.getRun(this.ownerId, run.id)
      const ids = [...new Set([...(current.selection?.subagent_ids ?? []), agent.id])]
      const label = this.projections?.snapshot(root.session, ['subagentCatalog']).values.subagentCatalog?.find(child => child.id === agent.id)?.label
      this.database.updateRunResources(current, { ...current.selection, subagent_ids: ids,
        ...(label ? { subagent_names: { ...current.selection.subagent_names, [agent.id]: label } } : {}) }, current.mcpTools)
    }
  }

  /** A sidebar prompt is a new authorized activation, never a revival of a fenced MCP run. */
  prepareChildPrompt(chat, child, requestId) {
    const requestKey = `subagent-prompt:${child.id}:${requestId}`
    const saved = this.database.getCommandReceipt(this.ownerId, chat.id, requestKey)
    const replay = saved ? this.database.getRun(this.ownerId, saved.runId) : this.database.findRunByRequestKey(this.ownerId, chat.id, requestKey)
    if (replay) {
      if (['failed','discarded','cancelled','interrupted'].includes(replay.status))
        throw Object.assign(new Error('该消息已结束，请重新发送'), { status: 409, code: 'SUBAGENT_MESSAGE_FINISHED' })
      return replay
    }
    const previous = this.database.runForSubagent(this.ownerId, chat.id, child.id)
    if (!previous) throw Object.assign(new Error('子智能体运行归属尚未恢复，请稍后重试'), { status: 409 })
    const agent = this.agents.get(child.id)
    const pending = this.childPrompts.get(child.id) && this.database.getRun(this.ownerId, this.childPrompts.get(child.id))
    const authority = pending ?? previous
    if ((pending?.status === 'running' || agent?.status === 'running') && ['running','completed'].includes(authority.status) && !authority.stopConfirmation?.fenced) {
      const receipt = authority
      this.database.saveCommandReceipt(this.ownerId, chat.id, requestKey, { runId: receipt.id })
      return receipt
    }
    const { run } = this.database.createRun({ ownerId: this.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      requestKey, query: '', parentRunId: previous.id,
      selection: { ...previous.selection, subagent_ids: [child.id], subagent_names: { [child.id]: child.title },
        native_notice: false, native_child: child.id, silent_resume: true, is_continuation: true }, mcpTools: previous.mcpTools })
    this.database.transitionRun(this.ownerId, run.id, 'running')
    this.database.saveCommandReceipt(this.ownerId, chat.id, requestKey, { runId: run.id })
    this.childPrompts.set(child.id, run.id)
    if (agent) this.bindChild(agent)
    return this.database.getRun(this.ownerId, run.id)
  }

  async withChildPrompt(childId, operation) {
    const previous = this.childPromptMutations.get(childId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(operation)
    this.childPromptMutations.set(childId, pending)
    try { return await pending }
    finally { if (this.childPromptMutations.get(childId) === pending) this.childPromptMutations.delete(childId) }
  }

  settleChild(agent) {
    const binding = this.childRuns.get(agent)
    const run = binding && this.database.getRun(this.ownerId, binding)
    if (run?.selection?.native_child === agent.id && run.status === 'running') {
      const end = agent.session?.snapshotEvents?.().findLast(event => event.type === 'turn/end')
      const kind = end?.data?.reason?.kind ?? (run.stopConfirmation?.fenced ? 'aborted' : 'completed')
      const status = { completed: 'completed', aborted: 'cancelled', interrupted: 'interrupted' }[kind] ?? 'failed'
      const error = status === 'failed' ? String(end?.data?.reason?.error?.message ?? '子智能体执行失败') : undefined
      this.database.transitionRun(this.ownerId, run.id, status, error)
    }
    if (this.childPrompts.get(agent.id) === binding) this.childPrompts.delete(agent.id)
  }

  rejectChildPrompt(run) {
    // A deterministic pre-delivery rejection has no execution to fence.
    this.database.transitionRun(this.ownerId, run.id, 'discarded', '子智能体消息未被接收')
    const childId = run.selection.native_child
    if (this.childPrompts.get(childId) === run.id) this.childPrompts.delete(childId)
    const agent = this.agents.get(childId)
    if (agent && this.childRuns.get(agent) === run.id) this.childRuns.delete(agent)
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
        // A parent question pauses the parent, not its already owned child work.
        if (bound && root?.id === bound.sessionId) return ['completed', 'waiting_input'].includes(bound.status) && agent.status === 'running'
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
    if (!run || run.status !== 'running' || run.ownerId !== this.ownerId || run.stopConfirmation?.fenced) return undefined
    if (this.scheduler && !this.scheduler.hasAdmission(run.sessionId)) return undefined
    const resource = (run.mcpTools ?? []).find((item) => item.id === resourceId && item.version === version)
    return resource ? { runId: run.id, ownerId: run.ownerId, resource } : undefined
  }

  async authorizeMcpCall(sessionId, resourceId, version, signal = new AbortController().signal) {
    signal.throwIfAborted()
    const run = this.executionRun(sessionId)
    // A native step may outlive its cached admission while streaming. Keep
    // its frozen authority, but wait for the existing scheduler to confirm
    // capacity before starting any external tool side effect.
    if (!run || run.ownerId !== this.ownerId || run.stopConfirmation?.fenced
      || !['running', 'queued'].includes(run.status)
      || (run.status === 'queued' && !this.database.submission(this.ownerId, run.id)?.dispatched)
      || !(run.mcpTools ?? []).some(item => item.id === resourceId && item.version === version)) return undefined
    if (this.scheduler && !this.scheduler.hasAdmission(run.sessionId))
      await this.scheduler.admitRun(run, signal, () => true)
    signal.throwIfAborted()
    const authorization = this.authorizeMcp(sessionId, resourceId, version)
    // Cancellation or a new turn during the wait cannot lend this old call
    // the next run's credentials or resource selection.
    return authorization?.runId === run.id ? authorization : undefined
  }

  authorizeRunMcp(ownerId, runId, resourceId, version) {
    if (ownerId !== this.ownerId) return false
    const run = this.database.getRun(ownerId, runId)
    if (!run || run.stopConfirmation?.fenced) return false
    if ((['completed', 'waiting_input'].includes(run.status) || (run.status === 'running' && run.selection?.native_child)) && this.hasOwnedWork(run.sessionId, run.id)) {
      return (!this.scheduler || this.scheduler.hasAdmission(run.sessionId))
        && run.mcpTools.some(resource => resource.id === resourceId && resource.version === version)
    }
    return this.authorizeMcp(run.sessionId, resourceId, version)?.runId === runId
  }
}
