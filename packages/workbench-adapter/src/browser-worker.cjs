// Runs only in the owner sandbox. The Host transports pixels and validated input.
const { createInterface } = require('node:readline')
/** Reduce large photographic frames without losing the live stream; reuse the successful quality. */
function createImageCapture({ now = Date.now, budgetMs = 5000 } = {}) {
  const qualities = [70, 50, 30, 15]
  let key, start = 0
  return async page => {
    const viewport = page.viewportSize()
    const current = `${page.url()}|${viewport.width}:${viewport.height}`
    if (current !== key) { key = current; start = 0 }
    const deadline = now() + budgetMs
    for (let index = start; index < qualities.length; index++) {
      const remaining = deadline - now()
      if (remaining <= 0) throw new Error('capture_timeout')
      const image = await page.screenshot({ type: 'jpeg', quality: qualities[index], timeout: remaining })
      if (image.length <= 1024 * 1024) { start = index; return image }
    }
    throw new Error('frame_too_large')
  }
}
function runWorker({ chromium, input = process.stdin, output = process.stdout, exit = code => process.exit(code) }) {
  let browser, context, page, session, watching = false, capturing = false, closed = false
  let timer, notice = '', navigation = 0, hasFrame = false
  const send = value => new Promise(resolve => {
    if (output.write(JSON.stringify(value) + '\n')) resolve()
    else output.once('drain', resolve)
  })
  const capture = createImageCapture()
  const validUrl = value => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 4096) throw new Error('invalid_url')
    return url.href
  }
  async function frame() {
    if (!page || page.isClosed() || capturing || closed) return
    capturing = true
    try {
      const target = page, cdp = session
      const url = target.url()
      if (url !== 'about:blank') validUrl(url)
      const epoch = navigation
      const viewport = target.viewportSize()
      const image = await capture(target)
      const history = await cdp.send('Page.getNavigationHistory')
      const title = (await target.title()).slice(0, 1024)
      if (target !== page || target.url() !== url || navigation !== epoch || closed) return
      await send({ type: 'frame', url: url === 'about:blank' ? '' : url, title,
        ...viewport, image: image.toString('base64'), back: history.currentIndex > 0,
        forward: history.currentIndex < history.entries.length - 1, notice })
      hasFrame = true
    } catch (error) {
      if (error.message === 'frame_too_large') fatal('网页图像过大，请重新打开浏览器')
      else if (error.message === 'capture_timeout' || error.name === 'TimeoutError') fatal('网页图像获取超时，请重新打开浏览器')
      else if (error.message === 'invalid_url') fatal('浏览器仅支持 HTTP 和 HTTPS 页面')
      // Navigation can temporarily invalidate a screenshot; the next frame retries.
    }
    finally { capturing = false }
  }
  async function bind(target) {
    const cdp = await context.newCDPSession(target)
    target.on('crash', () => { if (target === page) fatal('网页进程已退出，请重新打开浏览器') })
    target.on('close', () => { if (target === page) fatal('网页已经关闭，请重新打开浏览器') })
    target.setDefaultTimeout(5000)
    target.setDefaultNavigationTimeout(20000)
    target.on('dialog', dialog => { notice = '网页弹窗已关闭'; void dialog.dismiss().catch(() => {}) })
    target.on('download', download => { notice = '请在系统浏览器中下载文件'; void download.cancel().catch(() => {}) })
    target.on('framenavigated', main => {
      if (main !== target.mainFrame() || target !== page) return
      navigation++
      if (main.url() === 'about:blank') return
      try {
        validUrl(main.url())
      } catch { notice = '浏览器仅支持 HTTP 和 HTTPS 页面'; void target.close().catch(() => {}) }
    })
    target.on('popup', async popup => {
      // Keep the single tab's owner context; do not create an unowned external guest.
      const previous = page
      let popupSession
      try {
        try {
          if (popup.url() !== 'about:blank') validUrl(popup.url())
        } catch {
          notice = '浏览器仅支持 HTTP 和 HTTPS 页面'
          await popup.close().catch(() => {})
          return
        }
        popupSession = await bind(popup)
        // The initial blank popup can navigate while its CDP binding is awaited.
        try { if (popup.url() !== 'about:blank') validUrl(popup.url()) }
        catch {
          notice = '浏览器仅支持 HTTP 和 HTTPS 页面'
          await popupSession.detach().catch(() => {})
          await popup.close().catch(() => {})
          return
        }
        if (closed || page !== previous || popup.isClosed()) {
          await popupSession.detach().catch(() => {})
          await popup.close().catch(() => {})
          return
        }
        page = popup
        session = popupSession
        await previous.close().catch(() => {})
        await frame()
      } catch {
        if (page === previous) {
          await popupSession?.detach().catch(() => {})
          await popup.close().catch(() => {})
          notice = '弹窗连接中断，请重新打开网页'
        } else fatal('网页连接中断，请重新打开浏览器')
      }
    })
    return cdp
  }
  async function operation(value) {
    const action = value.action
    if (action === 'init') {
      browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 20000 })
      browser.on('disconnected', () => fatal('沙盒浏览器已退出，请重新打开浏览器'))
      context = await browser.newContext({ viewport: { width: value.width, height: value.height },
        locale: 'zh-CN', acceptDownloads: false, serviceWorkers: 'block' })
      await context.route('**/*', route => {
        const request = route.request()
        if (request.isNavigationRequest() && !/^https?:\/\//i.test(request.url())) return route.abort()
        return route.continue()
      })
      page = await context.newPage()
      session = await bind(page)
      timer = setInterval(() => { if (watching) void frame() }, 400)
      await frame()
      if (!hasFrame) throw new Error('initial_frame_unavailable')
      return
    }
    if (!page || page.isClosed()) throw new Error('browser_closed')
    if (action === 'watch') { watching = value.enabled === true; if (watching) await frame(); return }
    notice = ''
    switch (action) {
      case 'navigate': await page.goto(validUrl(value.url), { waitUntil: 'domcontentloaded' }); break
      case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); break
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break
      case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); break
      case 'resize': await page.setViewportSize({ width: value.width, height: value.height }); break
      case 'click': await page.mouse.click(value.x, value.y, { button: value.button || 'left', clickCount: value.count || 1 }); break
      case 'move': await page.mouse.move(value.x, value.y); break
      case 'wheel': await page.mouse.wheel(value.x, value.y); break
      case 'text': await page.keyboard.insertText(value.text); break
      case 'key': await page.keyboard.press(value.key); break
      default: throw new Error('invalid_action')
    }
    if (!watching || !['move', 'wheel', 'text', 'key'].includes(action)) await frame()
  }
  function fatal(error) {
    if (closed) return
    const stop = shutdown()
    const forced = setTimeout(() => exit(2), 1500)
    Promise.all([send({ type: 'fatal', error }), stop]).finally(() => { clearTimeout(forced); exit(2) }).catch(() => {})
  }
  async function shutdown() {
    if (closed) return
    closed = true
    clearInterval(timer)
    await browser?.close().catch(() => {})
  }
  let queue = Promise.resolve()
  const lines = createInterface({ input })
  lines.on('line', line => {
    if (line.length > 256 * 1024) { void shutdown().finally(() => exit(2)); return }
    queue = queue.then(async () => {
      let value
      try {
        value = JSON.parse(line)
        await operation(value)
        if (!closed) await send({ type: 'result', id: value.id })
      } catch {
        if (closed) return
        const error = ['navigate', 'reload', 'back', 'forward'].includes(value?.action)
          ? '网页加载失败，请检查地址或稍后刷新' : '浏览器操作失败，请重新打开浏览器'
        notice = error
        await send({ type: 'result', id: value?.id, error })
        await frame()
      }
    })
  })
  lines.on('close', () => { void shutdown().finally(() => exit()) })
  const terminate = () => { void shutdown().finally(() => exit()) }
  process.on('SIGTERM', terminate)
  process.on('SIGINT', terminate)
  return { shutdown: async () => { lines.close(); await shutdown(); process.off('SIGTERM', terminate); process.off('SIGINT', terminate) } }
}

module.exports = { createImageCapture, runWorker }
if (require.main === module) runWorker({ chromium: require('/opt/office/node/node_modules/playwright').chromium })
