const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'discarded', 'steered'])

/** Local durable dispatch, global owner-aware admission. Never prefill DSH's inbox. */
export class TaskScheduler {
  constructor({ database, sessions, platformClient, ownerId, agents }) {
    Object.assign(this, { database, sessions, platformClient, ownerId, agents })
    this.pendingTick = null
    this.closed = false
    this.retrying = new Set()
  }

  async enqueue(run, content, retry = false) {
    if (retry && this.database.submission(this.ownerId, run.id)) {
      this.retrying.add(run.id)
      try {
        await this.pendingTick
        if (this.database.submission(this.ownerId, run.id)) await this.request(run, 'release')
      }
      catch (error) {
        this.database.transitionRun(this.ownerId, run.id, 'failed', '调度连接尚未恢复，请稍后重试')
        this.retrying.delete(run.id)
        throw error
      }
    }
    this.database.saveSubmission(run.ownerId, run.id, content, retry)
    this.retrying.delete(run.id)
    // Return acceptance immediately. File/model/network startup belongs to the
    // dispatcher, not the browser request (which may be disconnected).
    void this.tick()
  }

  async request(run, action) {
    const ticketId = this.database.submission(this.ownerId, run.id)?.ticketId
    const value = await this.platformClient.json({
      owner: { ownerId: this.ownerId }, method: 'POST', route: 'scheduling',
      body: Buffer.from(JSON.stringify({ action, run_id: run.id, ticket_id: ticketId, chat_id: run.chatId })), contentType: 'application/json',
    })
    return value.data ?? value
  }

  tick() {
    if (this.closed) return Promise.resolve()
    if (!this.pendingTick) this.pendingTick = this.dispatch().finally(() => { this.pendingTick = null })
    return this.pendingTick
  }

  async dispatch() {
    for (const item of this.database.submissions(this.ownerId)) {
      if (this.closed) return
      if (this.retrying.has(item.runId)) continue
      let run = this.database.getRun(this.ownerId, item.runId)
      let admitted = false
      try {
        if (TERMINAL.has(run.status)) {
          const agent = this.agents?.get(run.sessionId)
          if (item.dispatched && (agent?.status === 'running' || agent?.inbox?.nextTurn?.length || agent?.inbox?.nextStep?.length)) {
            // A turn-end event can precede Agent finalization or a goal's next
            // internal turn. Keep the task slot until execution really rests.
            const lease = await this.request(run, 'renew')
            if (this.closed) return
            if (lease.state !== 'running') this.sessions.cancel({ sessionId: run.sessionId })
            continue
          }
          // Cancelling before dispatch also removes its global waiting ticket.
          await this.request(run, 'release')
          if (this.closed) return
          this.database.finishSubmission(this.ownerId, run.id)
          continue
        }
        if (item.dispatched) {
          const lease = await this.request(run, 'renew')
          if (this.closed) return
          if (lease.state !== 'running') throw new Error('Task admission was revoked')
          continue
        }
        if (this.database.activeRun(this.ownerId, run.chatId)?.id !== run.id) continue
        const ticket = await this.request(run, 'acquire')
        if (this.closed) return
        if (ticket.state !== 'running') continue
        admitted = true
        run = this.database.getRun(this.ownerId, item.runId)
        if (run.status !== 'queued') continue
        if (run.selection.model) {
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
      } catch {
        if (this.closed) return
        // Admission outages leave queued work queued. Once dispatched, retain
        // its slot and stop execution; recovery must confirm the terminal state.
        const current = this.database.getRun(this.ownerId, item.runId)
        if (admitted && !TERMINAL.has(current.status) && !this.database.submission(this.ownerId, item.runId)?.dispatched) {
          this.database.transitionRun(this.ownerId, item.runId, 'failed', '任务运行配置失败，请检查模型后重试')
          this.database.appendEvent(this.ownerId, item.runId, { event: 'workbench_end', status: 'failed', error: '任务运行配置失败，请检查模型后重试' })
          continue
        }
        if (this.database.submission(this.ownerId, item.runId)?.dispatched) {
          try { this.sessions.cancel({ sessionId: current.sessionId }) } catch {}
          const agent = this.agents?.get(current.sessionId)
          if (!TERMINAL.has(current.status) && this.agents && (!agent || (agent.status === 'idle' && !agent.inbox?.nextTurn?.length && !agent.inbox?.nextStep?.length))) {
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

  close() { this.closed = true; clearInterval(this.timer) }
}
