// Runs only in the owner sandbox. The Host transports pixels and validated input.
const { createInterface } = require('node:readline')
const { randomUUID } = require('node:crypto')
const { createScreencast } = require('./browser-screencast.cjs')
const { startDisplay, displayAvailable } = require('./browser-display.cjs')
const { createBrowserDownloads } = require('./browser-downloads.cjs')
const partialNavigationNotice = '页面已打开，但尚未完成加载；请根据当前页面内容继续操作'
/** Preserve viewport pixels; never fall back to a lossy photograph encoding. */
function createImageCapture({ budgetMs = 8000 } = {}) {
  return async (page, captureBudgetMs = budgetMs) => {
    const timeout = Math.min(budgetMs, captureBudgetMs)
    if (timeout <= 0) throw new Error('capture_timeout')
    const image = await page.screenshot({ type: 'png', caret: 'initial', timeout })
    if (image.length > 8 * 1024 * 1024) throw new Error('frame_too_large')
    image.mediaType = 'image/png'
    return image
  }
}
// Self-contained page-context observation; never evaluates model-provided code.
function observePage() {
  const visible = box => box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0
    && box.top < innerHeight && box.left < innerWidth
  const elements = []
  for (const element of document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="img"],img[alt],[tabindex],[onclick],[contenteditable="true"]')) {
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
      ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
      disabled: element.disabled === true, expanded: element.getAttribute('aria-expanded'),
      label: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('alt') || element.innerText || '').slice(0,200),
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

function runWorker({ chromium, input = process.stdin, output = process.stdout, exit = code => process.exit(code), displayFactory = displayAvailable() ? startDisplay : undefined, commandTimeoutMs = 30_000, cancelGraceMs = 1_000, workspace = process.cwd() }) {
  let browser, context, page, session, watching = false, capturing = false, closed = false
  let display
  let legacyPixels = false
  let adoptNewPage
  let timer, notice = '', navigation = 0, hasFrame = false, navigating = false, lastFrame
  let captureFinished = Promise.resolve(), finishCapture = () => {}
  let latestDownload, downloadSequence = 0
  const downloads = createBrowserDownloads({ workspace, report: update => {
    if (closed) return
    notice = update.notice
    if (update.download) latestDownload = update.download
    void captureFinished.then(() => frame()).catch(() => {})
  } })
  let shutdownPromise
  let commandDeadline, cancellationDeadline
  const pages = new Map()
  const errorPageUrl = 'chrome-error://chromewebdata/'
  const displayUrl = (url, history) => {
    if (url === 'about:blank') return ''
    if (url !== errorPageUrl) return url
    const failed = history.entries[history.currentIndex]?.url || ''
    try { return validUrl(failed) } catch { return '' }
  }
  let pageId, pendingPopup, frameSequence = 0, activeCommand, revision = 0
  const streams = new Map(), cancelled = new Set(), pressedButtons = new Set(), pressedModifiers = new Set()
  const observedFrames = new Map()
  let frameReference = 0
  async function observe() {
    for (let attempt = 0; ; attempt++) {
      try { return await observeOnce() }
      catch (error) {
        if (error.message !== 'stale_observation' || attempt >= 2) throw error
        await new Promise(resolve => setTimeout(resolve, 16))
      }
    }
  }
  async function observeOnce() {
    const baseline = revision
    const result = { ...await page.evaluate(observePage), page_id: pageId, revision, ...(notice ? { notice } : {}),
      ...(latestDownload ? { download: latestDownload } : {}) }
    if (typeof page.locator === 'function') {
      try { result.accessibility = (await page.locator('body').ariaSnapshot({ timeout: 1500 })).slice(0, 16000) } catch {}
    }
    result.frames = []
    for (const frame of page.frames?.() ?? []) {
      if (frame === page.mainFrame() || result.frames.length >= 6) continue
      try {
        const handle = await frame.frameElement()
        const box = await handle.boundingBox().finally(() => handle.dispose())
        if (!box || box.x >= result.viewport.width || box.y >= result.viewport.height || box.x + box.width < 0 || box.y + box.height < 0) continue
        let ref = [...observedFrames].find(([, value]) => value === frame)?.[0]
        if (!ref) { ref = `frame-${++frameReference}`; observedFrames.set(ref, frame) }
        const content = await frame.evaluate(observePage)
        const entry = { frame_ref: ref, ...content, text: content.text.slice(0, 5000), bounds: box }
        try { entry.accessibility = (await frame.locator('body').ariaSnapshot({ timeout: 1000 })).slice(0, 6000) } catch {}
        result.frames.push(entry)
      } catch {}
    }
    for (const [ref, frame] of observedFrames) if (frame.isDetached() || frame.page() !== page) observedFrames.delete(ref)
    if (revision !== baseline) throw new Error('stale_observation')
    return result
  }
  function selectPage(id) {
    const selected = pages.get(id)
    if (!selected || selected.page.isClosed()) throw new Error('browser_closed')
    if (page !== selected.page) { navigation++; revision++; lastFrame = undefined; hasFrame = false }
    pageId = id; page = selected.page; session = selected.session
  }
  const send = value => new Promise(resolve => {
    if (output.write(JSON.stringify(value) + '\n')) resolve()
    else output.once('drain', resolve)
  })
  const capture = createImageCapture()
  async function publishImage(target, cdp, epoch, url, image, extra = {}) {
    const viewport = target.viewportSize() || await target.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const history = await cdp.send('Page.getNavigationHistory')
    const title = (await target.title()).slice(0, 1024)
    if (target !== page || target.url() !== url || navigation !== epoch || closed || (extra.frame_id && !watching)) return false
    const meta = { type: 'frame', page_id: pageId, url: displayUrl(url, history), title,
      ...viewport, mediaType: extra.mediaType || image.mediaType, back: history.currentIndex > 0,
      forward: history.currentIndex < history.entries.length - 1, notice, ...(latestDownload ? { download: latestDownload } : {}), ...extra }
    const stamp = JSON.stringify(meta)
    if (extra.frame_id || !lastFrame || lastFrame.stamp !== stamp || !lastFrame.image.equals(image)) {
      await send({ ...meta, image: typeof image === 'string' ? image : image.toString('base64') })
      if (Buffer.isBuffer(image)) lastFrame = { stamp, image }
    }
    hasFrame = true
    return true
  }
  function assertCurrent(value) {
    if (closed) throw new Error('browser_closed')
    if (cancelled.has(value.id)) throw new Error('operation_cancelled')
  }
  function assertObservation(value, expectedRevision = value.expected_revision) {
    assertCurrent(value)
    if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('stale_observation')
  }
  async function resolveElement(value) {
    const owner = value.frame_ref ? observedFrames.get(value.frame_ref) : page
    if (!owner || owner.isDetached?.()) throw new Error('stale_observation')
    const locator = value.role ? owner.getByRole(value.role, { name: value.name, exact: true }) : owner.locator(value.selector)
    const count = await locator.count()
    if (count !== 1) throw Object.assign(new Error(count === 0 ? 'element_not_found' : 'ambiguous_element'), { matchCount: count })
    return locator
  }
  async function releaseInput() {
    for (const button of pressedButtons) await page.mouse.up({ button }).catch(() => {})
    pressedButtons.clear()
    await setModifiers([])
  }
  async function setModifiers(modifiers) {
    for (const key of pressedModifiers) if (!modifiers.includes(key)) { await page.keyboard.up(key); pressedModifiers.delete(key) }
    for (const key of modifiers) if (!pressedModifiers.has(key)) { await page.keyboard.down(key); pressedModifiers.add(key) }
  }
  async function selectedText() {
    for (const frame of page.frames?.() || [page]) {
      const text = await frame.evaluate(() => {
        if (!document.hasFocus()) return ''
        let active = document.activeElement
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
        if (active instanceof HTMLInputElement && active.type === 'password') return ''
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
          return active.value.slice(active.selectionStart || 0, active.selectionEnd || 0).slice(0, 32769)
        return String(getSelection() || '').slice(0, 32769)
      }).catch(() => '')
      if (text.length > 32768) throw new Error('selection_too_large')
      if (text) return text
    }
    return ''
  }
  const validUrl = value => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 4096) throw new Error('invalid_url')
    return url.href
  }
  const validPageUrl = value => {
    // A site may open its own generated document. Chromium owns the blob's
    // origin and lifetime; address-bar/tool navigation still requires HTTP(S).
    if (value.length <= 4096 && new URL(value).protocol === 'blob:') return value
    return validUrl(value)
  }
  async function frame(deadline) {
    if (!page || page.isClosed() || capturing || closed || navigating) return false
    capturing = true
    captureFinished = new Promise(resolve => { finishCapture = resolve })
    const target = page, cdp = session, epoch = navigation, url = target.url()
    try {
      if (url !== 'about:blank' && url !== errorPageUrl) validPageUrl(url)
      if (display) {
        // The desktop's RFB stream owns pixels. This stream only carries navigation/control metadata.
        const viewport = await target.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        const history = await cdp.send('Page.getNavigationHistory')
        const meta = { type: 'frame', page_id: pageId, display: 'kasm', url: displayUrl(url, history),
          title: (await target.title()).slice(0, 1024), ...viewport, back: history.currentIndex > 0,
          forward: history.currentIndex < history.entries.length - 1, notice, ...(latestDownload ? { download: latestDownload } : {}) }
        if (target !== page || closed || navigation !== epoch) return false
        const stamp = JSON.stringify(meta)
        if (lastFrame?.stamp !== stamp) { await send(meta); lastFrame = { stamp } }
        if (legacyPixels) {
          const image = await capture(target)
          if (!closed && target === page && navigation === epoch) {
            const { display: _display, ...legacy } = meta
            await send({ ...legacy, legacy: true, mediaType: image.mediaType, image: image.toString('base64') })
          }
        }
        hasFrame = true
        return true
      }
      const image = await capture(target, deadline === undefined ? undefined : deadline - Date.now())
      return await publishImage(target, cdp, epoch, url, image)
    } catch (error) {
      // A navigation invalidates old-page captures; it is not a stable-page timeout.
      if (closed || target !== page || navigating || navigation !== epoch || target.url() !== url) return false
      if (error.message === 'frame_too_large' && !hasFrame) fatal('网页图像过大，请重新打开浏览器')
      else if (error.message === 'capture_timeout' || error.name === 'TimeoutError') notice = '网页画面暂时获取失败，正在重试'
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
    if (!closed) notice = '网页画面暂时获取失败，正在重试'
    throw new Error('frame_unavailable')
  }
  async function fitDisplayWindow(cdp) {
    const window = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } })
    await cdp.send('Browser.setWindowBounds', { windowId: window.windowId,
      bounds: { left: 0, top: 0, ...display.size } })
    await cdp.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'fullscreen' } })
    // Chromium enforces a minimum outer-window width even in kiosk mode. Keep
    // layout and input coordinates aligned with the visible X display below it.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...display.size, deviceScaleFactor: 1, mobile: false,
    })
  }
  async function bind(target, id) {
    const cdp = await context.newCDPSession(target)
    if (display) {
      await fitDisplayWindow(cdp)
      await target.bringToFront()
    } else streams.set(target, createScreencast({ page: target, session: cdp, nextId: () => ++frameSequence,
      onUnavailable: () => startFallback(target),
      emit: value => {
        if (target !== page || closed || navigating || !watching || target.isClosed()) return false
        return publishImage(target, cdp, navigation, target.url(), value.image,
          { frame_id: value.frame_id, mediaType: value.mediaType })
      } }))
    target.on('crash', () => { if (target === page) fatal('网页进程已退出，请重新打开浏览器') })
    target.on('close', () => {
      void streams.get(target)?.dispose()
      streams.delete(target)
      if (pages.get(id)?.page !== target) return
      pages.delete(id)
      void send({ type: 'page-close', page_id: id })
      if (target === page) {
        fatal('网页已经关闭，请重新打开浏览器')
      }
    })
    target.setDefaultTimeout(5000)
    target.setDefaultNavigationTimeout(20000)
    target.on('dialog', dialog => { notice = '网页弹窗已关闭'; void dialog.dismiss().catch(() => {}) })
    target.on('download', download => { downloadSequence++; void downloads.start(download).catch(() => {}) })
    target.on('domcontentloaded', () => {
      if (target === page && notice === partialNavigationNotice) {
        notice = ''
        // Metadata can change without a compositor frame (for example, an empty script).
        void captureFinished.then(() => { if (target === page) return frame() })
      }
    })
    target.on('framenavigated', main => {
      if (main !== target.mainFrame() || target !== page) return
      navigation++
      revision++
      // Chromium's own network/certificate error page remains a usable tab.
      // It is never accepted as an address-bar or tool navigation target.
      if (main.url() === 'about:blank' || main.url() === errorPageUrl) return
      try {
        validPageUrl(main.url())
      } catch { notice = '浏览器仅支持 HTTP 和 HTTPS 页面'; void target.close().catch(() => {}) }
    })
    const adopt = popup => {
      pendingPopup = (async () => {
      const popupId = id
      let popupSession
      let adopted = false
      try {
        // A generated document can emit popup before Chromium exposes its URL.
        // This only waits for an actual opener popup, never native download UI.
        if (!popup.url()) await popup.waitForURL(/^(?:https?:|blob:|about:blank)/, { waitUntil: 'commit', timeout: 5000 })
        try {
          if (popup.url() !== 'about:blank' && popup.url() !== errorPageUrl) validPageUrl(popup.url())
        } catch {
          notice = '浏览器仅支持 HTTP 和 HTTPS 页面'
          await popup.close().catch(() => {})
          return
        }
        popupSession = await bind(popup, popupId)
        // The initial blank popup can navigate while its CDP binding is awaited.
        try { if (popup.url() !== 'about:blank' && popup.url() !== errorPageUrl) validPageUrl(popup.url()) }
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
        const previous = pages.get(id)
        pages.set(popupId, { page: popup, session: popupSession })
        adopted = true
        selectPage(popupId)
        await streams.get(previous?.page)?.stop()
        await previous?.page.close().catch(() => {})
        await previous?.session.detach?.().catch(() => {})
        await frame()
        if (watching && !display) await streams.get(popup)?.start()
      } catch {
        if (!adopted) {
          await popupSession?.detach().catch(() => {})
          await popup.close().catch(() => {})
          notice = '弹窗连接中断，请重新打开网页'
        } else fatal('网页连接中断，请重新打开浏览器')
      }
      })()
    }
    target.on('popup', adopt)
    adoptNewPage = adopt
    return cdp
  }
  function startFallback(target) {
    if (target !== page || !watching || closed || streams.get(target)?.active) return
    clearInterval(timer)
    let nextAttempt = Date.now() + 5000, recovering = false
    timer = setInterval(() => {
      if (!watching || closed || target !== page) return
      if (streams.get(target)?.active) { clearInterval(timer); return }
      if (!recovering && Date.now() >= nextAttempt) {
        recovering = true
        nextAttempt = Date.now() + 5000
        void streams.get(target)?.start().then(started => {
          if (started && watching && target === page) clearInterval(timer)
        }).finally(() => { recovering = false })
      }
      void frame()
    }, 500)
  }
  async function operation(value) {
    const action = value.action
    if (action === 'init') {
      if (displayFactory) display = await displayFactory({ width: value.width, height: value.height, emit: send,
        onExit: () => fatal('沙盒浏览器显示服务已退出') })
      if (closed) { await display?.stop(); throw new Error('browser_closed') }
      browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: !display,
        ...(display ? { env: display.env } : {}),
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...(display ? ['--force-device-scale-factor=1', '--no-first-run',
          '--kiosk', '--window-position=0,0', `--window-size=${value.width},${value.height}`] : [])], timeout: 20000 })
      if (closed) { await browser.close(); throw new Error('browser_closed') }
      browser.on('disconnected', () => fatal('沙盒浏览器已退出，请重新打开浏览器'))
      context = await browser.newContext({ viewport: display ? null : { width: value.width, height: value.height },
        ...(!display ? { deviceScaleFactor: 1 } : {}), locale: 'zh-CN', acceptDownloads: true, serviceWorkers: 'allow' })
      if (closed) { await context.close(); throw new Error('browser_closed') }
      if (display) {
        await context.exposeBinding('__workbenchInputChanged', () => { revision++ })
        await context.addInitScript(() => {
          for (const name of ['pointerdown', 'keydown', 'input', 'wheel'])
            addEventListener(name, event => { if (event.isTrusted) void window.__workbenchInputChanged() }, { capture: true, passive: true })
        })
      }
      context.on?.('page', target => {
        // Chromium variants can expose native download UI as an empty-URL target.
        // It is not a web tab; adopting/closing it can stall later page commands.
        if (!page || target === page || !target.url()) return
        // Ctrl+T/Ctrl+N can create a page without a window.open opener.
        void target.opener().then(opener => { if (!opener && !closed) adoptNewPage?.(target) })
      })
      page = await context.newPage()
      if (closed) { await page.close(); throw new Error('browser_closed') }
      pageId = value.browser_id || randomUUID()
      session = await bind(page, pageId)
      pages.set(pageId, { page, session })
      await frame()
      if (!hasFrame) throw new Error('initial_frame_unavailable')
      return { display: display ? 'kasm' : 'cdp', input_protocol: 2 }
    }
    if (action === 'display-open') { if (!display) throw new Error('display_unavailable'); display.open(value.connection); return }
    if (action === 'display-close') { display?.close(value.connection); return }
    if (action === 'display-write') { if (!display) throw new Error('display_unavailable'); display.write(value.connection, value.data); return }
    if (action === 'watch' && value.enabled !== true) {
      watching = false
      legacyPixels = false
      clearInterval(timer)
      await streams.get(page)?.stop()
      await releaseInput()
      return
    }
    if (value.page_id) selectPage(value.page_id)
    if (!page || page.isClosed()) throw new Error('browser_closed')
    if (action === 'ack') { await streams.get(page)?.acknowledge(value.frame_id); return }
    if (action === 'release-input') { await releaseInput(); return }
    if (action === 'selection') return { text: await selectedText(), revision }
    if (action === 'watch') {
      watching = true
      legacyPixels = value.legacy_pixels === true
      clearInterval(timer)
      if (display) { await frame(); timer = setInterval(() => void frame(), 500); return }
      if (!await streams.get(page)?.start()) {
        await frame()
        startFallback(page)
      }
      return
    }
    if (action === 'snapshot') return observe()
    if (action === 'screenshot') {
      const target = page, epoch = navigation
      const image = await capture(page)
      if (target !== page || epoch !== navigation) throw new Error('stale_observation')
      return { image: image.toString('base64'), mediaType: image.mediaType }
    }
    notice = ''
    assertObservation(value)
    // Element lookup is observational. Advance only after its preconditions pass.
    if (!['element-click', 'element-text'].includes(action)) revision++
    const moves = ['navigate', 'reload', 'back', 'forward'].includes(action)
    if (moves) { navigation++; navigating = true }
    const navigationPage = page, navigationDeadline = Date.now() + 20000
    const downloadsBeforeNavigation = downloadSequence
    let navigationResponse, navigationCommitted = false, navigationLoaded = false
    const loaded = () => { navigationLoaded = true }
    try { switch (action) {
      case 'navigate': {
        const target = validUrl(value.url)
        let redirected = false
        const trackRedirect = request => {
          if (request.isNavigationRequest() && request.frame() === navigationPage.mainFrame() && request.redirectedFrom()) redirected = true
        }
        if (value.fallback_url) navigationPage.on('request', trackRedirect)
        try {
          navigationResponse = await page.goto(target, { waitUntil: 'commit', ...(value.fallback_url ? { timeout: 10000 } : {}) })
        } catch (failure) {
          // Only inferred HTTPS gets one HTTP attempt, within the same navigation
          // deadline and page. Explicit HTTPS, certificate errors and cancellation
          // never downgrade, and a failed redirect must not replay the original URL.
          const fallback = value.fallback_url && new URL(validUrl(value.fallback_url))
          const original = new URL(target)
          const connectionFailure = /net::ERR_(?:SSL_PROTOCOL_ERROR|CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT)(?:\b|$)/.test(failure.message) || failure.name === 'TimeoutError'
          if (!fallback || !connectionFailure || redirected || closed || cancelled.has(value.id) || page !== navigationPage ||
              Date.now() >= navigationDeadline || original.protocol !== 'https:' || fallback.protocol !== 'http:' ||
              ['hostname', 'pathname', 'search', 'hash'].some(key => original[key] !== fallback[key])) throw failure
          // A failed goto can reject before Chromium commits its error page.
          // Wait for that commit instead of racing it with the HTTP attempt.
          await page.waitForURL(errorPageUrl, { waitUntil: 'commit', timeout: Math.min(1000, Math.max(1, navigationDeadline - Date.now())) }).catch(() => {})
          assertCurrent(value)
          if (page !== navigationPage || Date.now() >= navigationDeadline) throw failure
          navigationResponse = await page.goto(fallback.href, { waitUntil: 'commit', timeout: Math.max(1, navigationDeadline - Date.now()) })
        } finally { navigationPage.off('request', trackRedirect) }
        break
      }
      case 'reload': navigationResponse = await page.reload({ waitUntil: 'commit' }); break
      case 'back': navigationResponse = await page.goBack({ waitUntil: 'commit' }); break
      case 'forward': navigationResponse = await page.goForward({ waitUntil: 'commit' }); break
      case 'resize':
        navigation++
        if (display) {
          await display.resize(value.width, value.height)
          await fitDisplayWindow(session)
          // XRandR and CDP acknowledge before Chromium applies the resize.
          // Observe the renderer before accepting another input or snapshot.
          const resized = await page.waitForFunction(({ width, height }) =>
            innerWidth === width && innerHeight === height,
          { width: value.width, height: value.height }, { timeout: 5000, polling: 50 })
          await resized.dispose()
        } else await page.setViewportSize({ width: value.width, height: value.height })
        navigation++
        if (capturing) await captureFinished
        await streams.get(page)?.resize()
        break
      case 'modifiers': await setModifiers(value.modifiers); break
      case 'cut-selection':
        if (!value.text || await selectedText() !== value.text) throw new Error('stale_observation')
        assertCurrent(value); await page.keyboard.press('ControlOrMeta+X'); break
      case 'click':
        await setModifiers(value.modifiers || [])
        await page.mouse.click(value.x, value.y, { button: value.button || 'left', clickCount: value.count || 1 }); break
      case 'pointer-down':
        await setModifiers(value.modifiers || [])
        await page.mouse.move(value.x, value.y); assertCurrent(value)
        await page.mouse.down({ button: value.button, clickCount: value.count }); pressedButtons.add(value.button); break
      case 'pointer-up':
        await setModifiers(value.modifiers || [])
        await page.mouse.move(value.x, value.y); assertCurrent(value)
        await page.mouse.up({ button: value.button, clickCount: value.count }); pressedButtons.delete(value.button); break
      case 'element-click': {
        const locator = await resolveElement(value)
        assertObservation(value)
        const preparedRevision = ++revision
        await locator.scrollIntoViewIfNeeded(); assertObservation(value, preparedRevision)
        const box = await locator.boundingBox(); assertObservation(value, preparedRevision)
        if (!box) throw new Error('element_not_visible')
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        break
      }
      case 'element-text': {
        const locator = await resolveElement(value)
        if (!await locator.isEditable()) throw new Error('element_not_editable')
        assertObservation(value)
        const preparedRevision = ++revision, target = page, epoch = navigation
        await locator.focus(); assertObservation(value, preparedRevision)
        await page.keyboard.press('ControlOrMeta+A'); assertCurrent(value)
        if (page !== target || navigation !== epoch) throw new Error('stale_observation')
        await page.keyboard.insertText(value.text)
        break
      }
      case 'move': await setModifiers(value.modifiers || []); await page.mouse.move(value.x, value.y); break
      case 'wheel': await page.mouse.wheel(value.x, value.y); break
      case 'text': await page.keyboard.insertText(value.text); break
      case 'key': await page.keyboard.press(value.key); break
      default: throw new Error('invalid_action')
    }
      if (moves && navigationResponse) {
        // Only the requested navigation's response proves a new document committed.
        // Hash/history changes emit framenavigated too, but do not prove that commit.
        navigationCommitted = true
        navigationPage.on('domcontentloaded', loaded)
        await navigationPage.waitForLoadState('domcontentloaded', { timeout: Math.max(1, navigationDeadline - Date.now()) })
      }
    } catch (error) {
      const attachmentNavigation = moves && /Download is starting|net::ERR_ABORTED/.test(error.message)
      if (attachmentNavigation && downloadSequence === downloadsBeforeNavigation) {
        // Chromium can reject goto before emitting the attachment's download event.
        // Wait only on this error path; ordinary navigation adds no timer or request.
        await new Promise(resolve => {
          const done = () => { clearTimeout(timeout); navigationPage.off('download', done); resolve() }
          const timeout = setTimeout(done, Math.min(1000, Math.max(1, navigationDeadline - Date.now())))
          navigationPage.once('download', done)
        })
      }
      // A slow page may have committed a readable document while its load event
      // still waits on site resources. Preserve that observation without replaying
      // navigation or claiming the page finished loading. Pre-commit failures stay errors.
      // An attachment response starts a download instead of committing a document.
      if (!attachmentNavigation || downloadSequence === downloadsBeforeNavigation) {
        if (!navigationCommitted || error.name !== 'TimeoutError' || page !== navigationPage || page.isClosed()) throw error
        assertCurrent(value)
        try { validPageUrl(page.url()) } catch { throw error }
        let readDeadline
        const readableDocument = await Promise.race([
          page.evaluate(() => ({ url: location.href, hasBody: Boolean(document.body), readyState: document.readyState })).catch(() => undefined),
          new Promise(resolve => { readDeadline = setTimeout(resolve, 1000) }),
        ]).finally(() => clearTimeout(readDeadline))
        assertCurrent(value)
        if (!readableDocument?.hasBody || page !== navigationPage || page.url() !== readableDocument.url) throw error
        notice = navigationLoaded || readableDocument.readyState === 'complete' ? '' : partialNavigationNotice
      }
    } finally {
      navigationPage.off('domcontentloaded', loaded)
      if (moves) { navigation++; navigating = false }
    }
    if (moves && streams.get(page)?.active) await streams.get(page).resize()
    if (pendingPopup) { const pending = pendingPopup; await pending; if (pendingPopup === pending) pendingPopup = undefined }
    if (moves && capturing) await captureFinished
    assertCurrent(value)
    // Observed frames stream independently; a click never waits for image encoding.
    if (display) await frame()
    else if (!streams.get(page)?.active && (!watching || !['move', 'wheel', 'text', 'key'].includes(action))) await freshFrame()
    return { page_id: pageId }
  }
  function fatal(error) {
    if (closed) return
    const stop = shutdown()
    const forced = setTimeout(() => exit(2), 1500)
    Promise.all([send({ type: 'fatal', error }), stop]).finally(() => { clearTimeout(forced); exit(2) }).catch(() => {})
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise
    closed = true
    clearInterval(timer)
    clearTimeout(commandDeadline)
    clearTimeout(cancellationDeadline)
    shutdownPromise = (async () => {
      await Promise.all([...streams.values()].map(value => value.dispose()))
      await downloads.close()
      await context?.close?.().catch(() => {})
      await browser?.close().catch(() => {})
      await display?.stop()
    })()
    return shutdownPromise
  }
  let queue = Promise.resolve()
  const lines = createInterface({ input })
  lines.on('line', line => {
    if (line.length > 256 * 1024) { void shutdown().finally(() => exit(2)); return }
    let request
    try { request = JSON.parse(line) } catch { return }
    if (closed) return
    if (request.action === 'cancel') {
      cancelled.add(request.cancel_id)
      if (cancelled.size > 512) cancelled.delete(cancelled.values().next().value)
      if (activeCommand?.id === request.cancel_id && ['navigate', 'reload', 'back', 'forward'].includes(activeCommand.action))
        void session?.send('Page.stopLoading').catch(() => {})
      if (activeCommand?.id === request.cancel_id && !cancellationDeadline) {
        const cancelledCommand = activeCommand
        cancellationDeadline = setTimeout(() => {
          if (activeCommand === cancelledCommand) fatal('浏览器操作未能结束，请重新打开浏览器')
        }, cancelGraceMs)
      }
      return
    }
    if (['ack', 'watch', 'release-input', 'display-open', 'display-write', 'display-close'].includes(request.action)) {
      void operation(request).then(value => send({ type: 'result', id: request.id, value }),
        () => send({ type: 'result', id: request.id, error: '浏览器画面连接失败' }))
      return
    }
    queue = queue.then(async () => {
      let value
      try {
        value = request
        activeCommand = value
        assertCurrent(value)
        // A stuck renderer cannot be released with Promise.race: its old
        // operation may still act later. End this worker and let the Host wait
        // for subprocess exit before allocating another browser for the owner.
        commandDeadline = setTimeout(() => fatal('浏览器操作超时，请重新打开浏览器'), commandTimeoutMs)
        const result = await operation(value)
        if (!closed) await send({ type: 'result', id: value.id, ...(result === undefined ? {} : { value: result }) })
      } catch (failure) {
        if (closed) return
        if (cancelled.has(value?.id)) { await send({ type: 'result', id: value.id, error: '浏览器操作已取消' }); return }
        const outcome = failure.message === 'element_not_found'
          ? { kind: 'not_found', message: '未找到网页元素', match_count: 0 }
          : failure.message === 'ambiguous_element'
          ? { kind: 'ambiguous', message: `匹配到 ${failure.matchCount} 个网页元素`, match_count: failure.matchCount }
          : failure.message === 'stale_observation' && !['snapshot', 'screenshot', 'cut-selection'].includes(value?.action)
          ? { kind: 'stale', message: '页面已更新，请根据最新页面继续操作' } : undefined
        if (outcome) {
          await send({ type: 'result', id: value.id, value: { page_id: pageId, outcome } })
          return
        }
        const error = failure.message === 'stale_observation' ? '页面已变化，请重新查看页面后操作'
          : ['navigate', 'reload', 'back', 'forward'].includes(value?.action)
          ? '网页加载失败，请检查地址或稍后刷新' : '浏览器操作失败'
        notice = error
        await send({ type: 'result', id: value?.id, error })
        if (!streams.get(page)?.active) await frame()
      } finally {
        clearTimeout(commandDeadline)
        clearTimeout(cancellationDeadline)
        commandDeadline = cancellationDeadline = undefined
        cancelled.delete(value?.id)
        activeCommand = undefined
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
