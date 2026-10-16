import { requireDatabaseModel } from './database-models.js'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { nativeTurn } from './native-turn.js'
import { dispatchRunPrompt } from './native-prompt.js'
import { nativeError } from './http.js'

const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'discarded', 'steered'])
const DIAGNOSTIC_CODES = new Set(['ADMISSION_TICKET_FENCED', 'DEADLINE_EXCEEDED', 'UPSTREAM_RESPONSE_TOO_LARGE',
  'CANCEL_UNCONFIRMED', 'HOST_NOT_REGISTERED', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_REQUEST',
  'UPSTREAM_ERROR', 'UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL_ERROR'])
const DIAGNOSTIC_STATES = new Set(['running', 'waiting', 'done', 'retry', 'fenced', 'missing'])
const DIAGNOSTIC_REASONS = new Set(['request_failed', 'unfenced', 'renew_state', 'dispatch_error'])
const DIAGNOSTIC_ACTIONS = new Set(['acquire', 'renew', 'release', 'cancel', 'dispatch'])
const RETRYABLE_ADMISSION_STATUSES = new Set([408, 429, 500, 502, 503, 504])

function retryableAdmissionError(error) {
  if (error?.name === 'AbortError' || error?.code === 'UPSTREAM_RESPONSE_TOO_LARGE') return false
  if (error?.status != null) return RETRYABLE_ADMISSION_STATUSES.has(error.status)
  return error?.name === 'TypeError' || error?.name === 'TimeoutError'
}

export async function fenceMcpExecutions(platformClient, owner, runIds, signal) {
  let uncertain = false
  try {
    for (const runId of new Set(runIds)) {
      const response = await platformClient.json({ owner, method: 'POST', route: 'mcp/cancel',
        contentType: 'application/json', body: Buffer.from(JSON.stringify({ run_id: runId })), timeoutMs: 15000, signal })
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
  const boundary = nativeTurn(agent)
  if (boundary) {
    if (boundary.openTurnStartSeq === null) return undefined
    return database.runForTurn(sessionId, boundary.lastTurn)
  }
  const active = database.activeRunBySession(sessionId)
  return ['running', 'waiting_input', 'stopping'].includes(active?.status) ? active : undefined
}

async function waitForAdmission(pending, signal) {
  let abort
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason?.name === 'TimeoutError' ? signal.reason
      : Object.assign(new Error('Admission wait cancelled', { cause: signal.reason }), { name: 'AbortError' }))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([pending, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

/** Durable admission tickets. After dispatch DSH owns the Session inbox and turns. */
export class TaskScheduler {
  constructor({ database, sessions, platformClient, ownerId, agents, modelSettings, goals, prepareContent, generation = process.env.GXZS_HOST_GENERATION ?? 'local' }) {
    Object.assign(this, { database, sessions, platformClient, ownerId, agents, modelSettings, goals, generation })
    this.prepareContent = prepareContent ?? (async (_sessionId, content) => content)
    this.pendingTick = null
    this.closed = false
    this.retrying = new Set()
    this.deletingChats = new Set()
    this.leases = new Map()
    this.nativeAdmissions = new Map()
    this.submissionMutations = new Map()
    this.unfencedSessions = new Set()
    this.pendingFenceTick = null
    this.fenceLifetime = new AbortController()
  }

  diagnostic(run, operation, reason, { action, state, error, code } = {}) {
    // Never serialize upstream errors: even their message/code may contain secrets.
    // Diagnostics are best effort and must not change admission or cancellation.
    try {
      const rawCode = code ?? error?.code
      const generation = String(this.generation)
      console.warn(JSON.stringify({ event: 'workbench_scheduler',
        operation: ['request_failed', 'renew_rejected', 'dispatch_failed', 'cancel_execution', 'tick_failed'].includes(operation) ? operation : 'unknown',
        reason: DIAGNOSTIC_REASONS.has(reason) ? reason : 'unknown',
        action: DIAGNOSTIC_ACTIONS.has(action) ? action : 'unknown',
        status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null,
        code: DIAGNOSTIC_CODES.has(rawCode) ? rawCode : error?.name === 'TimeoutError' ? 'TIMEOUT'
          : error?.name === 'AbortError' ? 'ABORTED' : null,
        state: DIAGNOSTIC_STATES.has(state) ? state : null,
        generation: generation === 'local' ? 'local' : /^[1-9]\d{0,8}$/.test(generation) ? Number(generation) : null,
        run_hash: typeof run?.id === 'string' ? createHash('sha256').update(run.id).digest('hex').slice(0, 12) : null,
      }))
    } catch { /* A failed log sink must not change task behavior. */ }
  }

  async enqueue(run, content, retry = false) {
    if (retry) throw new Error('execution retries require a new run identity')
    this.database.saveSubmission(run.ownerId, run.id, content)
    // Return acceptance immediately. File/model/network startup belongs to the
    // dispatcher, not the browser request (which may be disconnected).
    void this.tick()
  }

  async prompt(run, content, markDispatched = false) {
    return this.withSubmissionMutation(run.id, () => this.dispatchPrompt(run, content, markDispatched))
  }

  async withSubmissionMutation(runId, operation) {
    const previous = this.submissionMutations.get(runId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(operation)
    this.submissionMutations.set(runId, pending)
    try { return await pending }
    finally { if (this.submissionMutations.get(runId) === pending) this.submissionMutations.delete(runId) }
  }

  async dispatchPrompt(run, content, markDispatched) {
    // A queue edit may have completed while admission was waiting on the network.
    content = this.database.submission(this.ownerId, run.id)?.content ?? content
    const prepared = await this.prepareContent(run.sessionId, content)
    if (this.closed || this.database.getRun(this.ownerId, run.id)?.status !== 'queued') return false
    if (markDispatched) this.database.dispatchSubmission(this.ownerId, run.id)
    await dispatchRunPrompt(this, run, prepared)
    return true
  }

  async request(run, action, retry = false, signal, rotated = false) {
    this.database.ensureTicketGeneration(this.ownerId, run.id, this.generation)
    const ticketId = this.database.submission(this.ownerId, run.id)?.ticketId
    // An explicit queue action can retire an undispatched submission while a
    // dispatcher snapshot is waiting on another ticket. Never send an omitted
    // ticket_id or revoke the live Session's lease for that obsolete snapshot.
    if (!ticketId) return { state: 'done' }
    // A release may succeed even when its response is lost. Continuations
    // must reacquire capacity rather than trust the previous cached lease.
    if (action === 'release') this.leases.delete(run.sessionId)
    let value
    try {
      value = await this.platformClient.json({
        owner: { ownerId: this.ownerId }, method: 'POST', route: 'scheduling',
        body: Buffer.from(JSON.stringify({ action, run_id: run.id, ticket_id: ticketId, chat_id: run.chatId, retry })), contentType: 'application/json',
        timeoutMs: 5000, signal,
      })
    } catch (error) {
      this.diagnostic(run, 'request_failed', 'request_failed', { action, error })
      throw error
    }
    const result = value.data ?? value
    if (action === 'renew' && result.state !== 'running')
      this.diagnostic(run, 'renew_rejected', 'renew_state', { action, state: result.state, code: result.code })
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
    return Boolean(lease && !this.closed && !this.unfencedSessions.has(sessionId) && !this.hasPendingFence(sessionId)
      && Date.now() - lease.checkedAt < 10000)
  }

  hasPendingFence(sessionId) { return this.database.pendingRunFences(this.ownerId).some(run => run.sessionId === sessionId) }

  async cancelExecution(run, reason = 'unfenced', detail = { action: 'cancel' }) {
    this.diagnostic(run, 'cancel_execution', reason, detail)
    this.unfencedSessions.add(run.sessionId)
    this.leases.delete(run.sessionId)
    const active = currentExecutionRun(this.database, this.agents, run.sessionId)
    const runIds = [...new Set([...(run.status !== 'queued' || active?.id === run.id ? [run.id] : []), ...(active ? [active.id] : [])])]
    for (const runId of runIds) this.database.requireRunFence(this.ownerId, runId)
    const agent = this.agents?.get(run.sessionId)
    const goal = agent && this.goals?.get(agent)
    if (goal?.phase === 'active') this.goals.pause(agent, { id: goal.id, revision: goal.revision })
    this.sessions.cancel({ sessionId: run.sessionId })
    this.cancelOwned?.(run.sessionId, run.id)
    // The durable fence blocks this Session immediately. Remote confirmation
    // must not hold unrelated Sessions' short admission renewals behind it.
    if (!runIds.length) this.unfencedSessions.delete(run.sessionId)
    this.retryFences()
  }

  retryFences() {
    if (this.closed || this.pendingFenceTick) return
    const pending = this.database.pendingRunFences(this.ownerId)
    if (!pending.length) return
    this.pendingFenceTick = this.flushFences(pending).catch(() => {
      // Leave the durable outbox pending for the next tick.
    }).finally(() => { this.pendingFenceTick = null })
  }

  async flushFences(pending = this.database.pendingRunFences(this.ownerId)) {
    let failure
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length && !this.closed) {
        const run = pending.shift()
        try {
          const result = await fenceMcpExecutions(this.platformClient, { ownerId: this.ownerId }, [run.id], this.fenceLifetime.signal)
          if (this.closed) return
          this.database.confirmRunFence(this.ownerId, run.id, result)
          if (!this.hasPendingFence(run.sessionId))
            this.unfencedSessions.delete(run.sessionId)
        } catch (error) { failure ??= error }
      }
    }))
    // Cold recovery awaits this method directly and must remain not-ready on
    // failure. Background retries catch it only after every worker settles.
    if (failure) throw failure
  }

  /** Native lifecycle fence, also reached by Goal and restored inbox turns. */
  async admitNativeStep({ agent, turn, signal }, next) {
    const sessionId = agent.session?.id ?? agent.id
    const chat = this.database.getChatBySession(sessionId)
    if (!chat) {
      const inherited = this.executionRun?.(sessionId)
      if (inherited?.status !== 'running') return { kind: 'reject' }
      const admit = () => {
        const current = this.executionRun?.(sessionId)
        return current?.id === inherited.id && current.status === 'running'
          ? this.admitRun(current, signal, () => true) : { kind: 'reject' }
      }
      // A child can need fresh capacity while the parent answer is still pending.
      const admitted = await (this.database.getRun(this.ownerId, inherited.id)?.status === 'waiting_input'
        ? this.withSubmissionMutation(`input:${inherited.sessionId}`, admit) : admit())
      if (admitted !== true) return admitted
      // The input lock protects admission only; a model stream must not hold up
      // the parent's answer. Recheck authority and capacity after unlocking.
      const current = this.executionRun?.(sessionId)
      if (current?.id !== inherited.id || current.status !== 'running') return { kind: 'reject' }
      return this.admitRun(current, signal, () => {
        const latest = this.executionRun?.(sessionId)
        return latest?.id === inherited.id && latest.status === 'running' ? next() : { kind: 'reject' }
      })
    }
    if (chat.ownerId !== this.ownerId || this.closed || this.unfencedSessions.has(sessionId)) return { kind: 'reject' }
    const run = this.database.runForTurn(sessionId, turn)
    if (!run || TERMINAL.has(run.status)) return { kind: 'reject' }
    return this.admitRun(run, signal, next)
  }

  async resumeInput(run, signal) {
    // Serialize against a waiting-input release already in flight.
    const admitted = await this.withSubmissionMutation(`input:${run.sessionId}`, () => this.admitRun(run, signal, () => true))
    if (admitted !== true) throw Object.assign(new Error('Question continuation cancelled'), { name: 'AbortError' })
  }

  async admitRun(run, signal, next) {
    const sessionId = run.sessionId
    while (true) {
      signal.throwIfAborted()
      const current = this.database.getRun(this.ownerId, run.id)
      if (this.closed || this.unfencedSessions.has(sessionId) || !current || current.stopConfirmation?.fenced
        || (TERMINAL.has(current.status)
          && !(current.status === 'completed' && run.background && this.hasOwnedWork?.(sessionId, run.id)))) return { kind: 'reject' }
      if (this.hasAdmission(sessionId)) break
      if (this.hasPendingFence(sessionId)) {
        this.retryFences()
        await delay(250, undefined, { signal })
        continue
      }
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
        // One root/child caller cancelling must not abort the shared request.
        // The platform client's bounded timeout and scheduler lifetime own I/O;
        // each caller owns only its wait below.
        pending = this.request(holderRun, 'acquire', false, this.fenceLifetime.signal).finally(() => this.nativeAdmissions.delete(sessionId))
        this.nativeAdmissions.set(sessionId, pending)
      }
      let ticket
      try { ticket = await waitForAdmission(pending, signal) }
      catch (error) {
        if (signal.aborted || !retryableAdmissionError(error)) throw error
        // A lost response does not revoke the durable ticket. Keep native
        // execution behind the admission gate until the manager answers.
        await delay(250, undefined, { signal })
        continue
      }
      signal.throwIfAborted()
      if (ticket.state !== 'running') {
        if (this.database.getRun(this.ownerId, run.id)?.status === 'running')
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
    if (!this.pendingTick) {
      this.pendingTick = this.dispatch().finally(() => { this.pendingTick = null })
      // Timer/enqueue callers intentionally detach. A storage failure outside
      // the per-run handler must not become an unhandled rejection and exit
      // the Host. Keep the original rejection for callers explicitly awaiting it.
      void this.pendingTick.catch(error => this.diagnostic(undefined, 'tick_failed', 'dispatch_error', { action: 'dispatch', error }))
    }
    return this.pendingTick
  }

  async dispatch() {
    this.retryFences()
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
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length && !this.closed) await this.dispatchItems(pending.shift())
    }))
    // An early worker failure must not release pendingTick while another
    // worker still holds a native prompt or admission request in flight.
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }

  async dispatchItems(items) {
    for (let item of items) {
      if (this.closed) return
      if (this.retrying.has(item.runId)) continue
      const submission = this.database.submission(this.ownerId, item.runId)
      if (!submission) continue
      item = submission
      let run = this.database.getRun(this.ownerId, item.runId)
      if (run && this.deletingChats.has(run.chatId)) continue
      let admitted = false
      let releasing = false
      let cancelAttempted = false
      const cancel = (...args) => { cancelAttempted = true; return this.cancelExecution(...args) }
      try {
        if (this.hasPendingFence(run.sessionId)) continue
        if (this.unfencedSessions.has(run.sessionId)) { await cancel(run, 'unfenced'); continue }
        if (item.dispatched) {
          const execution = this.executionRun?.(run.sessionId) ?? this.database.activeRunBySession(run.sessionId)
          if (execution?.status === 'waiting_input' && !this.hasOwnedWork?.(run.sessionId)) {
            releasing = true
            await this.withSubmissionMutation(`input:${run.sessionId}`, async () => {
              if (this.database.getRun(this.ownerId, execution.id)?.status !== 'waiting_input' || this.hasOwnedWork?.(run.sessionId)) return
              // Keep the delivery receipt; answering reacquires this ticket
              // without redelivering the user's original message.
              await this.request(run, 'release', true)
            })
            continue
          }
          const agent = this.agents?.get(run.sessionId)
          const goal = agent && this.goals?.get(agent)
          if (agent?.status === 'running' || this.hasOwnedWork?.(run.sessionId) || (goal?.phase === 'active' && goal.activation === 'armed')) {
            if (this.nativeAdmissions.has(run.sessionId) || !this.leases.has(run.sessionId)) continue
            let lease
            try { lease = await this.request(run, 'renew') }
            catch (error) {
              if (!retryableAdmissionError(error)) throw error
              // Retain the durable ticket and retry on the next tick. A new
              // native step still needs a fresh admission after the cache ages.
              continue
            }
            if (this.closed) return
            if (lease.state !== 'running') await cancel(run, 'renew_state', { action: 'renew', state: lease.state, code: lease.code })
          } else {
            // Cancel keeps DSH's inbox, but an idle Session holds no execution
            // slot. The next explicit prompt must pass admission again.
            releasing = true
            await this.request(run, 'release')
            if (this.closed) return
            this.database.finishSubmission(this.ownerId, run.id)
          }
          continue
        }
        if (TERMINAL.has(run.status)) {
          // Cancelling before dispatch also removes its global waiting ticket.
          releasing = true
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
        if (leaseOwner && (agent?.status === 'running' || this.hasOwnedWork?.(run.sessionId))) {
          const holder = this.database.getRun(this.ownerId, leaseOwner.runId)
          let lease
          try { lease = await this.request(holder, 'renew') }
          catch (error) {
            if (!retryableAdmissionError(error)) throw error
            // Do not deliver a follow-up while renewal is uncertain.
            continue
          }
          if (lease.state !== 'running') { await cancel(holder, 'renew_state', { action: 'renew', state: lease.state, code: lease.code }); continue }
          if (this.closed || this.database.getRun(this.ownerId, run.id)?.status !== 'queued') continue
          if (!await this.prompt(run, item.content)) continue
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
        await this.prompt(run, item.content, true)
      } catch (error) {
        if (this.closed) return
        this.diagnostic(run, 'dispatch_failed', 'dispatch_error', { action: 'dispatch', error })
        const failure = nativeError(error)
        // Retry idle-session release without cancelling an already finished
        // task or fencing the Session's subsequent prompts.
        if (releasing) continue
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
          const message = failure?.message ?? '任务运行配置失败，请检查模型后重试'
          this.database.transitionRun(this.ownerId, item.runId, 'failed', message)
          this.database.appendEvent(this.ownerId, item.runId, { event: 'workbench_end', status: 'failed', error: message,
            ...(failure ? { error_code: failure.code } : {}) })
          continue
        }
        if (this.database.submission(this.ownerId, item.runId)?.dispatched) {
          if (!cancelAttempted) {
            try { await cancel(current, 'dispatch_error', { action: 'dispatch', error }) } catch {}
          }
          // A direct prompt rejection without an observed receipt is an admission
          // failure. Native idle alone never means a failed turn.
          if (admitted && !current.messageId) {
            const message = failure?.message ?? '任务未能启动，请检查运行配置后重试'
            this.database.transitionRun(this.ownerId, current.id, 'failed', message)
            this.database.appendEvent(this.ownerId, current.id, { event: 'workbench_end', status: 'failed', error: message,
              ...(failure ? { error_code: failure.code } : {}) })
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

  close() { this.closed = true; this.fenceLifetime.abort(); this.leases.clear(); clearInterval(this.timer) }
}
