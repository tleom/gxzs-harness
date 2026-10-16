const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { PassThrough } = require('node:stream')
const { createInterface } = require('node:readline')
const { chromium } = require('/opt/office/node/node_modules/playwright')
const { runWorker } = require('/opt/workbench/packages/workbench-adapter/src/browser-worker.cjs')

async function main() {
  let navigations = 0, pendingScript, testPage
  const server = createServer((request, response) => {
    if (request.url === '/pending.js') { pendingScript = response; return }
    if (request.url === '/uncommitted') {
      return
    }
    if (request.url !== '/partial') { response.writeHead(404); response.end(); return }
    navigations++
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Partial page</title><body><button id="ready" onclick="this.textContent=\'Clicked\'">Ready</button><script src="/pending.js"></script></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const input = new PassThrough(), output = new PassThrough(), waiting = new Map(), frames = []
  const reader = createInterface({ input: output })
  reader.on('line', line => {
    const message = JSON.parse(line)
    if (message.type === 'frame') frames.push(message)
    if (message.type === 'result') waiting.get(message.id)?.(message)
  })
  let sequence = 0
  const command = (action, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`Worker response timed out: ${action}`)) }, 35000)
    waiting.set(id, result => { clearTimeout(timeout); waiting.delete(id); resolve(result) })
    input.write(JSON.stringify({ id, action, ...args }) + '\n')
  })
  const runtime = runWorker({ chromium: { async launch(options) {
    const browser = await chromium.launch(options), newContext = browser.newContext.bind(browser)
    browser.newContext = async (...args) => {
      const context = await newContext(...args), newPage = context.newPage.bind(context)
      context.newPage = async (...values) => { testPage = await newPage(...values); return testPage }
      return context
    }
    return browser
  } }, input, output, displayFactory: null, exit: () => {} })
  try {
    assert.equal((await command('init', { width: 700, height: 500 })).error, undefined)
    const started = Date.now()
    const navigation = await command('navigate', { url: url + '/partial' })
    assert.equal(navigation.error, undefined, 'A committed readable page remains usable after the native 20-second load deadline')
    const snapshot = (await command('snapshot')).value
    assert.equal(snapshot.title, 'Partial page')
    assert.match(snapshot.notice, /尚未完成加载/)
    await command('watch', { enabled: true })
    const firstFrame = frames.length
    assert.ok(pendingScript)
    pendingScript.end('')
    await testPage.waitForLoadState('domcontentloaded', { timeout: 3000 })
    const clearDeadline = Date.now() + 3000
    while (!frames.slice(firstFrame).some(frame => frame.notice === '') && Date.now() < clearDeadline)
      await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(frames.slice(firstFrame).some(frame => frame.notice === ''), 'Loading metadata must refresh even when the script changes no pixels')
    const loaded = (await command('snapshot')).value
    assert.equal(loaded.notice, undefined)
    const button = loaded.elements.find(element => element.label === 'Ready')
    assert.ok(button)
    assert.equal((await command('element-click', { selector: button.selector, expected_revision: loaded.revision })).error, undefined)
    const clicked = (await command('snapshot')).value
    assert.match(clicked.text, /Clicked/)
    assert.equal(navigations, 1, 'The failed load wait must not replay navigation')
    await testPage.evaluate(() => setTimeout(() => history.replaceState(null, '', '#old-document'), 100))
    assert.equal((await command('navigate', { url: url + '/uncommitted', expected_revision: clicked.revision })).error,
      '网页加载失败，请检查地址或稍后刷新', 'An old readable page must not hide a pre-commit timeout')
    assert.ok(testPage.url().endsWith('#old-document'), `The previous document must actually change history during the failed request: ${testPage.url()}`)
    console.log(JSON.stringify({ test: 'partial-navigation', realBrowser: true, readableDocument: true,
      loadingNotice: true, freshRevisionInteraction: true, navigationReplays: 0, preCommitFailurePreserved: true,
      loadNoticeRepublished: true, oldDocumentHistoryChangeRejected: true,
      elapsedMs: Date.now() - started }))
  } finally {
    await runtime.shutdown()
    reader.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
