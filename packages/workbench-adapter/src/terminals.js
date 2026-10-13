import { httpError } from './http.js'
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
/** The native terminal controller owns PTYs, screens, attachments and cleanup. */
export class WorkbenchTerminals {
  constructor({ native, service, sessions }) { this.native = native; this.service = service; this.sessions = sessions; this.creating = new Map() }
  async agent(owner, chatId) {
    const chat = this.service.requireChat(owner, chatId)
    const resolved = await this.sessions.resolveAgent(chat.sessionId)
    if ('error' in resolved) throw resolved.error
    return resolved.agent
  }
  list(owner, chatId) { return this.native.list(this.service.requireChat(owner, chatId).sessionId) }
  async create(owner, chatId, request, signal) {
    signal.throwIfAborted()
    if (!uuid.test(request.id)) throw httpError(400, '终端标识无效')
    const agent = await this.agent(owner, chatId)
    signal.throwIfAborted()
    const key = `${owner.ownerId}/${chatId}`
    let allocation = this.creating.get(key)
    if (!allocation) {
      const retained = this.native.list(agent.session.id)
      const running = retained.findLast(info => info.state === 'running')
      if (running) return running
      allocation = { controller: new AbortController(), waiters: 0, settled: false }
      const current = allocation
      current.promise = (async () => {
        for (const info of retained) await this.native.close(agent, info.id)
        current.controller.signal.throwIfAborted()
        try {
          return await this.native.create(agent, { id: request.id, cols: request.cols, rows: request.rows,
            ...(request.shellPath ? { shellPath: request.shellPath } : {}) }, current.controller.signal)
        } catch (error) {
          if (error?.code === 'terminal/limit-reached') throw httpError(409, '当前对话已有终端，请打开已有标签')
          throw error
        }
      })().finally(() => {
        current.settled = true
        if (this.creating.get(key) === current) this.creating.delete(key)
      })
      this.creating.set(key, current)
    }
    allocation.waiters++
    let abort
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason || new Error('Terminal request cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      return await Promise.race([allocation.promise, cancelled])
    } finally {
      signal.removeEventListener('abort', abort)
      if (--allocation.waiters === 0 && !allocation.settled) allocation.controller.abort()
    }
  }
  async *follow(owner, chatId, id, attachment, signal) {
    if (!uuid.test(attachment)) throw httpError(400, '终端连接标识无效')
    const agent = await this.agent(owner, chatId)
    // The open tab holds the native process even while its Session is in the background.
    const lifetime = new AbortController()
    const stop = () => lifetime.abort(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    let held
    try {
      signal.throwIfAborted()
      held = this.native.retain(agent.session.id, id, lifetime.signal)[Symbol.asyncIterator]()
      const first = await held.next()
      if (first.done || first.value.type !== 'retained') throw httpError(404, '终端已经关闭')
      for await (const frame of this.native.follow(agent, id, attachment, signal)) yield { event: 'workbench_terminal', value: frame }
    } finally {
      signal.removeEventListener('abort', stop)
      lifetime.abort()
      await held?.return?.()
    }
  }
  async control(owner, chatId, id, action, request) {
    const agent = await this.agent(owner, chatId)
    if (action === 'close') return this.native.close(agent, id)
    if (!uuid.test(request.attachment_id)) throw httpError(400, '终端连接标识无效')
    if (action === 'write') return this.native.write(agent, id, request.attachment_id, request.data)
    if (action === 'resize') return this.native.resize(agent, id, request.attachment_id, request.cols, request.rows)
    throw httpError(400, '终端操作无效')
  }
}
