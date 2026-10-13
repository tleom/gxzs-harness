import { httpError } from './http.js'

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const keys = /^(?:(?:Control|Alt|Shift|Meta)\+){0,3}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Space)$/
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
export function browserAction(request) {
  const { action } = request
  switch (action) {
    case 'navigate': {
      let url
      try { url = new URL(request.url) } catch { throw httpError(400, '网页地址无效') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096)
        throw httpError(400, '请输入有效的 HTTP 或 HTTPS 地址')
      return { action, url: url.href }
    }
    case 'back': case 'forward': case 'reload': return { action }
    case 'resize':
      if (integer(request.width, 320, 1920) && integer(request.height, 240, 1080)) return { action, width: request.width, height: request.height }
      break
    case 'click': case 'move':
      if (!integer(request.x, 0, 1919) || !integer(request.y, 0, 1079)) break
      if (action === 'move') return { action, x: request.x, y: request.y }
      if (!['left', 'middle', 'right'].includes(request.button === undefined ? 'left' : request.button) || !integer(request.count === undefined ? 1 : request.count, 1, 2)) break
      return { action, x: request.x, y: request.y, button: request.button === undefined ? 'left' : request.button, count: request.count === undefined ? 1 : request.count }
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
    this.buffer = ''
    this.sequence = 0
    this.pageFrames = new Map()
    this.closedPages = new Set()
    this.popupSequence = 0
    this.rejectedPages = new Set()
    this.closed = false
    this.watchEnabled = false
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
    if (this.closed || this.listeners.size || this.pending.size) return
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
      if (line.length > 8 * 1024 * 1024) { this.dispose(); return }
      try {
        const frame = JSON.parse(line)
        if (frame.type === 'fatal' && typeof frame.error === 'string' && frame.error.length <= 256) {
          this.dispose(httpError(502, frame.error))
          return
        } else if (frame.type === 'page-open' && uuid.test(frame.page_id) && uuid.test(frame.opener_id)) {
          if (this.onPageOpen?.(frame.page_id) === false) {
            this.rejectedPages.add(frame.page_id)
            void this.command({ action: 'close-page', page_id: frame.page_id }).catch(() => this.dispose())
            continue
          }
          this.openedPageId = frame.page_id
          this.popupSequence++
          this.publish()
        } else if (frame.type === 'page-close' && uuid.test(frame.page_id)) {
          this.closedPages.add(frame.page_id)
          this.onPageClose?.(frame.page_id)
          this.publish()
        } else if (frame.type === 'result') {
          const pending = this.pending.get(frame.id)
          if (frame.value?.page_limit || this.rejectedPages.has(frame.value?.page_id)) pending?.reject(httpError(429, '最多打开3个浏览器标签，请先关闭一个'))
          else if (frame.error) pending?.reject(httpError(502, frame.error))
          else pending?.resolve(frame.value)
        } else if (frame.type === 'frame' && typeof frame.image === 'string' && frame.image.length <= 6 * 1024 * 1024
          && integer(frame.width, 320, 1920) && integer(frame.height, 240, 1080)) {
          this.frame = frame
          if (uuid.test(frame.page_id)) this.pageFrames.set(frame.page_id, frame)
          this.publish()
        } else throw new Error('Invalid frame')
      } catch { this.dispose(httpError(502, '沙盒浏览器数据无效')); return }
    }
    if (this.buffer.length > 8 * 1024 * 1024) this.dispose()
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
        signal.removeEventListener('abort', cancel)
        this.pending.delete(id)
        this.armIdle()
        this.syncWatch()
        callback(result)
      }
      const cancel = () => {
        // Never leave a timed-out navigation queued ahead of later input.
        this.dispose(httpError(504, '浏览器操作超时，请重新打开'))
      }
      this.pending.set(id, { resolve: value => finish(resolve, value), reject: error => finish(reject, error) })
      signal.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(cancel, 35000)
      try { this.handle.stdin.write(JSON.stringify({ page_id: this.rootPageId, ...value, id }) + '\n') }
      catch { this.dispose(httpError(502, '沙盒浏览器连接中断')) }
    })
  }
  publish() {
    for (const listener of this.listeners) listener()
  }
  syncWatch() {
    if (this.closed || this.watchBusy || this.pending.size >= 32) return
    const enabled = this.listeners.size > 0
    const pageId = this.controllerPageId || this.rootPageId
    if (enabled === this.watchEnabled && (!enabled || this.watchPageId === pageId)) return
    this.watchBusy = true
    this.command({ action: 'watch', enabled, page_id: pageId }).then(
      () => { this.watchEnabled = enabled; this.watchPageId = pageId },
      error => this.dispose(error),
    ).finally(() => { this.watchBusy = false; this.syncWatch() })
  }
  async *follow(attachment, signal, pageId = this.rootPageId) {
    if (this.closed) throw this.failure
    signal.throwIfAborted()
    const lease = Symbol('browser stream')
    this.controllerLease = lease
    this.controller = attachment
    this.controllerPageId = pageId
    let popupCursor = this.popupSequence
    let wake, changed = true
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
        const frame = this.pageFrames.get(pageId) || this.frame
        if (frame) {
          yield { event: 'workbench_browser', value: { ...frame, writable: this.controllerLease === lease,
            ...(this.popupSequence > popupCursor ? { opened_page_id: this.openedPageId } : {}) } }
          popupCursor = this.popupSequence
        }
      }
      if (this.closed && !signal.aborted) throw this.failure
      if (this.closedPages.has(pageId) && !signal.aborted) throw httpError(410, '浏览器标签已经关闭')
    } finally {
      signal.removeEventListener('abort', update)
      this.listeners.delete(update)
      if (this.controllerLease === lease) {
        this.controllerLease = undefined
        this.controller = undefined
        this.controllerPageId = undefined
      }
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

/** A native popup remains in its opener's Chromium context, with a separate sidebar identity. */
class BrowserPage {
  constructor(worker, id, chatId) { this.worker = worker; this.id = id; this.chatId = chatId; this.ready = worker.ready }
  get closed() { return this.worker.closed || this.worker.closedPages.has(this.id) }
  get controller() { return this.worker.controllerPageId === this.id ? this.worker.controller : undefined }
  command(value, signal) { return this.worker.command({ ...value, page_id: this.id }, signal) }
  follow(attachment, signal) { return this.worker.follow(attachment, signal, this.id) }
}

export class WorkbenchBrowsers {
  constructor({ subprocess, service, create = () => new SandboxBrowser(subprocess) }) { this.items = new Map(); this.workers = new Set(); this.current = new Map(); this.slots = new Map(); this.createBrowser = create; this.service = service }
  count(ownerId, chatId) { return [...this.slots.values()].filter(slot => slot.ownerId === ownerId && slot.chatId === chatId).length }
  async create(owner, request, signal) {
    signal.throwIfAborted()
    if (!uuid.test(request.id)) throw httpError(400, '浏览器标识无效')
    if (request.chat_id !== undefined) {
      this.service?.requireChat(owner, request.chat_id)
    }
    const key = `${owner.ownerId}/${request.id}`
    let browser = this.items.get(key)
    if (browser && request.chat_id && browser.chatId !== request.chat_id) throw httpError(403, '浏览器不属于当前对话')
    if (browser?.closed) { this.items.delete(key); browser = undefined }
    if (!browser) {
      for (const [id, item] of this.items) if (item.closed) this.items.delete(id)
      if (this.count(owner.ownerId, request.chat_id) >= 1) throw httpError(409, '当前对话已有浏览器，请打开已有标签')
      browser = this.createBrowser()
      browser.rootPageId = request.id
      browser.id = request.id
      browser.chatId = request.chat_id
      this.slots.set(key, { ownerId: owner.ownerId, chatId: request.chat_id, worker: browser })
      browser.onPageOpen = id => {
        if (this.count(owner.ownerId, request.chat_id) >= 1) return false
        this.slots.set(`${owner.ownerId}/${id}`, { ownerId: owner.ownerId, chatId: request.chat_id, worker: browser })
        this.items.set(`${owner.ownerId}/${id}`, new BrowserPage(browser, id, request.chat_id))
        this.current.set(`${owner.ownerId}/${request.chat_id}`, id)
      }
      browser.onPageClose = id => { this.items.delete(`${owner.ownerId}/${id}`); this.slots.delete(`${owner.ownerId}/${id}`) }
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
      browser.ready = browser.command({ action: 'init', browser_id: request.id, width: 1000, height: 700 }, signal)
    }
    try { await browser.ready }
    catch (error) { (browser.worker || browser).dispose(); if (this.items.get(key) === browser) this.items.delete(key); throw error }
    this.current.set(`${owner.ownerId}/${request.chat_id}`, request.id)
    return { id: request.id }
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
  follow(owner, id, attachment, signal) {
    if (!uuid.test(attachment)) throw httpError(400, '浏览器连接标识无效')
    const browser = this.require(owner, id)
    this.current.set(`${owner.ownerId}/${browser.chatId}`, id)
    return browser.follow(attachment, signal)
  }
  async control(owner, id, request, signal) {
    const browser = this.require(owner, id)
    if (!uuid.test(request.attachment_id) || browser.controller !== request.attachment_id
      || (browser.rootPageId && browser.controllerPageId && browser.controllerPageId !== id)) throw httpError(409, '另一页面正在控制此浏览器，请重新连接后重试')
    this.current.set(`${owner.ownerId}/${browser.chatId}`, id)
    await browser.command(browserAction(request), signal)
  }
  async close(owner, id) {
    const key = `${owner.ownerId}/${id}`, browser = this.items.get(key)
    if (!browser) return
    const worker = browser.worker || browser
    const siblings = [...this.items.values()].filter(item => (item.worker || item) === worker && !item.closed)
    if (siblings.length > 1) {
      await browser.command({ action: 'close-page' })
      worker.closedPages.add(id)
      worker.publish()
    } else { worker.dispose(); await worker.done }
    if (this.items.get(key) === browser) this.items.delete(key)
    this.slots.delete(key)
  }
  dispose() { for (const worker of this.workers) worker.dispose(); this.items.clear(); this.current.clear() }
}
