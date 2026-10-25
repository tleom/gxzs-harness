const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { chromium } = require('/opt/office/node/node_modules/playwright')
const { createBrowserDownloads } = require('/opt/workbench/packages/workbench-adapter/src/browser-downloads.cjs')

async function main() {
  const names = ['report.docx', '中文 报告.pdf', '中文 报告.pdf']
  const bytes = Buffer.from('native-ssh-download-regression\n')
  const root = await mkdtemp('/tmp/browser-download-smoke-')
  const files = []
  const downloads = createBrowserDownloads({ workspace: root, report: value => { if (value.download) files.push(value.download) } })
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(names[Number(request.url.slice(1))])}` })
    response.end(bytes)
  })
  let browser
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const context = await browser.newContext({ locale: 'zh-CN', acceptDownloads: true })
    const page = await context.newPage()
    for (let index = 0; index < names.length; index++) {
      const received = page.waitForEvent('download')
      await page.goto(`http://127.0.0.1:${server.address().port}/${index}`).catch(error => assert.match(error.message, /ERR_ABORTED|Download is starting/))
      const download = await received
      assert.equal(download.suggestedFilename(), names[index], 'The authenticated SSH environment must preserve Unicode browser filenames')
      await downloads.start(download)
      const file = files.at(-1)
      assert.equal(file.path, `Download/${index === 2 ? '中文 报告 (1).pdf' : names[index]}`)
      assert.deepEqual(await readFile(join(root, file.path)), bytes)
    }
    console.log('PASS native SSH browser downloads: original Unicode names, extensions, direct directory, duplicate names and complete bytes')
  } finally {
    await downloads.close()
    await browser?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
