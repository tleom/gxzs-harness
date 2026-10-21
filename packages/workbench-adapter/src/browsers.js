import { httpError } from './http.js'
import { randomUUID } from 'node:crypto'

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const keys = /^(?:(?:Control|Alt|Shift|Meta)\+){0,3}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Space|F(?:[1-9]|1[0-2]))$/
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
export function browserAction(request) {
  const { action } = request
  const modifiers = request.modifiers
  if (modifiers !== undefined && (!Array.isArray(modifiers) || modifiers.length > 4 || modifiers.some(value => !['Control','Alt','Shift','Meta'].includes(value))))
    throw httpError(400, '浏览器按键参数无效')
  switch (action) {
    case 'navigate': {
      let url
      try { url = new URL(request.url) } catch { throw httpError(400, '网页地址无效') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096)
        throw httpError(400, '请输入有效的 HTTP 或 HTTPS 地址')
      return { action, url: url.href }
    }
    case 'back': case 'forward': case 'reload': case 'release-input': case 'selection': return { action }
    case 'modifiers': return { action, modifiers: modifiers || [] }
    case 'cut-selection':
      if (typeof request.text === 'string' && request.text.length <= 32768 && integer(request.expected_revision, 0, Number.MAX_SAFE_INTEGER))
        return { action, text: request.text, expected_revision: request.expected_revision }
      break
    case 'ack':
      if (integer(request.frame_id, 1, Number.MAX_SAFE_INTEGER)) return { action, frame_id: request.frame_id }
      break
    case 'resize':
      if (integer(request.width, 320, 1920) && integer(request.height, 240, 1080)) return { action, width: request.width, height: request.height }
      break
    case 'click': case 'move': case 'pointer-down': case 'pointer-up':
      if (!integer(request.x, 0, 1919) || !integer(request.y, 0, 1079)) break
      if (action === 'move') return { action, x: request.x, y: request.y, ...(modifiers ? { modifiers } : {}) }
      if (!['left', 'middle', 'right'].includes(request.button === undefined ? 'left' : request.button) || !integer(request.count === undefined ? 1 : request.count, 1, 2)) break
      return { action, x: request.x, y: request.y, button: request.button === undefined ? 'left' : request.button, count: request.count === undefined ? 1 : request.count, ...(modifiers ? { modifiers } : {}) }
    case 'wheel':
      if (integer(request.x, -3000, 3000) && integer(request.y, -3000, 3000)) return { action, x: request.x, y: request.y }
      break
    case 'text':
      if (typeof request.text === 'string' && request.text.length <= 32 * 1024) return { action, text: request.text }
      break
    case 'key':
      if (typeof request.key === 'string' && keys.test(request.key)) return { action, key: request.key }
      break
  }
  throw httpError(400, '浏览器操作参数无效')
}

/** One ephemeral Chromium process/context in this owner's SSH sandbox. */
export class SandboxBrowser {
  constructor(subprocess, { idleMs = 300000, worker = '/opt/workbench/packages/workbench-adapter/src/browser-worker.cjs' } = {}) {
    this.pending = new Map()
    this.listeners = new Set()
    this.viewers = new Map()
    this.windowHolds = new Set()
    this.buffer = ''
    this.sequence = 0
    this.pageFrames = new Map()
    this.closedPages = new Set()
    this.closed = false
    this.displayQueue = []
    this.displayBytes = 0
    this.viewerRevision = 0
    this.watchEnabled = false
    this.watchLegacyPixels = false
    this.watchBusy = false
    this.idleMs = idleMs
    this.lifetime = new AbortController()
    this.handle = subprocess.spawn({ argv: ['/usr/local/bin/node', worker], cwd: '/workspace',
      signal: this.lifetime.signal, graceMs: 1500,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } } })
    this.done = this.handle.done.then(
      outcome => this.dispose(outcome.exitCode === 0 && !outcome.signal
        ? httpError(410, '浏览器已经关闭，请重新打开') : httpError(502, '沙盒浏览器连接中断')),
      () => this.dispose(httpError(502, '沙盒浏览器连接中断')),
    )
    if (!this.handle.stdin || !this.handle.stdout) { this.dispose(); throw httpError(502, '沙盒浏览器连接不可用') }
    this.handle.stdout.setEncoding('utf8')
    this.handle.stdout.on('data', chunk => this.receive(chunk))
    this.handle.stdout.on('error', () => this.dispose(httpError(502, '沙盒浏览器连接中断')))
    this.handle.stdin.on('error', () => this.dispose(httpError(502, '沙盒浏览器连接中断')))
    this.armIdle()
  }
  armIdle() {
    clearTimeout(this.idleTimer)
    if (this.closed || this.listeners.size || this.pending.size || this.windowHolds.size) return
    this.idleTimer = setTimeout(() => this.dispose(), this.idleMs)
    this.idleTimer.unref?.()
  }
  receive(chunk) {
    if (this.closed) return
    this.buffer += chunk
    let boundary
    while ((boundary = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 1)
      if (line.length > 12 * 1024 * 1024) { this.dispose(); return }
      try {
        const frame = JSON.parse(line)
        if (frame.type === 'fatal' && typeof frame.error === 'string' && frame.error.length <= 256) {
          this.dispose(httpError(502, frame.error))
          return
        } else if (frame.type === 'page-close' && uuid.test(frame.page_id)) {
          this.closedPages.add(frame.page_id)
          this.publish()
        } else if (frame.type === 'result') {
          const pending = this.pending.get(frame.id)
          if (frame.error) pending?.reject(httpError(502, frame.error))
          else pending?.resolve(frame.value)
        } else if (frame.type === 'display' && frame.connection === this.displayConnection?.id
          && ['open', 'data', 'close'].includes(frame.event) && (frame.event !== 'data' || typeof frame.data === 'string' && frame.data.length <= 87384)) {
          this.displayBytes += frame.data?.length || 0
          if (this.displayBytes > 12 * 1024 * 1024) {
            this.displayQueue = [{ type: 'display', connection: frame.connection, event: 'close' }]
            this.displayBytes = 0
            void this.command({ action: 'display-close', connection: frame.connection }).catch(() => {})
          } else this.displayQueue.push(frame)
          this.publish()
        } else if (frame.type === 'display') {
          // Messages from a replaced attachment belong to its old RFB handshake.
        } else if (frame.type === 'frame' && (frame.display === 'kasm' || typeof frame.image === 'string' && frame.image.length <= Math.ceil(8 * 1024 * 1024 / 3) * 4)
          && integer(frame.width, 320, 1920) && integer(frame.height, 240, 1080)) {
          if (frame.legacy) this.legacyFrame = frame
          else {
            this.frame = frame
            if (uuid.test(frame.page_id)) this.pageFrames.set(frame.page_id, frame)
          }
          this.publish()
        } else throw new Error('Invalid frame')
      } catch { this.dispose(httpError(502, '沙盒浏览器数据无效')); return }
    }
    if (this.buffer.length > 12 * 1024 * 1024) this.dispose()
  }
  retainWindow() {
    if (this.closed) throw this.failure
    const token = Symbol('sidebar window')
    this.windowHolds.add(token)
    clearTimeout(this.idleTimer)
    return () => { this.windowHolds.delete(token); this.armIdle() }
  }
  command(value, signal = new AbortController().signal) {
    signal.throwIfAborted()
    if (this.closed) return Promise.reject(httpError(410, '浏览器已经关闭，请重新打开'))
    if (this.pending.size >= 32) return Promise.reject(httpError(429, '浏览器操作过多，请稍后重试'))
    clearTimeout(this.idleTimer)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      let timer
      const finish = (callback, result) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.pending.delete(id)
        this.armIdle()
        this.syncWatch()
        callback(result)
      }
      const cancel = (error = signal.reason) => {
        if (!this.pending.has(id)) return
        // A request/view owns its operation, never the Chromium process.
        try { this.handle.stdin.write(JSON.stringify({ action: 'cancel', cancel_id: id }) + '\n') }
        catch { this.dispose(httpError(502, '沙盒浏览器连接中断')); return }
        this.pending.get(id)?.reject(error instanceof Error ? error : httpError(499, '浏览器操作已取消'))
      }
      this.pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) })
      const abort = () => cancel(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => cancel(httpError(504, '浏览器操作超时')), 35000)
      try { this.handle.stdin.write(JSON.stringify({ page_id: this.rootPageId, ...value, id }) + '\n') }
      catch { this.dispose(httpError(502, '沙盒浏览器连接中断')) }
    })
  }
  publish() {
    for (const listener of this.listeners) listener()
  }
  updateController() {
    this.viewerRevision++
    const previous = this.controllerLease
    const selected = [...this.viewers].reverse().find(([, viewer]) => viewer.visible)
    this.controllerLease = selected?.[0]
    this.controller = selected?.[1].attachment
    this.controllerPageId = selected?.[1].pageId
    if (previous && previous !== this.controllerLease && !this.closed) {
      try { this.handle.stdin.write(JSON.stringify({ action: 'release-input' }) + '\n') } catch {}
    }
    if (this.display === 'kasm' && previous !== this.controllerLease && !this.closed) {
      this.displayQueue = []
      this.displayBytes = 0
      if (this.controllerLease && selected?.[1].display) {
        const connection = { id: randomUUID(), lease: this.controllerLease }
        this.displayConnection = connection
        void this.command({ action: 'display-open', connection: connection.id }).catch(() => {
          if (this.displayConnection === connection) {
            this.displayQueue.push({ type: 'display', connection: connection.id, event: 'close' }); this.publish()
          }
        })
      } else {
        const connection = this.displayConnection
        this.displayConnection = undefined
        void this.command({ action: 'display-close', connection: connection?.id }).catch(() => {})
      }
    }
  }
  setVisibility(attachment, visible) {
    const selected = [...this.viewers].reverse().find(([, viewer]) => viewer.attachment === attachment)
    if (!selected) throw httpError(409, '浏览器窗口连接已更新，请重新连接')
    selected[1].visible = visible
    this.updateController()
    this.publish()
    this.syncWatch()
  }
  syncWatch() {
    if (this.closed || this.watchBusy || this.pending.size >= 32) return
    const enabled = [...this.viewers.values()].some(viewer => viewer.visible)
    const legacyPixels = this.display === 'kasm' && [...this.viewers.values()].some(viewer => viewer.visible && !viewer.display)
    const pageId = this.controllerPageId || this.rootPageId
    if (enabled === this.watchEnabled && legacyPixels === this.watchLegacyPixels && (!enabled || this.watchPageId === pageId)) return
    this.watchBusy = true
    this.command({ action: 'watch', enabled, page_id: pageId, ...(legacyPixels ? { legacy_pixels: true } : {}) }).then(
      () => { this.watchEnabled = enabled; this.watchPageId = pageId; this.watchLegacyPixels = legacyPixels },
      error => this.dispose(error),
    ).finally(() => { this.watchBusy = false; this.syncWatch() })
  }
  async *follow(attachment, signal, pageId = this.rootPageId, visible = true, display = false) {
    if (this.closed) throw this.failure
    signal.throwIfAborted()
    const lease = Symbol('browser stream')
    this.viewers.set(lease, { attachment, pageId, visible, display })
    this.updateController()
    let wake, changed = true, deliveredFrame, deliveredViewerRevision
    const update = () => { changed = true; wake?.(); wake = undefined }
    this.listeners.add(update)
    signal.addEventListener('abort', update, { once: true })
    clearTimeout(this.idleTimer)
    this.publish()
    this.syncWatch()
    try {
      while (!signal.aborted && !this.closed && !this.closedPages.has(pageId)) {
        if (!changed) await new Promise(resolve => { wake = resolve })
        if (signal.aborted || this.closed) break
        changed = false
        const frame = this.display === 'kasm' && !display ? this.legacyFrame : this.pageFrames.get(pageId) || this.frame
        if (frame && (frame !== deliveredFrame || deliveredViewerRevision !== this.viewerRevision)) {
          deliveredFrame = frame
          deliveredViewerRevision = this.viewerRevision
          yield { event: 'workbench_browser', value: { ...frame, input_protocol: this.inputProtocol, writable: this.controllerLease === lease } }
        }
        while (display && this.displayConnection?.lease === lease && this.displayQueue.length && !signal.aborted) {
          const packet = this.displayQueue.shift()
          this.displayBytes -= packet.data?.length || 0
          yield { event: 'workbench_browser_display', value: packet }
        }
      }
      if (this.closed && !signal.aborted) throw this.failure
      if (this.closedPages.has(pageId) && !signal.aborted) throw httpError(410, '浏览器标签已经关闭')
    } finally {
      signal.removeEventListener('abort', update)
      this.listeners.delete(update)
      this.viewers.delete(lease)
      this.updateController()
      this.publish()
      this.syncWatch()
      this.armIdle()
    }
  }
  dispose(error = httpError(410, '浏览器已经关闭，请重新打开')) {
    if (this.closed) return
    this.closed = true
    this.failure = error
    clearTimeout(this.idleTimer)
    for (const pending of [...this.pending.values()]) pending.reject(error)
    this.buffer = ''
    this.publish()
    this.lifetime.abort(error)
  }
}

export class WorkbenchBrowsers {
  constructor({ subprocess, service, create = () => new SandboxBrowser(subprocess) }) { this.items = new Map(); this.workers = new Set(); this.current = new Map(); this.slots = new Map(); this.allocating = new Map(); this.createBrowser = create; this.service = service }
  count(ownerId, chatId) { return [...this.slots.values()].filter(slot => slot.ownerId === ownerId && slot.chatId === chatId).length }
  activity() { return [...this.workers].filter(worker => !worker.closed && (worker.listeners?.size || worker.pending?.size || worker.windowHolds?.size)).length }
  async create(owner, request, signal) {
    signal.throwIfAborted()
    if (this.disposed) throw httpError(410, '浏览器服务已经关闭')
    if (!uuid.test(request.id)) throw httpError(400, '浏览器标识无效')
    if (request.chat_id !== undefined) {
      this.service?.requireChat(owner, request.chat_id)
    }
    const key = `${owner.ownerId}/${request.id}`
    let browser = this.items.get(key)
    if (browser && request.chat_id && browser.chatId !== request.chat_id) throw httpError(403, '浏览器不属于当前对话')
    if (browser?.closed) browser = undefined
    if (!browser) {
      if (request.existing === true) throw httpError(404, '浏览器已经关闭')
      browser = await this.allocate(owner, request, signal)
    }
    let abort
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason || new Error('Browser request cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      await Promise.race([browser.ready, cancelled]); signal.throwIfAborted()
      if (browser.closed) throw browser.failure || httpError(410, '浏览器已经关闭')
    }
    finally { signal.removeEventListener('abort', abort) }
    this.current.set(`${owner.ownerId}/${request.chat_id}`, request.id)
    return { id: request.id }
  }
  allocate(owner, request, signal) {
    const previous = this.allocating.get(owner.ownerId)
    const pending = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      signal.throwIfAborted()
      if (this.disposed) throw httpError(410, '浏览器服务已经关闭')
      const key = `${owner.ownerId}/${request.id}`
      const existing = this.items.get(key)
      if (existing && !existing.closed) {
        if (request.chat_id && existing.chatId !== request.chat_id) throw httpError(403, '浏览器不属于当前对话')
        return existing
      }
      // Keep closing workers counted until their actual subprocess exit; never
      // overlap two Chromium instances or touch another owner's resources.
      for (const [key, slot] of this.slots) if (slot.ownerId === owner.ownerId)
        await this.close(owner, key.slice(owner.ownerId.length + 1))
      signal.throwIfAborted()
      if (this.disposed) throw httpError(410, '浏览器服务已经关闭')
      const browser = this.createBrowser()
      browser.rootPageId = request.id
      browser.id = request.id
      browser.chatId = request.chat_id
      this.slots.set(key, { ownerId: owner.ownerId, chatId: request.chat_id, worker: browser })
      this.workers.add(browser)
      const worker = browser
      const settled = () => {
        this.workers.delete(worker)
        if (worker.closed) {
          for (const [key, slot] of this.slots) if (slot.worker === worker) { this.slots.delete(key); this.items.delete(key) }
          worker.pageFrames?.clear()
        }
      }
      Promise.resolve(worker.done).then(settled, settled)
      this.items.set(key, browser)
      this.current.set(`${owner.ownerId}/${request.chat_id}`, request.id)
      browser.ready = browser.command({ action: 'init', browser_id: request.id, width: 1000, height: 700 },
        browser.lifetime?.signal || new AbortController().signal).then(value => { browser.display = value?.display; browser.inputProtocol = value?.input_protocol }).catch(error => {
        worker.dispose(error)
        if (this.items.get(key) === worker) this.items.delete(key)
        throw error
      })
      browser.ready.catch(() => {})
      return browser
    })
    this.allocating.set(owner.ownerId, pending)
    return pending.finally(() => {
      if (this.allocating.get(owner.ownerId) === pending) this.allocating.delete(owner.ownerId)
    })
  }
  currentId(owner, chatId) {
    const id = this.current.get(`${owner.ownerId}/${chatId}`)
    const item = id && this.items.get(`${owner.ownerId}/${id}`)
    return item && !item.closed && item.chatId === chatId ? id : undefined
  }
  require(owner, id) {
    const browser = this.items.get(`${owner.ownerId}/${id}`)
    if (!browser || browser.closed) throw httpError(404, '浏览器已经关闭，请重新打开')
    return browser
  }
  follow(owner, id, attachment, signal, visible = true, display = false) {
    if (!uuid.test(attachment)) throw httpError(400, '浏览器连接标识无效')
    const browser = this.require(owner, id)
    this.current.set(`${owner.ownerId}/${browser.chatId}`, id)
    return browser.follow(attachment, signal, browser.rootPageId, visible, display)
  }
  async control(owner, id, request, signal) {
    const browser = this.require(owner, id)
    if (request.action === 'visibility') {
      if (!uuid.test(request.attachment_id) || typeof request.visible !== 'boolean') throw httpError(400, '浏览器窗口状态无效')
      signal.throwIfAborted()
      browser.setVisibility(request.attachment_id, request.visible)
      return
    }
    if (!uuid.test(request.attachment_id) || browser.controller !== request.attachment_id
      || (browser.rootPageId && browser.controllerPageId && browser.controllerPageId !== id)) throw httpError(409, '另一页面正在控制此浏览器，请重新连接后重试')
    this.current.set(`${owner.ownerId}/${browser.chatId}`, id)
    return browser.command(browserAction(request), signal)
  }
  async displayInput(owner, id, request, signal) {
    const browser = this.require(owner, id)
    if (!uuid.test(request.attachment_id) || browser.controller !== request.attachment_id
      || !uuid.test(request.connection) || browser.displayConnection?.id !== request.connection)
      throw httpError(409, '浏览器窗口连接已更新，请重新连接')
    if (typeof request.data !== 'string' || !request.data.length || request.data.length > 87384
      || request.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.data)
      || Buffer.from(request.data, 'base64').toString('base64') !== request.data)
      throw httpError(400, '浏览器输入数据无效')
    return browser.command({ action: 'display-write', connection: request.connection, data: request.data }, signal)
  }
  async close(owner, id) {
    const key = `${owner.ownerId}/${id}`, browser = this.items.get(key) || this.slots.get(key)?.worker
    if (!browser) return
    browser.dispose(); await browser.done
    if (this.items.get(key) === browser) this.items.delete(key)
    if (this.slots.get(key)?.worker === browser) this.slots.delete(key)
    const currentKey = `${owner.ownerId}/${browser.chatId}`
    if (this.current.get(currentKey) === id && !this.items.has(key)) this.current.delete(currentKey)
  }
  dispose() { this.disposed = true; for (const worker of this.workers) worker.dispose(); this.items.clear(); this.current.clear() }
}
