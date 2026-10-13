const assert = require('node:assert/strict')
const { chromium } = require('/opt/office/node/node_modules/playwright')
const { observePage } = require('/opt/workbench/packages/workbench-adapter/src/browser-worker.cjs')

async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage({ viewport: { width: 500, height: 400 } })
    const nested = '<div>'.repeat(20)+'<button onclick="this.textContent=\'Deep clicked\'">Deep control</button>'+'</div>'.repeat(20)
    const html = `<html><head><title>Initial</title><style>body{margin:0;font:20px monospace;line-height:25px} .fixed{position:fixed;top:100px;left:300px} p{width:250px} .row{height:30px}</style></head><body>${Array.from({length:150},(_,i)=>`<div class="row"><button>Row ${i}</button></div>`).join('')}<aside class="fixed">${nested}</aside><p>${'paragraph content '.repeat(5000)}BOTTOM_MARKER</p><button>Bottom control</button></body></html>`
    await page.route('http://fixture.test/**', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto('http://fixture.test/')
    const top = await page.evaluate(observePage)
    assert(!top.text.includes('BOTTOM_MARKER'))
    const deep = top.elements.find(element => element.label === 'Deep control')
    assert(deep, 'A deeply nested visible control after 150 DOM controls must remain addressable')
    await page.locator(deep.selector).click()
    assert.equal(await page.locator(deep.selector).innerText(), 'Deep clicked')
    await page.locator('p').scrollIntoViewIfNeeded()
    await page.evaluate(() => { scrollTo(0,document.body.scrollHeight); history.replaceState(null,'','/updated'); document.title='Updated' })
    const bottom = await page.evaluate(observePage)
    assert(bottom.text.includes('BOTTOM_MARKER'), 'Scrolling must reveal the tail of a single long text node')
    assert(bottom.elements.some(element => element.label === 'Bottom control'))
    assert(!bottom.elements.some(element => element.label === 'Row 0'))
    assert.equal(bottom.url, 'http://fixture.test/updated')
    assert.equal(bottom.title, 'Updated')
    assert(bottom.viewport.y > 0 && bottom.text.length <= 20000)
    console.log('PASS real browser observation: viewport text, long paragraph tail, deep selectors, off-screen controls and current SPA metadata')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode=1 })
