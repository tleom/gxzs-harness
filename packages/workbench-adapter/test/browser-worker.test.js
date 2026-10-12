import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
const { createImageCapture, runWorker } = createRequire(import.meta.url)('../src/browser-worker.cjs')

it('reduces oversized images, reuses the successful quality, and resets it on navigation', async () => {
  let url = 'https://example.com'
  const page = { url: () => url, viewportSize: () => ({width:1920,height:1080}),
    screenshot: vi.fn(async ({quality}) => Buffer.alloc(quality > 30 ? 1100000 : 700000)) }
  const capture = createImageCapture()
  expect((await capture(page)).length).toBe(700000)
  expect(page.screenshot.mock.calls.map(([args]) => args.quality)).toEqual([70,50,30])
  await capture(page)
  expect(page.screenshot).toHaveBeenLastCalledWith({type:'jpeg',quality:30,timeout:5000})
  url = 'https://example.com/next'
  await capture(page)
  expect(page.screenshot.mock.calls.at(-3)[0].quality).toBe(70)
})

function worker() {
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://example.com', viewportSize: () => ({width:1000,height:700}), isClosed: () => false,
    screenshot: vi.fn(async () => Buffer.from('jpeg')), title: async () => 'Example',
    setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(),
    keyboard: {insertText:vi.fn(async()=>{}),press:vi.fn(async()=>{})},
    mouse: {wheel:vi.fn(async()=>{}),move:vi.fn(async()=>{})},
  })
  const context = {route:async()=>{},newPage:async()=>page,newCDPSession:async()=>({send:async()=>({currentIndex:0,entries:[{}]})})}
  const browser = Object.assign(new EventEmitter(), {newContext:async()=>context,close:vi.fn(async()=>{})})
  const input = new PassThrough(), output = new PassThrough(), frames = [], exit = vi.fn()
  output.on('data',chunk=>frames.push(JSON.parse(String(chunk))))
  const runtime = runWorker({chromium:{launch:async()=>browser},input,output,exit})
  const command = async (id,action,extra={}) => {
    input.write(JSON.stringify({id,action,...extra})+'\n')
    await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='result' && frame.id===id)).toBe(true))
  }
  return {page,browser,runtime,frames,exit,command,input}
}

it('acknowledges rapid input without taking a screenshot for every action while streaming', async () => {
  const value = worker()
  try {
    await value.command(1,'init',{width:1000,height:700})
    await value.command(2,'watch',{enabled:true})
    value.page.screenshot.mockClear()
    for (let id=3;id<13;id++) await value.command(id,'text',{text:'字'})
    expect(value.page.keyboard.insertText).toHaveBeenCalledTimes(10)
    expect(value.page.screenshot.mock.calls.length).toBeLessThan(5)
    await vi.waitFor(()=>expect(value.page.screenshot).toHaveBeenCalled())
  } finally { await value.runtime.shutdown() }
})

it.each(['disconnected','crash','close'])('terminates on %s and reports a fatal error instead of leaving stale pixels', async event => {
  const value = worker()
  try {
    await value.command(1,'init',{width:1000,height:700})
    ;(event==='disconnected'?value.browser:value.page).emit(event)
    await vi.waitFor(()=>expect(value.exit).toHaveBeenCalledWith(2))
    expect(value.frames.find(frame=>frame.type==='fatal').error).toContain('重新打开浏览器')
    expect(value.browser.close).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

it('reports an uncompressible frame and exits without claiming initialization succeeded', async () => {
  const value = worker()
  value.page.screenshot.mockImplementation(async()=>Buffer.alloc(1100000))
  try {
    value.input.write(JSON.stringify({id:1,action:'init',width:1000,height:700})+'\n')
    await vi.waitFor(()=>expect(value.exit).toHaveBeenCalledWith(2))
    expect(value.frames.find(frame=>frame.type==='fatal').error).toContain('图像过大')
    expect(value.frames.some(frame=>frame.type==='result' && frame.id===1)).toBe(false)
    expect(value.page.screenshot).toHaveBeenCalledTimes(4)
  } finally { await value.runtime.shutdown() }
})
