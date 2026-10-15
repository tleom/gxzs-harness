const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { chromium } = require('/opt/office/node/node_modules/playwright')

async function main() {
  const source = readFileSync('/tmp/workbench-browser-client.js')
  const server = createServer((request, response) => {
    if (request.url === '/client.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(source)
    } else {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><div id="screen" style="width:800px;height:600px"></div><textarea id="keyboard"></textarea><script type="module">import {RFB} from "/client.js";window.Client=RFB;</script>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.Client)
    const result = await page.evaluate(async () => {
      const writes = []
      const channel = { readyState: 1, protocol: 'binary', binaryType: 'arraybuffer',
        onopen: null, onmessage: null, onerror: null, onclose: null,
        send: data => writes.push(Array.from(new Uint8Array(data))),
        close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000, wasClean: true })) } }
      const rfb = new window.Client(document.querySelector('#screen'), document.querySelector('#keyboard'), channel,
        { shared: true, hiDpi: true }, [])
      Object.assign(rfb, { resizeSession: false, enableWebRTC: false, enableQOI: false, threading: false,
        clipboardBinary: false, clipboardSeamless: false })
      let connected = false, disconnected = false
      rfb.addEventListener('connect', () => { connected = true })
      rfb.addEventListener('disconnect', () => { disconnected = true })
      const tick = () => new Promise(resolve => setTimeout(resolve, 30))
      const receive = async bytes => { channel.onmessage({ data: Uint8Array.from(bytes).buffer }); await tick() }
      await tick()
      await receive(Array.from(new TextEncoder().encode('RFB 003.008\n')))
      await receive([1, 1])
      await receive([0, 0, 0, 0])
      await receive([3, 32, 2, 88, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0, 0, 0, 0, 4, 116, 101, 115, 116])
      const start = writes.length
      // No following network packet is allowed to rescue this parse. The real
      // server can wait forever for the fence reply in this single message.
      await receive([184, 0, 248, 0, 0, 0, 128, 0, 0, 0, 0])
      const coalescedFenceReplied = writes.slice(start).some(bytes => bytes[0] === 248)
      const partialStart = writes.length
      await receive([184])
      const incompleteDidNotReply = writes.length === partialStart
      await receive([0, 248, 0, 0, 0, 128, 0, 0, 0, 0])
      const fragmentedFenceReplied = writes.slice(partialStart).some(bytes => bytes[0] === 248)
      rfb.disconnect()
      return { connected, disconnected, coalescedFenceReplied, incompleteDidNotReply, fragmentedFenceReplied }
    })
    assert.equal(result.connected, true)
    assert.equal(result.disconnected, false)
    assert.equal(result.coalescedFenceReplied, true, 'Coalesced encoder capabilities must not strand the ServerFence')
    assert.equal(result.incompleteDidNotReply, true)
    assert.equal(result.fragmentedFenceReplied, true)
    console.log('PASS bundled Kasm client: coalesced and fragmented encoder capabilities continue through ServerFence without another packet')
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
