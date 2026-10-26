import { httpError } from './http.js'
import { isDraftId } from './drafts.js'

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

/** A window keeps existing native resources alive without one output stream per hidden tab. */
export class SidebarLeases {
  constructor({ browsers, terminals, service, ttlMs = 60000 }) {
    Object.assign(this, { browsers, terminals, service, ttlMs })
    this.windows = new Map()
    this.serial = new Map()
    this.disposed = false
  }
  async update(owner, request) {
    if (this.disposed) throw httpError(503, '侧栏连接服务已更新，请重新连接')
    if (!uuid.test(request.window_id) || !Array.isArray(request.resources))
      throw httpError(400, '侧栏窗口参数无效')
    const resources = new Map()
    for (const item of request.resources) {
      if (!['browser', 'terminal'].includes(item.kind) || !uuid.test(item.id) || (!uuid.test(item.chat_id) && !isDraftId(item.chat_id)))
        throw httpError(400, '侧栏资源参数无效')
      const context = (this.service.resourceContext ?? this.service.requireChat).call(this.service, owner, item.chat_id)
      if (!context) throw httpError(404, '资源所属会话不存在')
      resources.set(`${item.kind}:${item.id}`, item)
    }
    const key = `${owner.ownerId}/${request.window_id}`
    const previous = this.serial.get(key) || Promise.resolve()
    const operation = previous.catch(() => {}).then(() => this.replace(owner, key, resources))
    this.serial.set(key, operation)
    try { return await operation }
    finally { if (this.serial.get(key) === operation) this.serial.delete(key) }
  }
  async replace(owner, key, resources) {
    if (this.disposed) throw httpError(503, '侧栏连接服务已更新，请重新连接')
    let window = this.windows.get(key)
    if (!window) {
      if (this.windows.size >= 128) throw httpError(429, '侧栏窗口过多')
      window = { holds: new Map(), lifetime: new AbortController() }
      this.windows.set(key, window)
    }
    clearTimeout(window.timer)
    try {
      for (const [id, hold] of window.holds) {
        if (!resources.has(id) || !hold.live()) { hold.release(); window.holds.delete(id) }
      }
      for (const [id, resource] of resources) {
        if (window.holds.has(id)) continue
        try {
          const hold = await this.retain(owner, resource, window.lifetime.signal)
          if (this.disposed || this.windows.get(key) !== window) {
            hold.release()
            throw httpError(503, '侧栏连接服务已更新，请重新连接')
          }
          window.holds.set(id, hold)
        } catch (error) {
          if (![404, 410].includes(error.status) && !['terminal/not-found', 'terminal/unavailable'].includes(error.code)) throw error
        }
      }
      return { protocol: 1, held: [...window.holds.keys()], ttl_ms: this.ttlMs }
    } finally {
      if (this.windows.get(key) === window) {
        window.timer = setTimeout(() => this.remove(key, window), this.ttlMs)
        window.timer.unref?.()
      }
    }
  }
  async retain(owner, resource, signal) {
    const chat = (this.service.resourceContext ?? this.service.requireChat).call(this.service, owner, resource.chat_id)
    if (resource.kind === 'browser') {
      const browser = this.browsers.require(owner, resource.id)
      if (browser.chatId !== chat.id) throw httpError(403, '浏览器不属于当前对话')
      return { release: browser.retainWindow(), live: () => !browser.closed }
    }
    const native = this.terminals.native
    if (!native.list(chat.sessionId).some(item => item.id === resource.id)) throw httpError(404, '终端已经关闭')
    this.terminals.knownSessions.add(chat.sessionId)
    const lifetime = new AbortController()
    const retained = AbortSignal.any([signal, lifetime.signal])
    const held = native.retain(chat.sessionId, resource.id, retained)[Symbol.asyncIterator]()
    let first
    try { first = await held.next() }
    catch (error) { lifetime.abort(); throw error }
    if (first.done || first.value.type !== 'retained') { lifetime.abort(); await held.return?.(); throw httpError(404, '终端已经关闭') }
    // Resume the native lifetime iterator so terminal close/expiry can settle it.
    void held.next().catch(() => {}).finally(async () => { lifetime.abort(); await held.return?.() }).catch(() => {})
    return { release: () => lifetime.abort(), live: () => !retained.aborted }
  }
  remove(key, expected = this.windows.get(key)) {
    if (!expected || this.windows.get(key) !== expected) return
    this.windows.delete(key)
    expected.lifetime.abort(httpError(503, '侧栏连接服务已更新，请重新连接'))
    clearTimeout(expected.timer)
    for (const hold of expected.holds.values()) hold.release()
  }
  async release(owner, windowId) {
    if (!uuid.test(windowId)) throw httpError(400, '侧栏窗口标识无效')
    const key = `${owner.ownerId}/${windowId}`
    await this.serial.get(key)?.catch(() => {})
    this.remove(key)
  }
  dispose() {
    this.disposed = true
    for (const key of this.windows.keys()) this.remove(key)
  }
}
