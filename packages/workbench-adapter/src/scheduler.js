import { requireDatabaseModel } from './database-models.js'
import { setTimeout as delay } from 'node:timers/promises'

const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'discarded', 'steered'])

export async function fenceMcpExecutions(platformClient, owner, runIds) {
  let uncertain = false
  try {
    for (const runId of new Set(runIds)) {
      const response = await platformClient.json({ owner, method: 'POST', route: 'mcp/cancel',
        contentType: 'application/json', body: Buffer.from(JSON.stringify({ run_id: runId })), timeoutMs: 15000 })
      const confirmation = response.data ?? response
      if (confirmation.fenced !== true) throw new Error('MCP execution has not been fenced')
      uncertain ||= confirmation.uncertain === true
    }
    return { fenced: true, uncertain }
  } catch (error) {
    throw Object.assign(new Error('模型已收到暂停请求，工具停止确认尚未完成，请重试', { cause: error }), { status: 503, code: 'CANCEL_UNCONFIRMED' })
  }
}

export function currentExecutionRun(database, agents, sessionId) {
  const agent = agents?.get(sessionId)
  const events = agent?.session?.snapshotEvents?.()
  if (events) {
    const start = events.findLast(event => event.type === 'turn/start')
    const end = events.findLast(event => event.type === 'turn/end')
    if (!start || end?.data.turn === start.data.turn) return undefined
    return database.runForTurn(sessionId, start.data.turn)
  }
  const active = database.activeRunBySession(sessionId)
  return ['running', 'waiting_input', 'stopping'].includes(active?.status) ? active : undefined
}

/** Durable admission tickets. After dispatch DSH owns the Session inbox and turns. */
export class TaskScheduler {
  constructor({ database, sessions, platformClient, ownerId, agents, modelSettings, goals, generation = process.env.GXZS_HOST_GENERATION ?? 'local' }) {
    Object.assign(this, { database, sessions, platformClient, ownerId, agents, modelSettings, goals, generation })
    this.pendingTick = null
    this.closed = false
    this.retrying = new Set()
    this.deletingChats = new Set()
    this.leases = new Map()
    this.nativeAdmissions = new Map()
    this.unfencedSessions = new Set()
  }

  async enqueue(run, content, retry = false) {
    if (retry) throw new Error('execution retries require a new run identity')
    this.database.saveSubmission(run.ownerId, run.id, content)
    // Return acceptance immediately. File/model/network startup belongs to the
    // dispatcher, not the browser request (which may be disconnected).
    void this.tick()
  }

  async request(run, action, retry = false, signal, rotated = false) {
    this.database.ensureTicketGeneration(this.ownerId, run.id, this.generation)
    const ticketId = this.database.submission(this.ownerId, run.id)?.ticketId
    const value = await this.platformClient.json({
      owner: { ownerId: this.ownerId }, method: 'POST', route: 'scheduling',
      body: Buffer.from(JSON.stringify({ action, run_id: run.id, ticket_id: ticketId, chat_id: run.chatId, retry })), contentType: 'application/json',
      timeoutMs: 5000, signal,
    })
    const result = value.data ?? value
    if (result.state === 'fenced' && result.code === 'ADMISSION_TICKET_FENCED' && !rotated && action !== 'release') {
      this.database.rotateSubmissionTicket(this.ownerId, run.id, this.generation)
      if (action === 'acquire') return this.request(run, action, retry, signal, true)
    }
    if (result.state === 'running') this.leases.set(run.sessionId, { runId: run.id, checkedAt: Date.now() })
    else if (action === 'release' || action === 'renew') this.leases.delete(run.sessionId)
    return result
  }

  hasAdmission(sessionId) {
    const lease = this.leases.get(sessionId)
    return Boolean(lease && !this.unfencedSessions.has(sessionId) && Date.now() - lease.checkedAt < 10000)
  }

  async cancelExecution(run) {
    this.unfencedSessions.add(run.sessionId)
    this.leases.delete(run.sessionId)
    const active = currentExecutionRun(this.database, this.agents, run.sessionId)
    const runIds = [...new Set([...(run.status !== 'queued' || active?.id === run.id ? [run.id] : []), ...(active ? [active.id] : [])])]
    for (const runId of runIds) this.database.requireRunFence(this.ownerId, runId)
    const agent = this.agents?.get(run.sessionId)
    const goal = agent && this.goals?.get(agent)
    if (goal?.phase === 'active') this.goals.pause(agent, { id: goal.id, revision: goal.revision })
    this.sessions.cancel({ sessionId: run.sessionId })
    const result = await fenceMcpExecutions(this.platformClient, { ownerId: this.ownerId }, runIds)
    for (const runId of runIds) this.database.confirmRunFence(this.ownerId, runId, result)
    this.unfencedSessions.delete(run.sessionId)
    return result
  }

  async flushFences() {
    const pending = this.database.pendingRunFences(this.ownerId)
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length && !this.closed) {
        const run = pending.shift()
        const result = await fenceMcpExecutions(this.platformClient, { ownerId: this.ownerId }, [run.id])
        this.database.confirmRunFence(this.ownerId, run.id, result)
      }
    }))
  }

  /** Native lifecycle fence, also reached by Goal and restored inbox turns. */
  async admitNativeStep({ agent, turn, signal }, next) {
    const sessionId = agent.session?.id ?? agent.id
    const chat = this.database.getChatBySession(sessionId)
    if (!chat) {
      const inherited = this.executionRun?.(sessionId)
      return inherited?.status === 'running' && this.hasAdmission(inherited.sessionId) ? next() : { kind: 'reject' }
    }
    if (chat.ownerId !== this.ownerId || this.closed || this.unfencedSessions.has(sessionId)) return { kind: 'reject' }
    const run = this.database.runForTurn(sessionId, turn)
    if (!run || TERMINAL.has(run.status)) return { kind: 'reject' }
    while (!this.hasAdmission(sessionId)) {
      signal.throwIfAborted()
      if (this.closed || TERMINAL.has(this.database.getRun(this.ownerId, run.id)?.status)) return { kind: 'reject' }
      // Do not redeliver a native message merely to obtain its execution lease.
      let holder = this.database.submissions(this.ownerId).find(item =>
        item.dispatched && this.database.getRun(this.ownerId, item.runId)?.sessionId === sessionId)
      if (!holder) {
        this.database.saveSubmission(this.ownerId, run.id, [])
        this.database.dispatchSubmission(this.ownerId, run.id)
        holder = this.database.submission(this.ownerId, run.id)
      }
      const holderRun = this.database.getRun(this.ownerId, holder.runId)
      let pending = this.nativeAdmissions.get(sessionId)
      if (!pending) {
        pending = this.request(holderRun, 'acquire', false, signal).finally(() => this.nativeAdmissions.delete(sessionId))
        this.nativeAdmissions.set(sessionId, pending)
      }
      const ticket = await pending
      signal.throwIfAborted()
      if (ticket.state !== 'running') {
        this.database.transitionRun(this.ownerId, run.id, 'queued')
        await delay(250, undefined, { signal })
      }
    }
    signal.throwIfAborted()
    if (this.database.getRun(this.ownerId, run.id)?.status === 'queued') {
      this.database.transitionRun(this.ownerId, run.id, 'running')
      this.database.appendEvent(this.ownerId, run.id, { event: 'workbench_status', status: 'running' })
    }
    return next()
  }

  tick() {
    if (this.closed) return Promise.resolve()
    if (!this.pendingTick) this.pendingTick = this.dispatch().finally(() => { this.pendingTick = null })
    return this.pendingTick
  }

  async dispatch() {
    try { await this.flushFences() } catch { /* Persistent outbox retries on the next tick. */ }
    const groups = new Map()
    for (const item of this.database.submissions(this.ownerId)) {
      const sessionId = this.database.getRun(this.ownerId, item.runId)?.sessionId
      if (!sessionId) { this.database.removeSubmission(item.runId); continue }
      if (!groups.has(sessionId)) groups.set(sessionId, [])
      groups.get(sessionId).push(item)
    }
    const pending = [...groups.values()]
    // Session-local order stays serial; a stalled platform call cannot hold
    // every owner's conversation or lease renewal behind it.
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length && !this.closed) await this.dispatchItems(pending.shift())
    }))
  }

  async dispatchItems(items) {
    for (const item of items) {
      if (this.closed) return
      if (this.retrying.has(item.runId)) continue
      let run = this.database.getRun(this.ownerId, item.runId)
      if (run && this.deletingChats.has(run.chatId)) continue
      let admitted = false
      try {
        if (this.unfencedSessions.has(run.sessionId)) { await this.cancelExecution(run); continue }
        if (this.database.pendingRunFences(this.ownerId).some(value => value.sessionId === run.sessionId)) continue
        if (item.dispatched) {
          const agent = this.agents?.get(run.sessionId)
          const goal = agent && this.goals?.get(agent)
          if (agent?.status === 'running' || (goal?.phase === 'active' && goal.activation === 'armed')) {
            if (this.nativeAdmissions.has(run.sessionId) || !this.leases.has(run.sessionId)) continue
            const lease = await this.request(run, 'renew')
            if (this.closed) return
            if (lease.state !== 'running') await this.cancelExecution(run)
          } else {
            // Cancel keeps DSH's inbox, but an idle Session holds no execution
            // slot. The next explicit prompt must pass admission again.
            await this.request(run, 'release')
            if (this.closed) return
            this.database.finishSubmission(this.ownerId, run.id)
          }
          continue
        }
        if (TERMINAL.has(run.status)) {
          // Cancelling before dispatch also removes its global waiting ticket.
          await this.request(run, 'release')
          if (this.closed) return
          this.database.finishSubmission(this.ownerId, run.id)
          continue
        }
        // A live Session already owns admission. Its follow-ups belong to DSH's
        // inbox, not another platform task queue or a second execution lease.
        const agent = this.agents?.get(run.sessionId)
        const leaseOwner = this.database.submissions(this.ownerId).find((candidate) =>
          candidate.dispatched && candidate.runId !== run.id &&
          this.database.getRun(this.ownerId, candidate.runId)?.sessionId === run.sessionId)
        if (leaseOwner && agent?.status === 'running') {
          const holder = this.database.getRun(this.ownerId, leaseOwner.runId)
          const lease = await this.request(holder, 'renew')
          if (lease.state !== 'running') { await this.cancelExecution(holder); continue }
          if (this.closed || this.database.getRun(this.ownerId, run.id)?.status !== 'queued') continue
          await this.sessions.prompt({ requestId: run.id, sessionId: run.sessionId, mode: 'queue', content: item.content }, new AbortController().signal)
          // Admission ended at the native prompt receipt. Session persistence now
          // owns this message; the original lease remains until its inbox drains.
          this.database.finishSubmission(this.ownerId, run.id)
          continue
        }
        // First undispatched ticket per Session enters admission. DSH decides
        // which inbox item is claimed; a cached turn status cannot hold this up.
        if (this.database.submissions(this.ownerId).some((candidate) =>
          candidate.dispatched && this.database.getRun(this.ownerId, candidate.runId)?.sessionId === run.sessionId)) continue
        const ticket = await this.request(run, 'acquire')
        if (this.closed) return
        if (ticket.state !== 'running') continue
        admitted = true
        run = this.database.getRun(this.ownerId, item.runId)
        if (run.status !== 'queued') continue
        if (run.selection.model) {
          await requireDatabaseModel(this.platformClient, this.sessions, { ownerId: this.ownerId }, run.selection.model, this.modelSettings)
          const slash = run.selection.model.indexOf('/')
          await this.sessions.selectModel({ sessionId: run.sessionId, provider: run.selection.model.slice(0, slash), model: run.selection.model.slice(slash + 1),
            ...(run.selection.model_parameters?.reasoning_effort ? { reasoningEffort: run.selection.model_parameters.reasoning_effort } : {}) })
        }
        if (this.closed) return
        if (this.database.getRun(this.ownerId, run.id).status !== 'queued') continue
        // Persist the delivery boundary before calling DSH. A crash is marked
        // interrupted on restart, never blindly replayed as a second task.
        this.database.dispatchSubmission(this.ownerId, run.id)
        await this.sessions.prompt({ requestId: run.id, sessionId: run.sessionId, mode: 'queue', content: item.content }, new AbortController().signal)
      } catch (error) {
        if (this.closed) return
        // Admission outages leave queued work queued. Once dispatched, retain
        // its slot and stop execution; recovery must confirm the terminal state.
        const current = this.database.getRun(this.ownerId, item.runId)
        if (!current) {
          this.database.removeSubmission(item.runId)
          continue
        }
        if (!admitted && !TERMINAL.has(current.status) && !this.database.submission(this.ownerId, item.runId)?.dispatched
          && [400, 401, 403, 404, 405, 501].includes(error?.status)) {
          const message = '任务调度配置异常，尚未开始执行，请联系管理员检查宿主登记与调度服务'
          this.database.transitionRun(this.ownerId, current.id, 'failed', message)
          this.database.appendEvent(this.ownerId, current.id, { event: 'workbench_end', status: 'failed', error: message })
          continue
        }
        if (admitted && !TERMINAL.has(current.status) && !this.database.submission(this.ownerId, item.runId)?.dispatched) {
          this.database.transitionRun(this.ownerId, item.runId, 'failed', '任务运行配置失败，请检查模型后重试')
          this.database.appendEvent(this.ownerId, item.runId, { event: 'workbench_end', status: 'failed', error: '任务运行配置失败，请检查模型后重试' })
          continue
        }
        if (this.database.submission(this.ownerId, item.runId)?.dispatched) {
          try { await this.cancelExecution(current) } catch {}
          // A direct prompt rejection without an observed receipt is an admission
          // failure. Native idle alone never means a failed turn.
          if (admitted && !current.messageId) {
            this.database.transitionRun(this.ownerId, current.id, 'failed', '任务未能启动，请检查运行配置后重试')
            this.database.appendEvent(this.ownerId, current.id, { event: 'workbench_end', status: 'failed', error: '任务未能启动，请检查运行配置后重试' })
          }
        }
      }
    }
  }

  start() {
    this.timer = setInterval(() => { void this.tick() }, 1000)
    this.timer.unref?.()
    void this.tick()
  }

  close() { this.closed = true; this.leases.clear(); clearInterval(this.timer) }
}
