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
      if (!['left', 'middle', 'right'].includes(request.button || 'left') || !integer(request.count || 1, 1, 2)) break
      return { action, x: request.x, y: request.y, button: request.button || 'left', count: request.count || 1 }
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
    this.closed = false
    this.watchEnabled = false
    this.watchBusy = false
    this.idleMs = idleMs
    this.lifetime = new AbortController()
    this.handle = subprocess.spawn({ argv: ['/usr/local/bin/node', worker], cwd: '/workspace',
      signal: this.lifetime.signal, graceMs: 1500,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } } })
    this.done = this.handle.done.then(
      () => this.dispose(httpError(410, '浏览器已经关闭，请重新打开')),
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
      if (line.length > 2 * 1024 * 1024) { this.dispose(); return }
      try {
        const frame = JSON.parse(line)
        if (frame.type === 'fatal' && typeof frame.error === 'string' && frame.error.length <= 256) {
          this.dispose(httpError(502, frame.error))
          return
        } else if (frame.type === 'result') {
          const pending = this.pending.get(frame.id)
          if (frame.error) pending?.reject(httpError(502, frame.error))
          else pending?.resolve()
        } else if (frame.type === 'frame' && typeof frame.image === 'string' && frame.image.length <= 1400000
          && integer(frame.width, 320, 1920) && integer(frame.height, 240, 1080)) {
          this.frame = frame
          this.publish()
        } else throw new Error('Invalid frame')
      } catch { this.dispose(httpError(502, '沙盒浏览器数据无效')); return }
    }
    if (this.buffer.length > 2 * 1024 * 1024) this.dispose()
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
      this.pending.set(id, { resolve: () => finish(resolve), reject: error => finish(reject, error) })
      signal.addEventListener('abort', cancel, { once: true })
      timer = setTimeout(cancel, 35000)
      try { this.handle.stdin.write(JSON.stringify({ ...value, id }) + '\n') }
      catch { this.dispose(httpError(502, '沙盒浏览器连接中断')) }
    })
  }
  publish() {
    for (const listener of this.listeners) listener()
  }
  syncWatch() {
    if (this.closed || this.watchBusy || this.pending.size >= 32) return
    const enabled = this.listeners.size > 0
    if (enabled === this.watchEnabled) return
    this.watchBusy = true
    this.command({ action: 'watch', enabled }).then(
      () => { this.watchEnabled = enabled },
      error => this.dispose(error),
    ).finally(() => { this.watchBusy = false; this.syncWatch() })
  }
  async *follow(attachment, signal) {
    if (this.closed) throw this.failure
    signal.throwIfAborted()
    const lease = Symbol('browser stream')
    this.controllerLease = lease
    this.controller = attachment
    let wake, changed = true
    const update = () => { changed = true; wake?.(); wake = undefined }
    this.listeners.add(update)
    signal.addEventListener('abort', update, { once: true })
    clearTimeout(this.idleTimer)
    this.publish()
    this.syncWatch()
    try {
      while (!signal.aborted && !this.closed) {
        if (!changed) await new Promise(resolve => { wake = resolve })
        if (signal.aborted || this.closed) break
        changed = false
        if (this.frame) yield { event: 'workbench_browser', value: { ...this.frame, writable: this.controllerLease === lease } }
      }
      if (this.closed && !signal.aborted) throw this.failure
    } finally {
      signal.removeEventListener('abort', update)
      this.listeners.delete(update)
      if (this.controllerLease === lease) {
        this.controllerLease = undefined
        this.controller = undefined
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

export class WorkbenchBrowsers {
  constructor({ subprocess, create = () => new SandboxBrowser(subprocess) }) { this.items = new Map(); this.workers = new Set(); this.createBrowser = create }
  async create(owner, request, signal) {
    signal.throwIfAborted()
    if (!uuid.test(request.id)) throw httpError(400, '浏览器标识无效')
    const key = `${owner.ownerId}/${request.id}`
    let browser = this.items.get(key)
    if (browser?.closed) { this.items.delete(key); browser = undefined }
    if (!browser) {
      for (const [id, item] of this.items) if (item.closed) this.items.delete(id)
      if (this.workers.size >= 4) throw httpError(429, '浏览器数量已达上限，请关闭其他标签或稍后重试')
      browser = this.createBrowser()
      this.workers.add(browser)
      const worker = browser
      const settled = () => this.workers.delete(worker)
      Promise.resolve(worker.done).then(settled, settled)
      this.items.set(key, browser)
      browser.ready = browser.command({ action: 'init', width: 1000, height: 700 }, signal)
    }
    try { await browser.ready }
    catch (error) { browser.dispose(); if (this.items.get(key) === browser) this.items.delete(key); throw error }
    return { id: request.id }
  }
  require(owner, id) {
    const browser = this.items.get(`${owner.ownerId}/${id}`)
    if (!browser || browser.closed) throw httpError(404, '浏览器已经关闭，请重新打开')
    return browser
  }
  follow(owner, id, attachment, signal) {
    if (!uuid.test(attachment)) throw httpError(400, '浏览器连接标识无效')
    return this.require(owner, id).follow(attachment, signal)
  }
  async control(owner, id, request, signal) {
    const browser = this.require(owner, id)
    if (!uuid.test(request.attachment_id) || browser.controller !== request.attachment_id) throw httpError(409, '另一页面正在控制此浏览器，请接管后重试')
    await browser.command(browserAction(request), signal)
  }
  async close(owner, id) {
    const key = `${owner.ownerId}/${id}`, browser = this.items.get(key)
    if (!browser) return
    browser.dispose()
    await browser.done
    if (this.items.get(key) === browser) this.items.delete(key)
  }
  dispose() { for (const browser of this.items.values()) browser.dispose(); this.items.clear() }
}
