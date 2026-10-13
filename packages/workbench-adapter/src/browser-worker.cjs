// Runs only in the owner sandbox. The Host transports pixels and validated input.
const { createInterface } = require('node:readline')
const { randomUUID } = require('node:crypto')
/** Prefer lossless text at 2x scale; bound photographic frames without low-quality encoding. */
function createImageCapture({ now = Date.now, budgetMs = 8000 } = {}) {
  const formats = [{type:'png'}, ...[95,90,85].map(quality => ({type:'jpeg',quality}))]
  let key, start = 0
  return async (page, captureBudgetMs = budgetMs) => {
    const viewport = page.viewportSize()
    const current = `${page.url()}|${viewport.width}:${viewport.height}`
    if (current !== key) { key = current; start = 0 }
    const deadline = now() + Math.min(budgetMs, captureBudgetMs)
    for (let index = start; index < formats.length; index++) {
      const remaining = deadline - now()
      if (remaining <= 0) throw new Error('capture_timeout')
      const image = await page.screenshot({ ...formats[index], caret: 'initial', timeout: remaining })
      if (image.length <= 4 * 1024 * 1024) { start = index; image.mediaType = `image/${formats[index].type}`; return image }
    }
    throw new Error('frame_too_large')
  }
}
// Self-contained page-context observation; never evaluates model-provided code.
function observePage() {
  const visible = box => box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0
    && box.top < innerHeight && box.left < innerWidth
  const elements = []
  for (const element of document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')) {
    if (elements.length >= 120) break
    if (!visible(element.getBoundingClientRect()) || getComputedStyle(element).visibility === 'hidden') continue
    let selector = element.id ? '#' + CSS.escape(element.id) : ''
    if (!selector || document.querySelectorAll(selector).length !== 1) {
      const path = []
      let node = element, anchor = ''
      while (node && node !== document.body) {
        const parent = node.parentElement
        if (!parent) break
        const siblings = [...parent.children].filter(sibling => sibling.tagName === node.tagName)
        path.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node)+1})`)
        node = parent
        if (node.id && document.querySelectorAll('#'+CSS.escape(node.id)).length === 1) { anchor = '#'+CSS.escape(node.id); break }
        if (path.join(' > ').length > 470) break
      }
      selector = (anchor ? anchor+' > ' : node === document.body ? 'body > ' : '')+path.join(' > ')
    }
    const matches = selector.length <= 512 && document.querySelectorAll(selector)
    if (!matches || matches.length !== 1 || matches[0] !== element) continue
    elements.push({ selector, tag: element.tagName.toLowerCase(), role: element.getAttribute('role'),
      focused: element === document.activeElement,
      label: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.innerText || '').slice(0,200),
      ...(['INPUT','TEXTAREA','SELECT'].includes(element.tagName) && element.type !== 'password' ? { value: element.value.slice(0,200) } : {}) })
  }
  const parts = [], walker = document.body && document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let node, length = 0, visited = 0
  while (walker && (node = walker.nextNode()) && length < 20000 && visited++ < 10000) {
    if (!node.textContent.trim() || ['SCRIPT','STYLE','NOSCRIPT'].includes(node.parentElement?.tagName)) continue
    if (getComputedStyle(node.parentElement).visibility === 'hidden') continue
    range.selectNodeContents(node)
    if (![...range.getClientRects()].some(visible)) continue
    let start = 0, end = node.textContent.length
    // A long paragraph may be a single text node. Locate the visible characters
    // rather than repeatedly returning its off-screen prefix after scrolling.
    if (end > 2000 && range.getBoundingClientRect().height > innerHeight) {
      const offset = bottom => {
        let low = 0, high = node.textContent.length
        while (low < high) {
          const middle = (low+high) >>> 1
          range.setStart(node,middle); range.setEnd(node,middle+1)
          const box = range.getBoundingClientRect()
          if (bottom ? box.top >= innerHeight : box.bottom > 0) high = middle
          else low = middle+1
        }
        return low
      }
      start = offset(false); end = offset(true)
    }
    const text = node.textContent.slice(start, Math.min(end,start+20000-length)).trim()
    if (text) { parts.push(text); length += text.length+1 }
  }
  return { url: location.href.slice(0,4096), title: document.title.slice(0,1024),
    viewport: { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }, text: parts.join('\n').slice(0,20000), elements }
}

function runWorker({ chromium, input = process.stdin, output = process.stdout, exit = code => process.exit(code) }) {
  let browser, context, page, session, watching = false, capturing = false, closed = false
  let timer, notice = '', navigation = 0, hasFrame = false, navigating = false, lastFrame
  let captureFinished = Promise.resolve(), finishCapture = () => {}
  const pages = new Map()
  let pageId, pendingPopup, popupLimited = false
  function selectPage(id) {
    const selected = pages.get(id)
    if (!selected || selected.page.isClosed()) throw new Error('browser_closed')
    if (page !== selected.page) { navigation++; lastFrame = undefined; hasFrame = false }
    pageId = id; page = selected.page; session = selected.session
  }
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
  async function frame(deadline) {
    if (!page || page.isClosed() || capturing || closed || navigating) return false
    capturing = true
    captureFinished = new Promise(resolve => { finishCapture = resolve })
    const target = page, cdp = session, epoch = navigation, url = target.url()
    try {
      if (url !== 'about:blank') validUrl(url)
      const viewport = target.viewportSize()
      const image = await capture(target, deadline === undefined ? undefined : deadline - Date.now())
      const history = await cdp.send('Page.getNavigationHistory')
      const title = (await target.title()).slice(0, 1024)
      if (target !== page || target.url() !== url || navigation !== epoch || closed) return false
      const meta = { type: 'frame', page_id: pageId, url: url === 'about:blank' ? '' : url, title,
        ...viewport, mediaType: image.mediaType, back: history.currentIndex > 0,
        forward: history.currentIndex < history.entries.length - 1, notice }
      const stamp = JSON.stringify(meta)
      if (!lastFrame || lastFrame.stamp !== stamp || !lastFrame.image.equals(image)) {
        await send({ ...meta, image: image.toString('base64') })
        lastFrame = { stamp, image }
      }
      hasFrame = true
      return true
    } catch (error) {
      // A navigation invalidates old-page captures; it is not a stable-page timeout.
      if (closed || target !== page || navigating || navigation !== epoch || target.url() !== url) return false
      if (error.message === 'frame_too_large') fatal('网页图像过大，请重新打开浏览器')
      else if (error.message === 'capture_timeout' || error.name === 'TimeoutError') fatal('网页图像获取超时，请重新打开浏览器')
      else if (error.message === 'invalid_url') fatal('浏览器仅支持 HTTP 和 HTTPS 页面')
      // Navigation can temporarily invalidate a screenshot; the next frame retries.
    }
    finally { capturing = false; finishCapture() }
    return false
  }
  async function freshFrame() {
    if (capturing) await captureFinished
    const deadline = Date.now() + 8000
    // A redirect can invalidate the first encode; up to three frames share one budget.
    for (let attempt = 0; attempt < 3 && !closed && Date.now() < deadline; attempt++) {
      if (capturing) await captureFinished
      if (await frame(deadline)) return
    }
    if (!closed) fatal(Date.now() >= deadline ? '网页图像获取超时，请重新打开浏览器' : '网页图像获取失败，请重新打开浏览器')
    throw new Error('frame_unavailable')
  }
  async function bind(target, id) {
    const cdp = await context.newCDPSession(target)
    target.on('crash', () => { if (target === page) fatal('网页进程已退出，请重新打开浏览器') })
    target.on('close', () => {
      if (!pages.has(id)) return
      pages.delete(id)
      void send({ type: 'page-close', page_id: id })
      if (target === page) {
        const next = pages.keys().next().value
        if (next) { selectPage(next); void frame() }
        else fatal('网页已经关闭，请重新打开浏览器')
      }
    })
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
    target.on('popup', popup => {
      pendingPopup = (async () => {
      const popupId = randomUUID()
      let popupSession
      try {
        if (pages.size >= 3) {
          popupLimited = true
          notice = '最多打开3个浏览器标签，请先关闭一个'
          await popup.close().catch(() => {})
          return
        }
        try {
          if (popup.url() !== 'about:blank') validUrl(popup.url())
        } catch {
          notice = '浏览器仅支持 HTTP 和 HTTPS 页面'
          await popup.close().catch(() => {})
          return
        }
        popupSession = await bind(popup, popupId)
        // The initial blank popup can navigate while its CDP binding is awaited.
        try { if (popup.url() !== 'about:blank') validUrl(popup.url()) }
        catch {
          notice = '浏览器仅支持 HTTP 和 HTTPS 页面'
          await popupSession.detach().catch(() => {})
          await popup.close().catch(() => {})
          return
        }
        if (closed || popup.isClosed()) {
          await popupSession.detach().catch(() => {})
          await popup.close().catch(() => {})
          return
        }
        pages.set(popupId, { page: popup, session: popupSession })
        selectPage(popupId)
        await send({ type: 'page-open', page_id: popupId, opener_id: id })
        await frame()
      } catch {
        if (!pages.has(popupId)) {
          await popupSession?.detach().catch(() => {})
          await popup.close().catch(() => {})
          notice = '弹窗连接中断，请重新打开网页'
        } else fatal('网页连接中断，请重新打开浏览器')
      }
      })()
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
        deviceScaleFactor: 2, locale: 'zh-CN', acceptDownloads: false, serviceWorkers: 'block' })
      await context.route('**/*', route => {
        const request = route.request()
        if (request.isNavigationRequest() && !/^https?:\/\//i.test(request.url())) return route.abort()
        return route.continue()
      })
      page = await context.newPage()
      pageId = value.browser_id || randomUUID()
      session = await bind(page, pageId)
      pages.set(pageId, { page, session })
      timer = setInterval(() => { if (watching) void frame() }, 400)
      await frame()
      if (!hasFrame) throw new Error('initial_frame_unavailable')
      return
    }
    if (action === 'watch' && value.enabled !== true) { watching = false; return }
    if (value.page_id) selectPage(value.page_id)
    if (!page || page.isClosed()) throw new Error('browser_closed')
    if (action === 'watch') { watching = value.enabled === true; if (watching) await frame(); return }
    if (action === 'snapshot') return { ...await page.evaluate(observePage), page_id: pageId }
    if (action === 'close-page') {
      const previous = page
      pages.delete(pageId)
      const next = pages.keys().next().value
      if (next) selectPage(next)
      await previous.close()
      if (next) await frame()
      return
    }
    notice = ''
    const moves = ['navigate', 'reload', 'back', 'forward'].includes(action)
    if (moves) { navigation++; navigating = true }
    try { switch (action) {
      case 'navigate': await page.goto(validUrl(value.url), { waitUntil: 'domcontentloaded' }); break
      case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); break
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break
      case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); break
      case 'resize':
        navigation++
        await page.setViewportSize({ width: value.width, height: value.height })
        navigation++
        if (capturing) await captureFinished
        break
      case 'click': await page.mouse.click(value.x, value.y, { button: value.button || 'left', clickCount: value.count || 1 }); break
      case 'element-click': await page.locator(value.selector).click(); break
      case 'element-text': await page.locator(value.selector).fill(value.text); break
      case 'move': await page.mouse.move(value.x, value.y); break
      case 'wheel': await page.mouse.wheel(value.x, value.y); break
      case 'text': await page.keyboard.insertText(value.text); break
      case 'key': await page.keyboard.press(value.key); break
      default: throw new Error('invalid_action')
    } } finally { if (moves) { navigation++; navigating = false } }
    if (pendingPopup) { const pending = pendingPopup; await pending; if (pendingPopup === pending) pendingPopup = undefined }
    if (moves && capturing) await captureFinished
    if (!watching || !['move', 'wheel', 'text', 'key'].includes(action)) await freshFrame()
    const result = { page_id: pageId, ...(popupLimited ? { page_limit: true } : {}) }
    popupLimited = false
    return result
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
        const result = await operation(value)
        if (!closed) await send({ type: 'result', id: value.id, ...(result === undefined ? {} : { value: result }) })
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

module.exports = { createImageCapture, runWorker, observePage }
if (require.main === module) runWorker({ chromium: require('/opt/office/node/node_modules/playwright').chromium })
