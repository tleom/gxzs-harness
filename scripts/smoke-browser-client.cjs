const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/office/node/node_modules/playwright')

async function main() {
  const source = readFileSync(process.env.BROWSER_CLIENT_SOURCE || '/tmp/workbench-browser-client.js')
  const server = createServer((request, response) => {
    if (request.url === '/client.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(source)
    } else {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><div id="screen" style="width:800px;height:600px;background:#fff"></div><textarea id="keyboard"></textarea><script type="module">import {RFB} from "/client.js";window.Client=RFB;</script>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction(() => window.Client)
    const result = await page.evaluate(async () => {
      const peers = []
      const NativePeer = window.RTCPeerConnection
      window.RTCPeerConnection = class extends NativePeer {
        constructor(...args) { super(...args); peers.push(this) }
      }
      const writes = []
      const channel = { readyState: 1, protocol: 'binary', binaryType: 'arraybuffer',
        onopen: null, onmessage: null, onerror: null, onclose: null,
        send: data => writes.push(Array.from(new Uint8Array(data))),
        close() { this.readyState = 3; queueMicrotask(() => this.onclose?.({ code: 1000, wasClean: true })) } }
      const rfb = new window.Client(document.querySelector('#screen'), document.querySelector('#keyboard'), channel,
        { shared: true, hiDpi: true }, [])
      Object.assign(rfb, { resizeSession: false, background: '#fff', enableWebRTC: false, enableQOI: false, threading: false,
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
      const screen = document.querySelector('#screen')
      const canvas = [...screen.querySelectorAll('canvas')].find(value => value.width > 0 && value.height > 0)
      const context = canvas.getContext('2d')
      const initialPixelsTransparent = context.getImageData(1, 1, 1, 1).data[3] === 0
      context.fillStyle = '#000'
      context.fillRect(0, 0, 1, 1)
      // Exercise the real pinned renderer's viewport operation directly, without
      // making this pixel regression depend on the outer viewer's ResizeObserver.
      rfb._display._renderer.viewportChangeSize(400, 300)
      rfb._display._renderer.viewportChangeSize(600, 400)
      const resetPixelsTransparent = context.getImageData(599, 399, 1, 1).data[3] === 0
      const websiteBlackPixelPreserved = [...context.getImageData(0, 0, 1, 1).data].join(',') === '0,0,0,255'
      const whiteBackdrop = getComputedStyle(screen).backgroundColor === 'rgb(255, 255, 255)'
      const disabledWebRtcAllocatedNoPeers = peers.length === 0
      rfb.disconnect()
      const initialDisconnected = disconnected
      await tick()
      for (let i = 0; i < 20; i++) {
        const nextChannel = { ...channel, readyState: 1, onclose: null }
        const next = new window.Client(screen, document.querySelector('#keyboard'), nextChannel,
          { shared: true, hiDpi: true }, [])
        Object.assign(next, { enableWebRTC: false, enableQOI: false, threading: false })
        await tick()
        next.disconnect()
        await tick()
      }
      const reconnectsAllocatedNoPeers = peers.length === 0
      const reconnectsRemovedCanvases = screen.querySelectorAll('canvas').length === 0
      const rtcChannel = { ...channel, readyState: 1, onclose: null }
      const rtc = new window.Client(screen, document.querySelector('#keyboard'), rtcChannel,
        { shared: true, hiDpi: true }, [])
      await tick()
      const peer = peers.at(-1), dataChannel = rtc._udpChannel
      rtc.disconnect()
      await tick()
      const enabledWebRtcClosed = peer?.connectionState === 'closed' && dataChannel?.readyState === 'closed'
      const upgradeCancelled = rtc._udpPeer === null && rtc._udpChannel === null
      return { connected, disconnected: initialDisconnected, coalescedFenceReplied, incompleteDidNotReply, fragmentedFenceReplied,
        initialPixelsTransparent, resetPixelsTransparent, websiteBlackPixelPreserved, whiteBackdrop,
        disabledWebRtcAllocatedNoPeers, reconnectsAllocatedNoPeers, reconnectsRemovedCanvases, enabledWebRtcClosed, upgradeCancelled }
    })
    assert.equal(result.connected, true)
    assert.equal(result.disconnected, false)
    assert.equal(result.coalescedFenceReplied, true, 'Coalesced encoder capabilities must not strand the ServerFence')
    assert.equal(result.incompleteDidNotReply, true)
    assert.equal(result.fragmentedFenceReplied, true)
    assert.equal(result.initialPixelsTransparent, true, 'Unpainted canvas must reveal the white backdrop')
    assert.equal(result.resetPixelsTransparent, true, 'Resizing must reveal the white backdrop in newly uncovered areas')
    assert.equal(result.websiteBlackPixelPreserved, true)
    assert.equal(result.whiteBackdrop, true)
    for (const key of ['disabledWebRtcAllocatedNoPeers', 'reconnectsAllocatedNoPeers', 'reconnectsRemovedCanvases', 'enabledWebRtcClosed', 'upgradeCancelled'])
      assert.equal(result[key], true, key)
    console.log('PASS bundled Kasm client: coalesced/fragmented ServerFence; initial and resized white backdrop; actual black webpage pixels preserved')
    console.log('PASS 20 reconnects: no unused WebRTC peers or retained canvases; enabled WebRTC peer and channel close on disconnect')
  } finally {
    await browser?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
