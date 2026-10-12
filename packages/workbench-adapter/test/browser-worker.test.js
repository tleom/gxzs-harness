import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
const { createImageCapture, runWorker } = createRequire(import.meta.url)('../src/browser-worker.cjs')

it('reduces oversized images, reuses the successful quality, and resets it on navigation', async () => {
  let url = 'https://example.com'
  const page = { url: () => url, viewportSize: () => ({width:1920,height:1080}),
    screenshot: vi.fn(async ({quality}) => Buffer.alloc(quality > 30 ? 1100000 : 700000)) }
  const capture = createImageCapture({now:()=>0})
  expect((await capture(page)).length).toBe(700000)
  expect(page.screenshot.mock.calls.map(([args]) => args.quality)).toEqual([70,50,30])
  await capture(page)
  expect(page.screenshot).toHaveBeenLastCalledWith({type:'jpeg',quality:30,timeout:8000})
  url = 'https://example.com/next'
  await capture(page)
  expect(page.screenshot.mock.calls.at(-3)[0].quality).toBe(70)
})

it('shares one bounded screenshot deadline across quality retries', async () => {
  let elapsed = 0
  const page = {url:()=> 'https://example.com', viewportSize:()=>({width:1000,height:700}),
    screenshot:vi.fn(async()=> { elapsed+=2000; return Buffer.alloc(1100000) })}
  await expect(createImageCapture({now:()=>elapsed,budgetMs:5000})(page)).rejects.toThrow('capture_timeout')
  expect(page.screenshot.mock.calls.map(([value])=>value.timeout)).toEqual([5000,3000,1000])
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
  return {page,browser,runtime,frames,exit,command,input,context}
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

it('bounds untrusted titles before emitting a frame', async () => {
  const value = worker()
  value.page.title = async()=> '标题'.repeat(1000000)
  try {
    await value.command(1,'init',{width:1000,height:700})
    expect(value.frames.find(frame=>frame.type==='frame').title.length).toBe(1024)
    expect(Buffer.byteLength(JSON.stringify(value.frames.find(frame=>frame.type==='frame')),'utf8')).toBeLessThan(10000)
  } finally { await value.runtime.shutdown() }
})

it('rejects initialization without a first frame rather than leaving the client connecting forever', async () => {
  const value=worker()
  value.page.screenshot.mockRejectedValue(new Error('screenshot unavailable'))
  try {
    await value.command(1,'init',{width:1000,height:700})
    expect(value.frames.find(frame=>frame.type==='result' && frame.id===1).error).toContain('重新打开浏览器')
    expect(value.frames.some(frame=>frame.type==='frame')).toBe(false)
  } finally { await value.runtime.shutdown() }
})

it('invalidates the live stream when screenshot timeouts would otherwise leave stale pixels', async () => {
  const value=worker()
  try {
    await value.command(1,'init',{width:1000,height:700})
    const timeout=new Error('screenshot timeout'); timeout.name='TimeoutError'
    value.page.screenshot.mockRejectedValue(timeout)
    value.input.write(JSON.stringify({id:2,action:'watch',enabled:true})+'\n')
    await vi.waitFor(()=>expect(value.exit).toHaveBeenCalledWith(2))
    expect(value.frames.find(frame=>frame.type==='fatal').error).toContain('超时')
  } finally { await value.runtime.shutdown() }
})

it('rejects an already-navigated non-HTTP popup without replacing the current page', async () => {
  const value=worker()
  try {
    await value.command(1,'init',{width:1000,height:700})
    const popup={url:()=> 'blob:https://example.com/document',close:vi.fn(async()=>{})}
    value.page.emit('popup',popup)
    await vi.waitFor(()=>expect(popup.close).toHaveBeenCalledOnce())
    await value.command(2,'watch',{enabled:true})
    expect(value.frames.filter(frame=>frame.type==='frame').at(-1).url).toBe('https://example.com')
    expect(value.browser.close).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('revalidates a popup after async binding and retains the original CDP session when rejecting it', async () => {
  const value=worker()
  let url='about:blank', finishBind
  const popup=Object.assign(new EventEmitter(), {url:()=>url,setDefaultTimeout:vi.fn(),setDefaultNavigationTimeout:vi.fn(),close:vi.fn(async()=>{})})
  const mainHistory=vi.fn(async()=>({currentIndex:0,entries:[{}]}))
  const popupHistory=vi.fn(async()=>{throw new Error('wrong page session')}),detach=vi.fn(async()=>{})
  value.context.newCDPSession=async target=>target===popup ? new Promise(resolve=>{finishBind=resolve}) : {send:mainHistory}
  try {
    await value.command(1,'init',{width:1000,height:700})
    value.page.emit('popup',popup)
    url='blob:https://example.com/redirect'
    finishBind({send:popupHistory,detach})
    await vi.waitFor(()=>expect(popup.close).toHaveBeenCalledOnce())
    expect(detach).toHaveBeenCalledOnce()
    await value.command(2,'watch',{enabled:true})
    expect(value.frames.filter(frame=>frame.type==='frame').at(-1).url).toBe('https://example.com')
    expect(mainHistory.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(popupHistory).not.toHaveBeenCalled()
    expect(value.browser.close).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('does not adopt a popup that closes while binding', async () => {
  const value=worker()
  let finishBind
  const detach=vi.fn(async()=>{})
  const popup=Object.assign(new EventEmitter(), {url:()=> 'https://example.com/popup',isClosed:()=>true,setDefaultTimeout:vi.fn(),setDefaultNavigationTimeout:vi.fn(),close:vi.fn(async()=>{})})
  const original=value.context.newCDPSession
  value.context.newCDPSession=async target=>target===popup ? new Promise(resolve=>{finishBind=resolve}) : original(target)
  try {
    await value.command(1,'init',{width:1000,height:700})
    value.page.emit('popup',popup)
    finishBind({detach,send:async()=>{throw new Error('closed popup')}})
    await vi.waitFor(()=>expect(detach).toHaveBeenCalledOnce())
    await value.command(2,'watch',{enabled:true})
    expect(value.frames.filter(frame=>frame.type==='frame').at(-1).url).toBe('https://example.com')
    expect(value.browser.close).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('discards the pre-resize capture and emits matching dimensions before acknowledging resize', async () => {
  const value=worker()
  let size={width:1000,height:700}, finishImage
  value.page.viewportSize=()=>size
  value.page.setViewportSize=async value=>{size=value}
  try {
    await value.command(1,'init',{width:1000,height:700})
    await value.command(2,'watch',{enabled:true})
    value.page.screenshot.mockImplementationOnce(()=>new Promise(resolve=>{finishImage=resolve}))
    await vi.waitFor(()=>expect(finishImage).toBeTypeOf('function'))
    value.frames.length=0
    value.input.write(JSON.stringify({id:3,action:'resize',width:800,height:600})+'\n')
    await vi.waitFor(()=>expect(size).toEqual({width:800,height:600}))
    finishImage(Buffer.from('stale-image'))
    await vi.waitFor(()=>expect(value.frames.some(frame=>frame.type==='result' && frame.id===3)).toBe(true))
    const frames=value.frames.filter(frame=>frame.type==='frame')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame=>frame.width===800 && frame.height===600)).toBe(true)
    expect(value.frames.findIndex(frame=>frame.type==='frame')).toBeLessThan(value.frames.findIndex(frame=>frame.id===3))
  } finally { await value.runtime.shutdown() }
})

it('retries after a superseded watcher capture times out during navigation instead of killing the new page', async () => {
  const value=worker()
  let finishNavigation,rejectImage,url='https://example.com'
  value.page.url=()=>url
  value.page.goto=async()=>new Promise(resolve=>{finishNavigation=resolve})
  try {
    await value.command(1,'init',{width:1000,height:700})
    await value.command(2,'watch',{enabled:true})
    value.page.screenshot.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectImage=reject}))
    await vi.waitFor(()=>expect(rejectImage).toBeTypeOf('function'))
    value.input.write(JSON.stringify({id:3,action:'navigate',url:'https://example.com/new'})+'\n')
    await vi.waitFor(()=>expect(finishNavigation).toBeTypeOf('function'))
    const timeout=new Error('old capture timeout');timeout.name='TimeoutError'
    rejectImage(timeout)
    await Promise.resolve()
    url='https://example.com/new';finishNavigation()
    await vi.waitFor(()=>expect(value.frames.some(frame=>frame.type==='result'&&frame.id===3)).toBe(true))
    expect(value.frames.filter(frame=>frame.type==='frame').at(-1).url).toBe(url)
    expect(value.frames.some(frame=>frame.type==='fatal')).toBe(false)
  } finally { await value.runtime.shutdown() }
})

it('retries a resized frame discarded by navigation and publishes matching dimensions before acknowledging', async () => {
  const value=worker()
  let size={width:1000,height:700},url='https://example.com'
  value.page.viewportSize=()=>size
  value.page.setViewportSize=async next=>{size=next}
  value.page.url=()=>url
  try {
    await value.command(1,'init',{width:1000,height:700})
    value.frames.length=0
    value.page.screenshot.mockImplementationOnce(async()=>{url='https://example.com/next';return Buffer.from('stale')})
    await value.command(2,'resize',{width:800,height:600})
    const position=value.frames.findIndex(frame=>frame.type==='result'&&frame.id===2)
    const matching=value.frames.findIndex(frame=>frame.type==='frame'&&frame.url===url&&frame.width===800&&frame.height===600)
    expect(matching).toBeGreaterThanOrEqual(0)
    expect(matching).toBeLessThan(position)
    expect(value.frames[position].error).toBeUndefined()
    expect(value.page.screenshot).toHaveBeenCalledTimes(3)
  } finally { await value.runtime.shutdown() }
})

it('keeps discarded-frame retries within one shared deadline and never acknowledges stale dimensions', async () => {
  let elapsed=0
  const clock=vi.spyOn(Date,'now').mockImplementation(()=>100000+elapsed)
  const value=worker()
  let size={width:1000,height:700},url='https://example.com'
  value.page.viewportSize=()=>size
  value.page.setViewportSize=async next=>{size=next}
  value.page.url=()=>url
  try {
    await value.command(1,'init',{width:1000,height:700})
    value.page.screenshot.mockClear()
    value.page.screenshot.mockImplementation(async({timeout})=>{
      if(timeout<4500){const error=new Error('capture timed out');error.name='TimeoutError';throw error}
      elapsed+=4500;url+='x';return Buffer.from('stale')
    })
    value.input.write(JSON.stringify({id:2,action:'resize',width:800,height:600})+'\n')
    await vi.waitFor(()=>expect(value.frames.some(frame=>frame.type==='fatal')).toBe(true))
    expect(value.page.screenshot.mock.calls.map(([arg])=>arg.timeout)).toEqual([8000,3500])
    expect(value.frames.some(frame=>frame.type==='result'&&frame.id===2&&!frame.error)).toBe(false)
  } finally { await value.runtime.shutdown();clock.mockRestore() }
})

it('discards a frame when the same Page navigates during capture and publishes the next consistent frame', async () => {
  const value = worker()
  let url='https://example.com/old'
  value.page.url=()=>url
  value.page.screenshot.mockImplementation(async()=>{url='https://example.com/new';return Buffer.from('new-page')})
  try {
    // Initialization must first establish a renderable blank page.
    value.page.screenshot.mockResolvedValueOnce(Buffer.from('initial-page'))
    await value.command(1,'init',{width:1000,height:700})
    value.frames.length=0
    await value.command(2,'watch',{enabled:true})
    expect(value.frames.some(frame=>frame.type==='frame')).toBe(false)
    await value.command(3,'watch',{enabled:true})
    expect(value.frames.find(frame=>frame.type==='frame').url).toBe('https://example.com/new')
  } finally { await value.runtime.shutdown() }
})
