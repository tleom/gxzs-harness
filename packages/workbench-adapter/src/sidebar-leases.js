import { httpError } from './http.js'

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

/** A window keeps existing native resources alive without one output stream per hidden tab. */
export class SidebarLeases {
  constructor({ browsers, terminals, service, ttlMs = 60000 }) {
    Object.assign(this, { browsers, terminals, service, ttlMs })
    this.windows = new Map()
    this.serial = new Map()
  }
  async update(owner, request) {
    if (!uuid.test(request.window_id) || !Array.isArray(request.resources) || request.resources.length > 128)
      throw httpError(400, '侧栏窗口参数无效')
    const resources = new Map()
    for (const item of request.resources) {
      if (!['browser', 'terminal'].includes(item.kind) || !uuid.test(item.id) || !uuid.test(item.chat_id))
        throw httpError(400, '侧栏资源参数无效')
      this.service.requireChat(owner, item.chat_id)
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
    let window = this.windows.get(key)
    if (!window) {
      if (this.windows.size >= 128) throw httpError(429, '侧栏窗口过多')
      window = { holds: new Map() }
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
          const hold = await this.retain(owner, resource)
          window.holds.set(id, hold)
        } catch (error) {
          if (![404, 410].includes(error.status) && !['terminal/not-found', 'terminal/unavailable'].includes(error.code)) throw error
        }
      }
      return { protocol: 1, held: [...window.holds.keys()], ttl_ms: this.ttlMs }
    } finally {
      window.timer = setTimeout(() => this.remove(key, window), this.ttlMs)
      window.timer.unref?.()
    }
  }
  async retain(owner, resource) {
    const chat = this.service.requireChat(owner, resource.chat_id)
    if (resource.kind === 'browser') {
      const browser = this.browsers.require(owner, resource.id)
      if (browser.chatId !== resource.chat_id) throw httpError(403, '浏览器不属于当前对话')
      return { release: browser.retainWindow(), live: () => !browser.closed }
    }
    const native = this.terminals.native
    if (!native.list(chat.sessionId).some(item => item.id === resource.id)) throw httpError(404, '终端已经关闭')
    this.terminals.knownSessions.add(chat.sessionId)
    const lifetime = new AbortController()
    const held = native.retain(chat.sessionId, resource.id, lifetime.signal)[Symbol.asyncIterator]()
    let first
    try { first = await held.next() }
    catch (error) { lifetime.abort(); throw error }
    if (first.done || first.value.type !== 'retained') { lifetime.abort(); await held.return?.(); throw httpError(404, '终端已经关闭') }
    // Resume the native lifetime iterator so terminal close/expiry can settle it.
    void held.next().catch(() => {}).finally(() => { lifetime.abort(); void held.return?.() })
    return { release: () => lifetime.abort(), live: () => !lifetime.signal.aborted }
  }
  remove(key, expected = this.windows.get(key)) {
    if (!expected || this.windows.get(key) !== expected) return
    this.windows.delete(key)
    clearTimeout(expected.timer)
    for (const hold of expected.holds.values()) hold.release()
  }
  async release(owner, windowId) {
    if (!uuid.test(windowId)) throw httpError(400, '侧栏窗口标识无效')
    const key = `${owner.ownerId}/${windowId}`
    await this.serial.get(key)?.catch(() => {})
    this.remove(key)
  }
  dispose() { for (const key of this.windows.keys()) this.remove(key) }
}
