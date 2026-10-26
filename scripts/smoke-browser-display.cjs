const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { PassThrough } = require('node:stream')
const { execFileSync } = require('node:child_process')
const { chromium } = require('/opt/office/node/node_modules/playwright')
const { runWorker } = require('/opt/workbench/packages/workbench-adapter/src/browser-worker.cjs')
const { startDisplay } = require('/opt/workbench/packages/workbench-adapter/src/browser-display.cjs')

const probe = String.raw`import ctypes,os,json,sys
x=ctypes.CDLL('libX11.so.6');ptr=ctypes.c_void_p;integer=ctypes.c_int;word=ctypes.c_ulong
x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ptr
x.XDefaultRootWindow.argtypes=[ptr];x.XDefaultRootWindow.restype=word
x.XGetImage.argtypes=[ptr,word,integer,integer,ctypes.c_uint,ctypes.c_uint,word,integer];x.XGetImage.restype=ptr
x.XGetPixel.argtypes=[ptr,integer,integer];x.XGetPixel.restype=word
x.XDestroyImage.argtypes=[ptr];x.XCloseDisplay.argtypes=[ptr]
d=x.XOpenDisplay(os.environ['DISPLAY'].encode());assert d
try:
 root=x.XDefaultRootWindow(d);pixels=[]
 for px,py in [(0,0),(int(sys.argv[1])-int(sys.argv[3]),int(sys.argv[2])-int(sys.argv[3]))]:
  image=x.XGetImage(d,root,px,py,1,1,word(-1).value,2);assert image
  try:pixels.append(x.XGetPixel(image,0,0))
  finally:x.XDestroyImage(image)
 print(json.dumps(pixels))
finally:x.XCloseDisplay(d)`
const pixels = (display, width, height, inset = 1) => JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-c', probe, String(width), String(height), String(inset)], { env: display.env, encoding: 'utf8' }))

async function assertWhiteRoot() {
  const display = await startDisplay({ width: 320, height: 240, emit: async () => {}, onExit: () => {} })
  try {
    assert.deepEqual(pixels(display, 320, 240), [0xffffff, 0xffffff], 'New X display root must be white')
    await display.resize(400, 300)
    assert.deepEqual(pixels(display, 400, 300), [0xffffff, 0xffffff], 'Resized X display root must stay white')
  } finally { await display.stop() }
}

async function main() {
  await assertWhiteRoot()
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/nested') {
      response.end('<!doctype html><style>body{margin:0}.pane{position:absolute;top:80px;width:300px;height:300px;overflow:auto}#left{left:60px}#right{left:450px}.content{height:2000px}</style><input id="leftValue" value="0"><input id="rightValue" value="0"><div class="pane" id="left" onscroll="leftValue.value=this.scrollTop"><div class="content">left</div></div><div class="pane" id="right" onscroll="rightValue.value=this.scrollTop"><div class="content">right</div></div>')
      return
    }
    response.end('<!doctype html><meta charset=utf-8><style>html{scrollbar-width:none}body{background:#fff;height:12000px}#edge{position:fixed;right:0;bottom:0;width:30px;height:30px;background:#c24;border:0;padding:0}</style><input id="value" aria-label="Value"><a id="popup" href="/popup" target="_blank">Open</a><button id="edge" onclick="this.textContent=Number(this.textContent)+1;this.style.background=Number(this.textContent)%2?\'#2c4\':\'#c24\'">0</button>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const input = new PassThrough(), output = new PassThrough(), pending = new Map(), packets = []
  let buffer = '', sequence = 0
  output.on('data', chunk => {
    buffer += chunk
    let boundary
    while ((boundary = buffer.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1)
      if (frame.type === 'result') {
        const task = pending.get(frame.id)
        pending.delete(frame.id)
        frame.error ? task?.reject(new Error(`${task.action}: ${frame.error}`)) : task?.resolve(frame.value)
      } else if (frame.type === 'display') packets.push(frame)
      else if (frame.type === 'fatal') for (const task of pending.values()) task.reject(new Error(frame.error))
    }
  })
  let display
  const worker = runWorker({ chromium, input, output, exit: () => {},
    displayFactory: async options => { display = await startDisplay(options); return display } })
  async function call(action, value = {}) {
    const id = ++sequence
    let timer
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, action })
        timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser smoke timed out: ${action}`)) }, 30000)
        input.write(JSON.stringify({ id, action, ...value }) + '\n')
      })
    } finally { clearTimeout(timer) }
  }
  try {
    const initialized = await call('init', { width: 1000, height: 700 })
    assert.equal(initialized.display, 'kasm')
    await call('navigate', { url: `http://127.0.0.1:${server.address().port}` })
    await call('resize', { width: 823, height: 617 })
    await call('element-text', { selector: '#value', text: '可见浏览器中文验收' })
    const snapshot = await call('snapshot')
    assert.equal(snapshot.viewport.width, 823)
    assert.equal(snapshot.viewport.height, 617)
    assert.equal(snapshot.elements.find(element => element.selector === '#value').value, '可见浏览器中文验收')
    await call('wheel', { x: 0, y: 2000, modifiers: [] })
    await new Promise(resolve => setTimeout(resolve, 150))
    let clicks = 0
    for (const [width, height, scale = 1] of [[320, 240], [361, 521], [499, 544], [500, 521], [1920, 1080], [1174, 681, 2.2], [1740, 810, 2.2], [1280, 720, 3], [320, 240], [823, 617]]) {
      await call('resize', { width, height, device_scale_factor: scale })
      // A transient matching size must not hide a later minimum-window clamp.
      await new Promise(resolve => setTimeout(resolve, 250))
      await call('wheel', { x: 0, y: 200, modifiers: [] })
      await new Promise(resolve => setTimeout(resolve, 100))
      const resized = await call('snapshot')
      assert.equal(resized.viewport.width, width)
      assert.equal(resized.viewport.height, height)
      assert.equal(resized.notice, undefined)
      if (scale !== 1) {
        const shot = Buffer.from((await call('screenshot')).image, 'base64')
        assert.equal(shot.readUInt32BE(16), Math.round(width * scale))
        assert.equal(shot.readUInt32BE(20), Math.round(height * scale))
      }
      await call('element-click', { selector: '#edge', expected_revision: resized.revision })
      clicks++
      assert.equal((await call('snapshot')).elements.find(element => element.selector === '#edge').label, String(clicks))
      const expected = clicks % 2 ? 0x22cc44 : 0xcc2244
      let actual
      for (let attempt = 0; attempt < 30; attempt++) {
        actual = pixels(display, Math.round(width * scale), Math.round(height * scale), 8)
        if (actual[1] === expected) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.deepEqual(actual, [0xffffff, expected], 'Layout and edge clicks must match actual desktop pixels')
      // The viewer reuses the CSS-coordinate pointer actions, in the same queue as keyboard input.
      await call('pointer-down', { x: width - 8, y: height - 8, button: 'left', count: 1 })
      await call('pointer-up', { x: width - 8, y: height - 8, button: 'left', count: 1 })
      clicks++
      let nativeSnapshot
      for (let attempt = 0; attempt < 30; attempt++) {
        nativeSnapshot = await call('snapshot')
        if (nativeSnapshot.elements.find(element => element.selector === '#edge').label === String(clicks)) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(nativeSnapshot.elements.find(element => element.selector === '#edge').label, String(clicks), 'Viewer pointer coordinates must match adaptive desktop pixels')
    }
    await call('resize', { width: 361, height: 521 })
    await call('navigate', { url: `http://127.0.0.1:${server.address().port}/next` })
    const navigated = await call('snapshot')
    assert.deepEqual(navigated.viewport, { x: 0, y: 0, width: 361, height: 521 })
    await call('element-click', { selector: '#popup', expected_revision: navigated.revision })
    let popup = await call('snapshot')
    // The target-created event can arrive after the input acknowledgement.
    for (let attempt = 0; attempt < 50 && !popup.url.endsWith('/popup'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      popup = await call('snapshot')
    }
    assert(popup.url.endsWith('/popup'))
    assert.equal(popup.page_id, navigated.page_id)
    assert.deepEqual(popup.viewport, { x: 0, y: 0, width: 361, height: 521 })
    await call('element-text', { selector: '#value', text: '可见浏览器中文验收' })
    await call('resize', { width: 823, height: 617 })
    const connection = '12345678-1234-1234-1234-123456789abc'
    await call('display-open', { connection })
    for (let attempt = 0; attempt < 100 && !packets.some(packet => packet.event === 'data'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 20))
    assert(packets.some(packet => packet.event === 'open'))
    const greeting = Buffer.from(packets.find(packet => packet.event === 'data')?.data || '', 'base64').toString()
    assert.match(greeting, /^RFB /)
    await call('display-close', { connection })
    assert.equal((await call('snapshot')).elements[0].value, '可见浏览器中文验收')
    await call('navigate', {url:`http://127.0.0.1:${server.address().port}/nested`})
    await call('move', {x:200,y:200})
    await call('wheel', {x:0,y:200,position:{x:600,y:200}})
    let nested
    for (let attempt = 0; attempt < 30; attempt++) {
      nested = await call('snapshot')
      if (nested.elements.find(element => element.selector === '#rightValue')?.value === '200') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(nested.elements.find(element => element.selector === '#leftValue').value, '0')
    assert.equal(nested.elements.find(element => element.selector === '#rightValue').value, '200')
    console.log('PASS wheel over a nested pane ignores the stale pointer location')
    console.log('PASS private Kasm display: narrow/wide and native-density 4K resize, desktop pixels and edge clicks after AI screenshots, AI Unicode edit, RFB handshake and view-only disconnect')
  } finally {
    await worker.shutdown()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
