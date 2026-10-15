const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { PassThrough } = require('node:stream')
const { execFileSync } = require('node:child_process')
const { chromium } = require('/opt/office/node/node_modules/playwright')
const { runWorker } = require('/opt/workbench/packages/workbench-adapter/src/browser-worker.cjs')
const { startDisplay } = require('/opt/workbench/packages/workbench-adapter/src/browser-display.cjs')

async function assertWhiteRoot() {
  const display = await startDisplay({ width: 320, height: 240, emit: async () => {}, onExit: () => {} })
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
 for px,py in [(0,0),(int(sys.argv[1])-1,int(sys.argv[2])-1)]:
  image=x.XGetImage(d,root,px,py,1,1,word(-1).value,2);assert image
  try:pixels.append(x.XGetPixel(image,0,0))
  finally:x.XDestroyImage(image)
 print(json.dumps(pixels))
finally:x.XCloseDisplay(d)`
  const pixels = (width, height) => JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-c', probe, String(width), String(height)], { env: display.env, encoding: 'utf8' }))
  try {
    assert.deepEqual(pixels(640, 480), [0xffffff, 0xffffff], 'New X display root must be white')
    await display.resize(400, 300)
    assert.deepEqual(pixels(800, 600), [0xffffff, 0xffffff], 'Resized X display root must stay white')
  } finally { await display.stop() }
}

async function main() {
  await assertWhiteRoot()
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><meta charset=utf-8><input id="value" aria-label="Value">')
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
  const worker = runWorker({ chromium, input, output, exit: () => {} })
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
    const connection = '12345678-1234-1234-1234-123456789abc'
    await call('display-open', { connection })
    for (let attempt = 0; attempt < 100 && !packets.some(packet => packet.event === 'data'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 20))
    assert(packets.some(packet => packet.event === 'open'))
    const greeting = Buffer.from(packets.find(packet => packet.event === 'data')?.data || '', 'base64').toString()
    assert.match(greeting, /^RFB /)
    await call('display-close', { connection })
    assert.equal((await call('snapshot')).elements[0].value, '可见浏览器中文验收')
    console.log('PASS private Kasm display: visible Chromium, arbitrary resize, AI Unicode edit, RFB handshake and view-only disconnect')
  } finally {
    await worker.shutdown()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
