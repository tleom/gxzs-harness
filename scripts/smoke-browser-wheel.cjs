const assert = require('node:assert/strict')
const {createServer} = require('node:http')
const {PassThrough} = require('node:stream')
const {chromium} = require('/opt/office/node/node_modules/playwright')
const {runWorker} = require('/opt/workbench/packages/workbench-adapter/src/browser-worker.cjs')
const {startDisplay} = require('/opt/workbench/packages/workbench-adapter/src/browser-display.cjs')

async function main() {
  const input = new PassThrough(), output = new PassThrough(), pending = new Map()
  let sequence = 0, buffer = '', page
  output.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (event.type !== 'result') continue
      const request = pending.get(event.id); pending.delete(event.id)
      if (request) event.error ? request.reject(Error(`${request.action}: ${event.error}`)) : request.resolve(event.value)
    }
  })
  const call = async (action, value = {}) => {
    const id = ++sequence
    let timeout
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject, action})
        timeout = setTimeout(() => reject(Error(`Wheel smoke timed out: ${action}`)), 30000)
        input.write(JSON.stringify({id, action, ...value}) + '\n')
      })
    } finally { clearTimeout(timeout); pending.delete(id) }
  }
  const wrapped = {launch: async args => {
    const browser = await chromium.launch(args), newContext = browser.newContext.bind(browser)
    browser.newContext = async options => {
      const context = await newContext(options)
      context.on('page', target => { page = target })
      return context
    }
    return browser
  }}
  const worker = runWorker({chromium: wrapped, input, output, exit: () => {}, displayFactory: startDisplay})
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><style>body{margin:24px;height:4500px}.panes{display:flex;gap:30px;padding-top:80px}.pane{height:210px;width:220px;overflow:auto;border:2px solid #ddd;flex-shrink:0}.content{height:2600px}</style><div class=panes><div class=pane id=left><div class=content>left</div></div><div class=pane id=right><div class=content>right</div></div></div><script>window.wheels=[];window.blockWheel=false;addEventListener("wheel",e=>{wheels.push([e.clientX,e.clientY]);if(blockWheel)e.preventDefault()},{passive:false})</script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await call('init', {width:1000,height:700})
    for (const [width,height,scale] of [[573,522,1.25],[573,521,1.5],...[1,1.25,1.5,2,2.2,1].map(scale=>[660,546,scale])]) {
      await call('resize', {width,height,device_scale_factor:scale})
      for (const [x, expected] of [[140,[200,0,0]],[390,[0,200,0]],[543,[0,0,200]]]) {
        await call('navigate', {url:`http://127.0.0.1:${server.address().port}/`})
        await call('wheel', {x:0,y:200,position:{x,y:180}})
        await page.waitForFunction(expected => [left.scrollTop,right.scrollTop,scrollY].every((value,i) => Math.abs(value-expected[i]) < 1), expected, {timeout:3000})
        assert.deepEqual(await page.evaluate(() => wheels), [[x,180]], `DPR ${scale}: wheel coordinates`)
        await call('navigate', {url:`http://127.0.0.1:${server.address().port}/`})
        await page.evaluate(() => { blockWheel = true })
        await call('wheel', {x:0,y:200,position:{x,y:180}})
        await new Promise(resolve => setTimeout(resolve,100))
        assert.deepEqual(await page.evaluate(() => [left.scrollTop,right.scrollTop,scrollY]), [0,0,0], 'Page cancellation must retain native wheel semantics')
      }
    }
    console.log('PASS native DPI wheel: left/right panes and root, exact DOM coordinates, cancellation, density changes and restoration')
  } finally {
    await worker.shutdown()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
