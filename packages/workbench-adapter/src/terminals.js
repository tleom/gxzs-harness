import { httpError } from './http.js'
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
/** The native terminal controller owns PTYs, screens, attachments and cleanup. */
export class WorkbenchTerminals {
  constructor({ native, service, sessions }) { this.native = native; this.service = service; this.sessions = sessions }
  async agent(owner, chatId) {
    const chat = this.service.requireChat(owner, chatId)
    const resolved = await this.sessions.resolveAgent(chat.sessionId)
    if ('error' in resolved) throw resolved.error
    return resolved.agent
  }
  list(owner, chatId) { return this.native.list(this.service.requireChat(owner, chatId).sessionId) }
  async create(owner, chatId, request, signal) {
    if (!uuid.test(request.id)) throw httpError(400, '终端标识无效')
    const agent = await this.agent(owner, chatId)
    try {
      return await this.native.create(agent, { id: request.id, cols: request.cols, rows: request.rows,
        ...(request.shellPath ? { shellPath: request.shellPath } : {}) }, signal)
    } catch (error) {
      if (error?.code === 'terminal/limit-reached') throw httpError(429, '最多打开3个终端标签，请先关闭一个')
      throw error
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
