// Runs only in the owner sandbox. The Host transports pixels and validated input.
const { chromium } = require('/opt/office/node/node_modules/playwright')
const { createInterface } = require('node:readline')
let browser, context, page, session, watching = false, capturing = false, closed = false
let timer, notice = ''
const send = value => new Promise(resolve => {
  if (process.stdout.write(JSON.stringify(value) + '\n')) resolve()
  else process.stdout.once('drain', resolve)
})
const validUrl = value => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 4096) throw new Error('invalid_url')
  return url.href
}
async function frame() {
  if (!page || page.isClosed() || capturing || closed) return
  capturing = true
  try {
    const url = page.url()
    const viewport = page.viewportSize()
    const image = await page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 })
    if (image.length > 1024 * 1024) throw new Error('frame_too_large')
    const history = await session.send('Page.getNavigationHistory')
    await send({ type: 'frame', url: url === 'about:blank' ? '' : url, title: await page.title(),
      ...viewport, image: image.toString('base64'), back: history.currentIndex > 0,
      forward: history.currentIndex < history.entries.length - 1, notice })
  } catch { /* Navigation can temporarily invalidate a screenshot; the next frame retries. */ }
  finally { capturing = false }
}
async function bind(target) {
  session = await context.newCDPSession(target)
  target.setDefaultTimeout(5000)
  target.setDefaultNavigationTimeout(20000)
  target.on('dialog', dialog => { notice = '网页弹窗已关闭'; void dialog.dismiss().catch(() => {}) })
  target.on('download', download => { notice = '请在系统浏览器中下载文件'; void download.cancel().catch(() => {}) })
  target.on('framenavigated', main => {
    if (main !== target.mainFrame() || target !== page || main.url() === 'about:blank') return
    try {
      validUrl(main.url())
    } catch { notice = '浏览器仅支持 HTTP 和 HTTPS 页面'; void target.close().catch(() => {}) }
  })
  target.on('popup', async popup => {
    // Keep the single tab's owner context; do not create an unowned external guest.
    await bind(popup)
    const previous = page
    page = popup
    await previous.close().catch(() => {})
    await frame()
  })
}
async function operation(value) {
  const action = value.action
  if (action === 'init') {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 20000 })
    context = await browser.newContext({ viewport: { width: value.width, height: value.height },
      locale: 'zh-CN', acceptDownloads: false, serviceWorkers: 'block' })
    await context.route('**/*', route => {
      const request = route.request()
      if (request.isNavigationRequest() && !/^https?:\/\//i.test(request.url())) return route.abort()
      return route.continue()
    })
    page = await context.newPage()
    await bind(page)
    timer = setInterval(() => { if (watching) void frame() }, 400)
    await frame()
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
  await frame()
}
async function shutdown() {
  if (closed) return
  closed = true
  clearInterval(timer)
  await browser?.close().catch(() => {})
}
let queue = Promise.resolve()
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  if (line.length > 256 * 1024) { void shutdown().finally(() => process.exit(2)); return }
  queue = queue.then(async () => {
    let value
    try {
      value = JSON.parse(line)
      await operation(value)
      await send({ type: 'result', id: value.id })
    } catch {
      const error = ['navigate', 'reload', 'back', 'forward'].includes(value?.action)
        ? '网页加载失败，请检查地址或稍后刷新' : '浏览器操作失败，请重新打开浏览器'
      notice = error
      await send({ type: 'result', id: value?.id, error })
      await frame()
    }
  })
})
lines.on('close', () => { void shutdown().finally(() => process.exit()) })
process.on('SIGTERM', () => { void shutdown().finally(() => process.exit()) })
process.on('SIGINT', () => { void shutdown().finally(() => process.exit()) })
