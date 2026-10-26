const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { PassThrough } = require('node:stream')
const { chromium } = require('/opt/office/node/node_modules/playwright')
const { WebSocketServer } = require('/opt/office/node/node_modules/ws')
const { runWorker } = require('/opt/workbench/packages/workbench-adapter/src/browser-worker.cjs')
const { startDisplay } = require('/opt/workbench/packages/workbench-adapter/src/browser-display.cjs')

async function main() {
  const input = new PassThrough(), output = new PassThrough(), pending = new Map()
  let buffer = '', sequence = 0, target, display, viewer, socket, connection = 0
  output.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (event.type !== 'result') continue
      const request = pending.get(event.id); pending.delete(event.id)
      event.error ? request.reject(Error(event.error)) : request.resolve(event.value)
    }
  })
  const call = async (action, extra = {}) => {
    const id = ++sequence
    let timeout
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject})
        timeout = setTimeout(() => reject(Error(`Pointer smoke timed out: ${action}`)), 30000)
        input.write(JSON.stringify({id, action, ...extra}) + '\n')
      })
    } finally { clearTimeout(timeout); pending.delete(id) }
  }
  const wrapped = {launch: async args => {
    const browser = await chromium.launch(args), newContext = browser.newContext.bind(browser)
    browser.newContext = async options => {
      const context = await newContext(options), newPage = context.newPage.bind(context)
      context.newPage = async () => { target = await newPage(); return target }
      return context
    }
    return browser
  }}
  const worker = runWorker({chromium: wrapped, input, output, exit: () => {}, displayFactory: async options => {
    display = await startDisplay({...options, emit: async event => {
      if (event.connection !== String(connection)) return
      if (event.event === 'data' && socket?.readyState === 1) socket.send(Buffer.from(event.data, 'base64'))
      if (event.event === 'close') socket?.close()
    }})
    return display
  }})
  const server = createServer((request, response) => {
    if (request.url === '/client.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end(readFileSync(process.env.BROWSER_CLIENT_SOURCE || '/tmp/workbench-browser-client.js'))
      return
    }
    response.setHeader('content-type', 'text/html')
    if (request.url === '/viewer') response.end(`<!doctype html><style>body{margin:0}canvas[style*="cursor: none"]{cursor:default!important}</style>
      <div id="screen" style="width:800px;height:600px"></div><textarea id="keyboard"></textarea>
      <script type="module">import {RFB} from '/client.js';
      const screen=document.querySelector('#screen');
      window.rfb=new RFB(screen,document.querySelector('#keyboard'),'ws://'+location.host,{shared:true,hiDpi:false},[]);
      Object.assign(rfb,{viewOnly:true,resizeSession:false,frameRate:30,enableWebRTC:false,enableQOI:false,enableWebP:false,threading:false,scaleViewport:true});
      window.frameCount=0;rfb.addEventListener('frame',()=>frameCount++);
      screen.addEventListener('pointermove',event=>window.moveRemote(event.clientX,event.clientY));</script>`)
    else response.end('<!doctype html><style>body{margin:0;background:white;width:100vw;height:100vh}</style><script>window.lastMove=null;window.clicks=0;addEventListener("mousemove",e=>lastMove=[e.clientX,e.clientY]);addEventListener("click",()=>clicks++);</script>')
  })
  const sockets = new WebSocketServer({server})
  sockets.on('connection', current => {
    socket = current
    const id = String(++connection)
    current.on('message', data => display.write(id, data.toString('base64')))
    current.on('close', () => display.close(id))
    display.open(id)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    await call('init', {width:800,height:600})
    await call('navigate', {url:base})
    viewer = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
    const page = await viewer.newPage({viewport:{width:800,height:600}})
    await page.exposeFunction('moveRemote', (x,y) => call('move',{x,y}))
    for (const scale of [1,1.5,2]) {
      await call('resize',{width:800,height:600,device_scale_factor:scale})
      await page.goto(base + '/viewer')
      await page.waitForFunction(() => window.frameCount > 0)
      // Kasm may switch to a rendered remote cursor after a second without RFB input.
      await page.waitForTimeout(1200)
      for (const [x,y] of [[100,100],[650,450]]) {
        await page.mouse.move(x,y)
        await target.waitForFunction(([x,y]) => lastMove?.[0] === x && lastMove?.[1] === y, [x,y])
        const cursor = await page.evaluate(() => {
          const canvas = document.querySelector('#screen canvas')
          const data = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data
          let darkPixels = 0
          for (let i=0;i<data.length;i+=4) if (data[i+3] && Math.min(data[i],data[i+1],data[i+2]) < 128) darkPixels++
          return {darkPixels,cursor:getComputedStyle(canvas).cursor}
        })
        assert.equal(cursor.darkPixels, 0, `DPR ${scale}: a stationary X cursor must not be baked into webpage pixels`)
        assert.equal(cursor.cursor, 'default', 'An empty remote cursor must leave the local pointer visible')
      }
      await call('pointer-down',{x:650,y:450,button:'left',count:1})
      await call('pointer-up',{x:650,y:450,button:'left',count:1})
    }
    assert.equal(await target.evaluate(() => clicks), 3)
    console.log('PASS actual RFB pixels: no stationary desktop arrow; local pointer and CDP movement/clicks survive idle, reconnect and DPR 1/1.5/2')
  } finally {
    await viewer?.close(); await worker.shutdown()
    for (const current of sockets.clients) current.terminate()
    await new Promise(resolve => sockets.close(resolve))
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => {console.error(error);process.exitCode=1})
