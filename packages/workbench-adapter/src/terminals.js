import { httpError } from './http.js'
import { TerminalUplink } from './terminal-uplink.js'
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
async function waitFor(promise, signal) {
  let abort
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason || new Error('Terminal request cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([promise, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}
/** The native terminal controller owns PTYs, screens, attachments and cleanup. */
export class WorkbenchTerminals {
  constructor({ native, service, sessions, connection, gateway }) {
    Object.assign(this, { native, service, sessions, connection, gateway })
    this.creating = new Map(); this.knownSessions = new Set(); this.attachments = new Map()
    this.disposed = false
  }
  activity() {
    let count = 0
    for (const sessionId of this.knownSessions) {
      const infos = this.native.list(sessionId)
      count += infos.filter(info => info.state === 'running').length
      if (!infos.length) this.knownSessions.delete(sessionId)
    }
    return count
  }
  dispose() {
    this.disposed = true
    for (const current of this.attachments.values()) current.abort(httpError(503, '终端连接服务已更新，请重新连接'))
    this.attachments.clear()
    for (const current of this.creating.values()) current.controller.abort()
    this.knownSessions.clear()
  }
  async agent(owner, chatId) {
    if (this.disposed) throw httpError(503, '终端连接服务已更新，请重新连接')
    const chat = this.service.requireChat(owner, chatId)
    this.knownSessions.add(chat.sessionId)
    const resolved = await this.sessions.resolveAgent(chat.sessionId)
    if (this.disposed) throw httpError(503, '终端连接服务已更新，请重新连接')
    if ('error' in resolved) throw resolved.error
    return resolved.agent
  }
  list(owner, chatId) { return this.native.list(this.service.requireChat(owner, chatId).sessionId) }
  async create(owner, chatId, request, signal) {
    signal.throwIfAborted()
    if (!uuid.test(request.id)) throw httpError(400, '终端标识无效')
    const agent = await this.agent(owner, chatId)
    signal.throwIfAborted()
    const existing = this.native.list(agent.session.id).find(info => info.id === request.id)
    if (existing) return existing
    const key = `${owner.ownerId}/${chatId}/${request.id}`
    let allocation = this.creating.get(key)
    if (allocation?.controller.signal.aborted) {
      await waitFor(allocation.promise.catch(() => {}), signal)
      return this.create(owner, chatId, request, signal)
    }
    if (!allocation) {
      allocation = { controller: new AbortController(), waiters: 0, settled: false }
      const current = allocation
      current.promise = (async () => {
        current.controller.signal.throwIfAborted()
        try {
          return await this.native.create(agent, { id: request.id, cols: request.cols, rows: request.rows,
            ...(request.shellPath ? { shellPath: request.shellPath } : {}) }, current.controller.signal)
        } catch (error) {
          if (error?.code === 'terminal/limit-reached') throw httpError(409, '每个对话最多打开 3 个终端，请先关闭一个终端', error.code)
          throw error
        }
      })().finally(() => {
        current.settled = true
        if (this.creating.get(key) === current) this.creating.delete(key)
      })
      this.creating.set(key, current)
    }
    allocation.waiters++
    try {
      return await waitFor(allocation.promise, signal)
    } finally {
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
    const key = `${owner.ownerId}/${chatId}/${id}/${attachment}`
    let held, peer, uplink, current
    try {
      signal.throwIfAborted()
      const environment = this.native.environment(agent, signal)
      peer = this.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
      uplink = new TerminalUplink({ maxBytes: environment.maxBufferedBytes,
        signal: lifetime.signal, abort: reason => lifetime.abort(reason) })
      current = { uplink, environment, abort: reason => lifetime.abort(reason) }
      this.attachments.get(key)?.abort(httpError(409, '终端连接已替换'))
      this.attachments.set(key, current)
      held = this.native.retain(agent.session.id, id, lifetime.signal)[Symbol.asyncIterator]()
      const first = await held.next()
      if (first.done || first.value.type !== 'retained') throw httpError(404, '终端已经关闭')
      const stream = await this.gateway.stream({ peer, namespace: 'terminal', method: 'attach',
        args: { agentId: agent.session.id, id }, uplink, signal: lifetime.signal })
      for await (const frame of stream) {
        if (frame.type === 'ack') { uplink.acknowledge(frame); continue }
        // Keep the existing signed HTTP presentation compatible with open tabs.
        // The native per-follower writable flag remains the authority.
        const value = frame.info ? { ...frame, info: { ...frame.info,
          controllerId: frame.writable ? attachment : frame.info.state === 'running' ? 'other-attachment' : undefined } } : frame
        yield { event: 'workbench_terminal', value: frame.type === 'snapshot' ? { ...value, environment } : value }
      }
    } catch (error) {
      // A failed close retains its native slot so cleanup can be retried. Do not
      // present it as a deleted resource and let the UI discard the close action.
      if (['terminal/not-found', 'terminal/unavailable'].includes(error?.code)
        && this.native.list(agent.session.id).some(info => info.id === id))
        throw httpError(409, '终端关闭尚未完成，请重试关闭', 'terminal/closing')
      throw error
    } finally {
      signal.removeEventListener('abort', stop)
      if (this.attachments.get(key) === current) this.attachments.delete(key)
      lifetime.abort()
      uplink?.close()
      try { await held?.return?.() } finally { await peer?.dispose() }
    }
  }
  async control(owner, chatId, id, action, request) {
    const agent = await this.agent(owner, chatId)
    if (action === 'close') return this.native.close(agent, id)
    if (!uuid.test(request.attachment_id)) throw httpError(400, '终端连接标识无效')
    const attachment = this.attachments.get(`${owner.ownerId}/${chatId}/${id}/${request.attachment_id}`)
    if (!attachment) throw httpError(409, '终端连接已结束，请重新连接')
    if (action === 'write') {
      if (typeof request.data !== 'string') throw httpError(400, '终端输入无效')
      if (Buffer.byteLength(request.data, 'utf8') > attachment.environment.maxInputBytes)
        throw httpError(413, '终端输入超过大小限制')
      return attachment.uplink.send({ type: 'write', data: request.data })
    }
    if (action === 'resize') {
      const { maxCols, maxRows } = attachment.environment
      if (!Number.isSafeInteger(request.cols) || request.cols < 2 || request.cols > maxCols ||
          !Number.isSafeInteger(request.rows) || request.rows < 1 || request.rows > maxRows)
        throw httpError(400, '终端尺寸无效')
      return attachment.uplink.send({ type: 'resize', cols: request.cols, rows: request.rows })
    }
    throw httpError(400, '终端操作无效')
  }
}
