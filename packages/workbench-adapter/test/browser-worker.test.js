import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
const { createImageCapture, runWorker } = createRequire(import.meta.url)('../src/browser-worker.cjs')
it('captures the existing compositor without resetting display density and bounds its deadline', async () => {
  const page={screenshot:vi.fn()},cdp={send:vi.fn(async()=>({data:Buffer.from('sharp-png').toString('base64')}))}
  const capture=createImageCapture()
  expect((await capture(page,100,cdp)).toString()).toBe('sharp-png')
  expect(page.screenshot).not.toHaveBeenCalled()
  expect(cdp.send).toHaveBeenCalledWith('Page.captureScreenshot',{format:'png',fromSurface:true})
  cdp.send.mockImplementation(()=>new Promise(()=>{}))
  await expect(capture(page,5,cdp)).rejects.toThrow('capture_timeout')
})

it('preserves large lossless frames without retrying JPEG at reduced quality', async () => {
  const bytes = Buffer.alloc(4500000)
  const page = { screenshot: vi.fn(async () => bytes) }
  const capture = createImageCapture()
  expect(await capture(page)).toBe(bytes)
  expect(bytes.mediaType).toBe('image/png')
  await capture(page)
  expect(page.screenshot.mock.calls.map(([args]) => args)).toEqual([
    {type:'png',caret:'initial',timeout:8000}, {type:'png',caret:'initial',timeout:8000},
  ])
})

it('keeps screenshot deadlines and rejects oversized frames without reducing their quality', async () => {
  const page = {screenshot:vi.fn(async()=>Buffer.alloc(8*1024*1024+1))}
  const capture = createImageCapture({budgetMs:5000})
  await expect(capture(page,2000)).rejects.toThrow('frame_too_large')
  expect(page.screenshot).toHaveBeenCalledExactlyOnceWith({type:'png',caret:'initial',timeout:2000})
  await expect(capture(page,0)).rejects.toThrow('capture_timeout')
  expect(page.screenshot).toHaveBeenCalledOnce()
})

function worker(displayFactory, options = {}) {
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://example.com', viewportSize: () => ({width:1000,height:700}), isClosed: () => false,
    screenshot: vi.fn(async () => Buffer.from('jpeg')), title: async () => 'Example',
    setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), waitForURL:vi.fn(async()=>{}),
    keyboard: {insertText:vi.fn(async()=>{}),press:vi.fn(async()=>{})},
    mouse: {wheel:vi.fn(async()=>{}),move:vi.fn(async()=>{})},
  })
  page.locator = vi.fn(() => ({ ariaSnapshot: async () => '', first() { return this } }))
  page.addLocatorHandler = vi.fn(async (_locator, handler) => { page.inputGuard = handler })
  page.removeLocatorHandler = vi.fn(async () => { page.inputGuard = undefined })
  const context = Object.assign(new EventEmitter(), {route:vi.fn(async()=>{}),close:vi.fn(async()=>{}),newPage:async()=>page,newCDPSession:async()=>({send:async()=>({currentIndex:0,entries:[{}]})})})
  const browser = Object.assign(new EventEmitter(), {newContext:vi.fn(async()=>context),close:vi.fn(async()=>{})})
  const input = new PassThrough(), output = new PassThrough(), frames = [], exit = vi.fn()
  output.on('data',chunk=>frames.push(JSON.parse(String(chunk))))
  const launch=vi.fn(async()=>browser)
  const runtime = runWorker({chromium:{launch},input,output,exit,displayFactory:displayFactory ?? null,...options})
  const command = async (id,action,extra={}) => {
    input.write(JSON.stringify({id,action,...extra})+'\n')
    await vi.waitFor(()=>expect(frames.some(frame=>frame.type==='result' && frame.id===id)).toBe(true))
  }
  return {page,browser,runtime,frames,exit,command,input,context,launch}
}

it('allows native downloads and service workers without disabling the HTTP cache, then closes the context',async()=>{
  const value=worker()
  await value.command(1,'init',{width:1000,height:700})
  expect(value.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({acceptDownloads:true,serviceWorkers:'allow'}))
  expect(value.context.route).not.toHaveBeenCalled()
  await value.runtime.shutdown()
  expect(value.context.close).toHaveBeenCalledOnce()
  expect(value.browser.close).toHaveBeenCalledOnce()
})

it.each(['display', 'launch', 'context', 'page'])('closes resources that finish %s after shutdown',async stage=>{
  let complete
  const display={stop:vi.fn(async()=>{})}
  const value=worker(stage==='display' ? ()=>new Promise(resolve=>{complete=()=>resolve(display)}) : undefined)
  value.page.close=vi.fn(async()=>{})
  if(stage==='launch') value.launch.mockImplementation(()=>new Promise(resolve=>{complete=()=>resolve(value.browser)}))
  if(stage==='context') value.browser.newContext.mockImplementation(()=>new Promise(resolve=>{complete=()=>resolve(value.context)}))
  if(stage==='page') value.context.newPage=()=>new Promise(resolve=>{complete=()=>resolve(value.page)})
  try {
    value.input.write(JSON.stringify({id:1,action:'init',width:1000,height:700})+'\n')
    await vi.waitFor(()=>expect(complete).toBeTypeOf('function'))
    await value.runtime.shutdown()
    complete()
    await new Promise(resolve=>setImmediate(resolve))
    if(stage==='display') {expect(display.stop).toHaveBeenCalled();expect(value.launch).not.toHaveBeenCalled()}
    else expect(value.browser.close).toHaveBeenCalled()
    if(stage==='context') expect(value.context.close).toHaveBeenCalled()
    if(stage==='page') expect(value.page.close).toHaveBeenCalled()
    expect(value.frames.some(frame=>frame.type==='frame')).toBe(false)
  } finally {await value.runtime.shutdown()}
})

it('disposes iframe handles when their bounds fail during navigation',async()=>{
  const value=worker(),dispose=vi.fn(async()=>{})
  const frame={frameElement:async()=>({boundingBox:async()=>{throw new Error('detached')},dispose}),isDetached:()=>true}
  value.page.frames=()=>[frame];value.page.mainFrame=()=>value.page
  value.page.evaluate=async()=>({url:'https://example.com',title:'Example',viewport:{width:1000,height:700},elements:[],text:''})
  try {
    await value.command(1,'init',{width:1000,height:700})
    await value.command(2,'snapshot')
    expect(dispose).toHaveBeenCalledOnce()
  } finally {await value.runtime.shutdown()}
})

it('does not adopt native download UI as a web tab or wait for it to close',async()=>{
  const value=worker()
  try {
    await value.command(1,'init',{width:1000,height:700})
    const native={url:()=>'',opener:vi.fn(async()=>null),close:vi.fn(()=>new Promise(()=>{}))}
    value.context.emit('page',native)
    await value.command(2,'text',{text:'still usable'})
    expect(value.page.keyboard.insertText).toHaveBeenCalledWith('still usable')
    expect(native.opener).not.toHaveBeenCalled()
    expect(native.close).not.toHaveBeenCalled()
  } finally {await value.runtime.shutdown()}
})

it('accepts an attachment navigation whose download event follows the goto rejection',async()=>{
  const value=worker()
  value.page.goto=vi.fn(async()=>{
    setImmediate(()=>value.page.emit('download',{
      suggestedFilename:()=> 'file.txt',path:async()=>{throw new Error('download interrupted')},
      delete:async()=>{},cancel:async()=>{},
    }))
    throw new Error('page.goto: net::ERR_ABORTED')
  })
  try {
    await value.command(1,'init',{width:1000,height:700})
    await value.command(2,'navigate',{url:'https://example.com/file'})
    expect(value.frames.find(frame=>frame.id===2).error).toBeUndefined()
    await value.command(3,'text',{text:'still usable'})
    expect(value.page.keyboard.insertText).toHaveBeenCalledWith('still usable')
    expect(value.page.listenerCount('download')).toBe(1)
  } finally {await value.runtime.shutdown()}
})

it.each(['element-click', 'element-text'])('returns lookup counts without mutating the page for %s', async action => {
  const value = worker()
  let count = 0
  const locator = { count: vi.fn(async () => count), elementHandles: async () => Array(count).fill(locator), dispose: vi.fn(async () => {}), first() { return this }, ariaSnapshot: async () => '',
    click: vi.fn(async ({ signal }) => { await value.page.inputGuard(); signal.throwIfAborted() }),
    isEditable: async () => true, focus: vi.fn(async () => {}), evaluate: async () => true }
  value.page.locator = () => locator
  value.page.getByRole = vi.fn(() => locator)
  value.page.frames = () => []
  value.page.evaluate = async () => ({ text: '', elements: [], viewport: {} })
  value.page.mouse.click = vi.fn(async () => {})
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'snapshot')
    const revision = value.frames.find(frame => frame.id === 2).value.revision
    for (const [id, matches, kind] of [[3, 0, 'not_found'], [4, 2, 'ambiguous']]) {
      count = matches
      await value.command(id, action, { role: 'img', name: 'arrows-alt', text: 'value', expected_revision: revision })
      expect(value.frames.find(frame => frame.id === id)).toMatchObject({ value: { outcome: { kind, match_count: matches } } })
      expect(value.frames.find(frame => frame.id === id).error).toBeUndefined()
    }
    await value.command(5, 'snapshot')
    expect(value.frames.find(frame => frame.id === 5).value.revision).toBe(revision)
    expect(locator.focus).not.toHaveBeenCalled()
    expect(value.page.mouse.click).not.toHaveBeenCalled()
    expect(value.page.keyboard.insertText).not.toHaveBeenCalled()
    count = 1
    await value.command(6, action, { role: 'img', name: 'arrows-alt', text: 'value', expected_revision: revision })
    expect(value.frames.find(frame => frame.id === 6).error).toBeUndefined()
    expect(action === 'element-click' ? locator.click : value.page.keyboard.insertText).toHaveBeenCalledOnce()
    expect(value.page.mouse.click).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('returns a fresh-observation outcome instead of acting on an outdated revision', async () => {
  const value = worker()
  value.page.getByRole = vi.fn()
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'key', { key: 'Tab' })
    await value.command(3, 'element-click', { role: 'button', name: 'Search', expected_revision: 0 })
    expect(value.frames.find(frame => frame.id === 3)).toMatchObject({ value: { outcome: { kind: 'stale' } } })
    expect(value.page.getByRole).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it.each(['element-click', 'element-text'])('does not deliver %s after navigation during target preparation', async action => {
  const value = worker(), main = { url: () => 'https://example.com/next' }
  value.page.mainFrame = () => main
  const navigate = async () => value.page.emit('framenavigated', main)
  const locator = { count: async () => 1, elementHandles: async () => [locator], dispose: vi.fn(async () => {}), isEditable: async () => true, focus: navigate, evaluate: async () => true,
    click: async ({ signal }) => { await navigate(); await value.page.inputGuard(); signal.throwIfAborted(); await value.page.mouse.click() } }
  value.page.getByRole = () => locator
  value.page.mouse.click = vi.fn(async () => {})
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, action, { role: 'textbox', name: 'Query', text: 'private input', expected_revision: 0 })
    expect(value.page.mouse.click).not.toHaveBeenCalled()
    expect(value.page.keyboard.press).not.toHaveBeenCalled()
    expect(value.page.keyboard.insertText).not.toHaveBeenCalled()
    expect(value.frames.find(frame => frame.id === 2)).toMatchObject({ value: { outcome: { kind: 'stale' } } })
  } finally { await value.runtime.shutdown() }
})

it('reports an unclickable element and removes its native action guard without coordinate fallback', async () => {
  const value = worker()
  value.page.mouse.click = vi.fn()
  const element = { dispose: vi.fn(async () => {}), click: async () => {
    const error = new Error('element is covered'); error.name = 'TimeoutError'; throw error
  } }
  value.page.getByRole = () => ({ elementHandles: async () => [element] })
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'element-click', { role: 'button', name: 'Covered', expected_revision: 0 })
    expect(value.frames.find(frame => frame.id === 2)).toMatchObject({ value: { outcome: { kind: 'not_actionable' } } })
    expect(value.page.mouse.click).not.toHaveBeenCalled()
    expect(value.page.removeLocatorHandler).toHaveBeenCalledOnce()
    expect(element.dispose).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

it('aborts native click waiting immediately on cancellation and leaves the browser usable', async () => {
  const value = worker(), delivered = vi.fn()
  let waiting = false
  const element = { dispose: vi.fn(async () => {}), click: async ({ signal }) => {
    waiting = true
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    delivered()
  } }
  value.page.getByRole = () => ({ elementHandles: async () => [element] })
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    value.input.write(JSON.stringify({ id: 2, action: 'element-click', role: 'button', name: 'Covered', expected_revision: 0 }) + '\n')
    await vi.waitFor(() => expect(waiting).toBe(true))
    value.input.write(JSON.stringify({ action: 'cancel', cancel_id: 2 }) + '\n')
    await vi.waitFor(() => expect(value.frames.find(frame => frame.id === 2)?.error).toBe('浏览器操作已取消'))
    await value.command(3, 'text', { text: 'still usable' })
    expect(value.page.keyboard.insertText).toHaveBeenCalledWith('still usable')
    expect(delivered).not.toHaveBeenCalled()
    expect(value.page.removeLocatorHandler).toHaveBeenCalledOnce()
    expect(element.dispose).toHaveBeenCalledOnce()
    expect(value.exit).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('does not resolve a replacement node after the pinned iframe element detaches', async () => {
  const value = worker(), replacementClick = vi.fn()
  const element = { dispose: vi.fn(async () => {}), click: async () => { throw new Error('Element is not attached to the DOM') } }
  const locator = { elementHandles: vi.fn(async () => [element]), click: replacementClick }
  value.page.getByRole = () => locator
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'element-click', { role: 'button', name: 'Old frame target' })
    expect(value.frames.find(frame => frame.id === 2)).toMatchObject({ value: { outcome: { kind: 'stale' } } })
    expect(locator.elementHandles).toHaveBeenCalledOnce()
    expect(replacementClick).not.toHaveBeenCalled()
    expect(element.dispose).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

it.each(['navigate', 'reload', 'back', 'forward'])('returns an observed cancellation for beforeunload during %s and allows an explicit leave', async action => {
  const value = worker(), dismiss = vi.fn(async () => {}), accept = vi.fn(async () => {})
  const navigate = vi.fn(async () => {
    const accepted = accept.mock.calls.length
    value.page.emit('dialog', { type: () => 'beforeunload', dismiss, accept })
    if (accept.mock.calls.length === accepted) throw new Error('net::ERR_ABORTED')
  })
  for (const method of ['goto', 'reload', 'goBack', 'goForward']) value.page[method] = navigate
  value.page.evaluate = async () => ({ text: 'Current page', elements: [], viewport: {} })
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, action, { url: 'https://example.com/new' })
    expect(value.frames.find(frame => frame.id === 2)).toMatchObject({ value: { outcome: { kind: 'navigation_cancelled' } } })
    expect(value.frames.find(frame => frame.id === 2).value.revision).toEqual(expect.any(Number))
    expect(value.frames.find(frame => frame.id === 2).error).toBeUndefined()
    await value.command(3, 'snapshot')
    const snapshot = value.frames.find(frame => frame.id === 3).value
    expect(snapshot.notice).toBe('已取消离开当前页面')
    expect(snapshot.revision).toBe(value.frames.find(frame => frame.id === 2).value.revision)
    await value.command(4, action, { url: 'https://example.com/new', before_unload: 'leave', expected_revision: snapshot.revision })
    expect(value.frames.find(frame => frame.id === 4).error).toBeUndefined()
    expect(value.frames.find(frame => frame.id === 4).value.outcome).toBeUndefined()
    expect(dismiss).toHaveBeenCalledOnce()
    expect(accept).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

it('keeps ordinary confirm and prompt dismissals separate from explicit beforeunload leave', async () => {
  const value = worker(), dismiss = vi.fn(async () => {}), accept = vi.fn(async () => {})
  value.page.goto = async () => {
    for (const type of ['confirm', 'prompt']) value.page.emit('dialog', { type: () => type, dismiss, accept })
  }
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'navigate', { url: 'https://example.com/new', before_unload: 'leave' })
    expect(dismiss).toHaveBeenCalledTimes(2)
    expect(accept).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('finishes a dismissed history navigation through the native abort signal', async () => {
  const value = worker(), dismiss = vi.fn(async () => {})
  value.page.goBack = ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    value.page.emit('dialog', { type: () => 'beforeunload', dismiss })
  })
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'back')
    expect(value.frames.find(frame => frame.id === 2)).toMatchObject({ value: { outcome: { kind: 'navigation_cancelled' } } })
    expect(dismiss).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

it('does not accept beforeunload on behalf of a cancelled leave operation', async () => {
  const value = worker(), dismiss = vi.fn(async () => {}), accept = vi.fn(async () => {})
  value.page.goto = async () => {
    value.input.write(JSON.stringify({ action: 'cancel', cancel_id: 2 }) + '\n')
    value.page.emit('dialog', { type: () => 'beforeunload', dismiss, accept })
    throw new Error('cancelled navigation')
  }
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'navigate', { url: 'https://example.com/new', before_unload: 'leave' })
    expect(value.frames.find(frame => frame.id === 2)?.error).toBe('浏览器操作已取消')
    expect(dismiss).toHaveBeenCalledOnce()
    expect(accept).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('does not insert text into a document that navigated during field selection', async () => {
  const value = worker(), main = { url: () => 'https://example.com/next' }
  value.page.mainFrame = () => main
  const element = { isEditable: async () => true, focus: async () => {}, evaluate: async () => true, dispose: async () => {} }
  value.page.getByRole = () => ({ elementHandles: async () => [element] })
  value.page.keyboard.press.mockImplementation(async () => value.page.emit('framenavigated', main))
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'element-text', { role: 'textbox', name: 'Query', text: 'fixture', expected_revision: 0 })
    expect(value.page.keyboard.insertText).not.toHaveBeenCalled()
    expect(value.frames.find(frame => frame.id === 2)).toMatchObject({ value: { outcome: { kind: 'stale' } } })
  } finally { await value.runtime.shutdown() }
})

it.each(['focus', 'select'])('does not type into a field that stole focus during %s', async phase => {
  const value = worker()
  let focused = true
  const element = { isEditable: async () => true, dispose: vi.fn(async () => {}),
    focus: async () => { if (phase === 'focus') focused = false },
    evaluate: async () => focused }
  value.page.getByRole = () => ({count:async()=>1,elementHandles:async()=>[element],...element})
  value.page.keyboard.press.mockImplementation(async () => { focused = false })
  try {
    await value.command(1, 'init', {width:1000,height:700})
    await value.command(2, 'element-text', {role:'textbox',name:'Target',text:'private',expected_revision:0})
    expect(value.frames.find(frame=>frame.id===2)).toMatchObject({value:{outcome:{kind:'stale'}}})
    expect(value.page.keyboard.insertText).not.toHaveBeenCalled()
    expect(value.page.keyboard.press).toHaveBeenCalledTimes(phase==='focus'?0:1)
    expect(element.dispose).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

it.each([true, false])('terminates a stuck observation before any queued mutation (cancel=%s)', async cancel => {
  const value = worker(null, { commandTimeoutMs: cancel ? 2000 : 100, cancelGraceMs: 50 })
  let release
  value.page.evaluate = vi.fn(() => new Promise(resolve => { release = resolve }))
  value.page.frames = () => []
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    value.input.write(JSON.stringify({ id: 2, action: 'snapshot' }) + '\n')
    await vi.waitFor(() => expect(value.page.evaluate).toHaveBeenCalled())
    value.input.write(JSON.stringify({ id: 3, action: 'text', text: 'must not run' }) + '\n')
    if (cancel) value.input.write(JSON.stringify({ action: 'cancel', cancel_id: 2 }) + '\n')
    await vi.waitFor(() => expect(value.exit).toHaveBeenCalledWith(2))
    expect(value.browser.close).toHaveBeenCalledOnce()
    expect(value.frames.some(frame => frame.type === 'fatal')).toBe(true)
    release({ text: '', elements: [], viewport: {} })
    await new Promise(resolve => setImmediate(resolve))
    expect(value.page.keyboard.insertText).not.toHaveBeenCalled()
    expect(value.frames.some(frame => frame.id === 2 || frame.id === 3)).toBe(false)
  } finally { await value.runtime.shutdown() }
})

function navigationFixture({ commit = true, readable = true, errorName = 'TimeoutError' } = {}) {
  const value = worker(), url = 'https://example.com/loaded'
  const frame = { url: () => url }
  value.page.mainFrame = () => frame
  value.page.frames = () => []
  value.page.evaluate = vi.fn(async fn => fn.name === 'observePage'
    ? { url, title: 'Readable page', text: 'Visible content', elements: [], viewport: {} }
    : { url, hasBody: readable, readyState: 'loading' })
  value.page.url = () => url
  const navigate = vi.fn(async () => {
    if (commit) value.page.emit('framenavigated', frame)
    if (commit) return { url: () => url }
    const error = new Error('load event did not arrive'); error.name = errorName; throw error
  })
  value.page.waitForLoadState = vi.fn(async () => {
    const error = new Error('load event did not arrive'); error.name = errorName; throw error
  })
  value.page.goto = value.page.reload = value.page.goBack = value.page.goForward = navigate
  return { ...value, navigate, frame, url }
}

it('falls back once inside one navigation and releases its request listener', async () => {
  const value = navigationFixture(), target = 'https://example.com/loaded', fallback = 'http://example.com/loaded'
  value.page.goto = vi.fn().mockRejectedValueOnce(new Error('net::ERR_SSL_PROTOCOL_ERROR')).mockResolvedValue({})
  value.page.waitForLoadState.mockResolvedValue()
  try {
    await value.command(1, 'init', {width:1000,height:700})
    const listeners = value.page.listenerCount('request')
    await value.command(2, 'navigate', {url:target,fallback_url:fallback})
    expect(value.page.goto.mock.calls.map(([url])=>url)).toEqual([target,fallback])
    expect(value.frames.find(frame=>frame.id===2).error).toBeUndefined()
    expect(value.page.listenerCount('request')).toBe(listeners)
  } finally { await value.runtime.shutdown() }
})

it('shares the existing navigation deadline with HTTP fallback after a timeout', async () => {
  const value = navigationFixture(), clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
  value.page.goto = vi.fn().mockImplementationOnce(async () => {
    clock.mockReturnValue(115000)
    throw Object.assign(new Error('navigation timeout'), {name:'TimeoutError'})
  }).mockResolvedValue({})
  value.page.waitForLoadState.mockResolvedValue()
  try {
    await value.command(1, 'init', {width:1000,height:700})
    await value.command(2, 'navigate', {url:'https://example.com/',fallback_url:'http://example.com/'})
    expect(value.page.goto.mock.calls[1][1].timeout).toBe(5000)
    expect(value.page.waitForLoadState.mock.calls[0][1].timeout).toBe(5000)
  } finally { clock.mockRestore(); await value.runtime.shutdown() }
})

it.each(['explicit', 'certificate', 'redirect', 'cancel', 'unrelated'])('does not downgrade a %s navigation failure', async mode => {
  const value = navigationFixture(), target = 'https://example.com/loaded'
  value.page.goto = vi.fn(async () => {
    if (mode === 'redirect') value.page.emit('request',{isNavigationRequest:()=>true,frame:()=>value.frame,redirectedFrom:()=>({})})
    if (mode === 'cancel') value.input.write(JSON.stringify({action:'cancel',cancel_id:2})+'\n')
    throw new Error(mode === 'certificate' ? 'net::ERR_CERT_AUTHORITY_INVALID' : 'net::ERR_CONNECTION_REFUSED')
  })
  try {
    await value.command(1, 'init', {width:1000,height:700})
    await value.command(2, 'navigate', {url:target,...(mode==='explicit'?{}:{fallback_url:mode==='unrelated'?'http://other.example/loaded':'http://example.com/loaded'})})
    expect(value.page.goto).toHaveBeenCalledOnce()
    expect(value.frames.find(frame=>frame.id===2).error).toBeTruthy()
    expect(value.page.listenerCount('request')).toBe(0)
  } finally { await value.runtime.shutdown() }
})

it.each(['navigate', 'reload', 'back', 'forward'])('keeps the committed page observable after a %s load timeout', async action => {
  const value = navigationFixture()
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, action, { url: value.url })
    expect(value.frames.find(frame => frame.id === 2).error).toBeUndefined()
    await value.command(3, 'snapshot')
    const snapshot = value.frames.find(frame => frame.id === 3).value
    expect(snapshot).toMatchObject({ title: 'Readable page', text: 'Visible content', notice: expect.stringContaining('尚未完成加载') })
    await value.command(4, 'key', { key: 'Tab', expected_revision: snapshot.revision })
    expect(value.frames.find(frame => frame.id === 4).error).toBeUndefined()
    expect(value.navigate).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

it.each([
  { commit: false }, { readable: false }, { errorName: 'Error' },
])('preserves navigation failure when a new readable page is unproven: %j', async options => {
  const value = navigationFixture(options)
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'navigate', { url: value.url })
    expect(value.frames.find(frame => frame.id === 2).error).toBe('网页加载失败，请检查地址或稍后刷新')
    expect(value.navigate).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

it('bounds the readability probe when the committed document stops responding', async () => {
  const value = navigationFixture()
  value.page.evaluate.mockImplementation(() => new Promise(() => {}))
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    value.input.write(JSON.stringify({ id: 2, action: 'navigate', url: value.url }) + '\n')
    await vi.waitFor(() => expect(value.frames.find(frame => frame.id === 2)?.error)
      .toBe('网页加载失败，请检查地址或稍后刷新'), { timeout: 2000 })
  } finally { await value.runtime.shutdown() }
})

it('clears the incomplete-load notice when that document finishes loading', async () => {
  const value = navigationFixture()
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'navigate', { url: value.url })
    value.frames.length = 0
    value.page.emit('domcontentloaded')
    await vi.waitFor(() => expect(value.frames.some(frame => frame.type === 'frame' && frame.notice === '')).toBe(true))
    await value.command(3, 'snapshot')
    expect(value.frames.find(frame => frame.id === 3).value.notice).toBeUndefined()
  } finally { await value.runtime.shutdown() }
})

it('does not install a loading notice after DOMContentLoaded fires during the readability probe', async () => {
  const value = navigationFixture()
  const evaluate = value.page.evaluate.getMockImplementation()
  value.page.evaluate.mockImplementation(async fn => {
    if (fn.name !== 'observePage') value.page.emit('domcontentloaded')
    return evaluate(fn)
  })
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'navigate', { url: value.url })
    expect(value.frames.find(frame => frame.id === 2).error).toBeUndefined()
    await value.command(3, 'snapshot')
    expect(value.frames.find(frame => frame.id === 3).value.notice).toBeUndefined()
  } finally { await value.runtime.shutdown() }
})

it('does not mistake old-page history navigation for a requested new-document commit', async () => {
  const value = navigationFixture({ commit: false })
  value.page.goto = async () => {
    value.page.emit('framenavigated', value.frame)
    const error = new Error('new document never arrived'); error.name = 'TimeoutError'; throw error
  }
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'navigate', { url: value.url })
    expect(value.frames.find(frame => frame.id === 2).error).toBe('网页加载失败，请检查地址或稍后刷新')
    expect(value.page.waitForLoadState).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('shares the existing navigation deadline between document commit and load', async () => {
  const value = navigationFixture(), clock = vi.spyOn(Date, 'now')
  clock.mockReturnValue(100000)
  const navigate = value.page.goto
  value.page.goto = async (...args) => { clock.mockReturnValue(115000); return navigate(...args) }
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'navigate', { url: value.url })
    expect(value.navigate).toHaveBeenCalledWith(value.url, { waitUntil: 'commit', signal: expect.any(AbortSignal) })
    expect(value.page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 5000, signal: expect.any(AbortSignal) })
  } finally { await value.runtime.shutdown(); clock.mockRestore() }
})

it('does not turn cancelled navigation into an observed partial success', async () => {
  const value = navigationFixture()
  value.page.goto = async () => {
    value.page.emit('framenavigated', value.frame)
    value.input.write(JSON.stringify({ id: 9, action: 'cancel', cancel_id: 2 }) + '\n')
    const error = new Error('cancelled wait'); error.name = 'TimeoutError'; throw error
  }
  try {
    await value.command(1, 'init', { width: 1000, height: 700 })
    await value.command(2, 'navigate', { url: value.url })
    expect(value.frames.find(frame => frame.id === 2).error).toBe('浏览器操作已取消')
  } finally { await value.runtime.shutdown() }
})

it('uses a private visible display without starting CDP pixel encoding, and releases it with Chromium', async () => {
  const display={env:{DISPLAY:':100'},size:{width:1000,height:700},resize:vi.fn(),open:vi.fn(),write:vi.fn(),close:vi.fn(),stop:vi.fn(async()=>{})}
  const factory=vi.fn(async()=>display),value=worker(factory)
  value.context.exposeBinding=vi.fn(async()=>{})
  value.context.addInitScript=vi.fn(async()=>{})
  value.page.bringToFront=vi.fn(async()=>{})
  value.page.evaluate=vi.fn(async()=>({width:1000,height:700}))
  try {
    await value.command(1,'init',{width:1000,height:700})
    expect(value.frames.find(frame=>frame.id===1).value).toEqual({display:'kasm',input_protocol:2})
    expect(value.launch).toHaveBeenCalledWith(expect.objectContaining({headless:false,env:{DISPLAY:':100'}}))
    expect(value.frames.find(frame=>frame.type==='frame')).toMatchObject({display:'kasm',width:1000,height:700})
    expect(value.page.screenshot).not.toHaveBeenCalled()
    await value.command(2,'display-open',{connection:'viewer'})
    await value.command(3,'display-write',{connection:'viewer',data:'AA=='})
    expect(display.open).toHaveBeenCalledWith('viewer')
    expect(display.write).toHaveBeenCalledWith('viewer','AA==')
  } finally {await value.runtime.shutdown()}
  expect(display.stop).toHaveBeenCalledOnce()
  expect(value.browser.close).toHaveBeenCalledOnce()
})

it.each([false, true])('waits for visible renderer resize before acknowledgement; timeout=%s', async timeout => {
  const display={env:{DISPLAY:':100'},size:{width:1000,height:700},resize:vi.fn(),stop:vi.fn(async()=>{})}
  const value=worker(async()=>display)
  value.context.exposeBinding=vi.fn(async()=>{})
  value.context.addInitScript=vi.fn(async()=>{})
  value.page.bringToFront=vi.fn(async()=>{})
  let size={width:1000,height:700},settle
  const handle={dispose:vi.fn(async()=>{})}
  value.page.evaluate=vi.fn(async()=>size)
  value.page.waitForFunction=vi.fn(()=>new Promise((resolve,reject)=>{
    settle=()=>{if(timeout) reject(new Error('resize_timeout'));else {size={width:823,height:617};resolve(handle)}}
  }))
  try {
    await value.command(1,'init',{width:1000,height:700})
    value.frames.length=0
    value.input.write(JSON.stringify({id:2,action:'resize',width:823,height:617})+'\n')
    await vi.waitFor(()=>expect(settle).toBeTypeOf('function'))
    expect(value.frames.some(frame=>frame.type==='result'&&frame.id===2)).toBe(false)
    expect(value.page.waitForFunction).toHaveBeenCalledWith(expect.any(Function),
      {width:823,height:617},{timeout:5000,polling:50})
    settle()
    await vi.waitFor(()=>expect(value.frames.some(frame=>frame.type==='result'&&frame.id===2)).toBe(true))
    const result=value.frames.find(frame=>frame.type==='result'&&frame.id===2)
    if(timeout) {
      expect(result.error).toBe('浏览器操作失败')
      expect(handle.dispose).not.toHaveBeenCalled()
    } else {
      expect(result.error).toBeUndefined()
      expect(value.frames.filter(frame=>frame.type==='frame').at(-1)).toMatchObject({width:823,height:617})
      expect(handle.dispose).toHaveBeenCalledOnce()
    }
  } finally {await value.runtime.shutdown()}
})

it.each(['https://example.com/child','chrome-error://chromewebdata/'])('replaces the displayed page with a native popup %s, preserving the browser identity', async url => {
  const value=worker()
  value.page.close=vi.fn(async()=>value.page.emit('close'))
  const popup=Object.assign(new EventEmitter(),{url:()=>url,viewportSize:()=>({width:1000,height:700}),isClosed:()=>false,
    screenshot:vi.fn(async()=>Buffer.from('popup')),title:async()=> 'Child',setDefaultTimeout:vi.fn(),setDefaultNavigationTimeout:vi.fn(),
    close:vi.fn(async()=>{}),keyboard:{insertText:vi.fn(async()=>{})}})
  try {
    const root='12345678-1234-1234-1234-123456789abc'
    await value.command(1,'init',{width:1000,height:700,browser_id:root})
    value.page.emit('popup',popup)
    await vi.waitFor(()=>expect(value.page.close).toHaveBeenCalledOnce())
    expect(value.frames.some(frame=>frame.type==='page-open')).toBe(false)
    await value.command(2,'text',{page_id:root,text:'child'})
    expect(value.page.keyboard.insertText).not.toHaveBeenCalled()
    expect(popup.keyboard.insertText).toHaveBeenCalledWith('child')
    await value.runtime.shutdown()
    expect(value.page.close).toHaveBeenCalledOnce()
    expect(value.browser.close).toHaveBeenCalledOnce()
  } finally { await value.runtime.shutdown() }
})

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

it('reports an oversized lossless frame and exits without claiming initialization succeeded', async () => {
  const value = worker()
  value.page.screenshot.mockImplementation(async()=>Buffer.alloc(8*1024*1024+1))
  try {
    value.input.write(JSON.stringify({id:1,action:'init',width:1000,height:700})+'\n')
    await vi.waitFor(()=>expect(value.exit).toHaveBeenCalledWith(2))
    expect(value.frames.find(frame=>frame.type==='fatal').error).toContain('图像过大')
    expect(value.frames.some(frame=>frame.type==='result' && frame.id===1)).toBe(false)
    expect(value.page.screenshot).toHaveBeenCalledOnce()
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
    expect(value.frames.find(frame=>frame.type==='result' && frame.id===1).error).toBe('浏览器操作失败')
    expect(value.frames.some(frame=>frame.type==='frame')).toBe(false)
  } finally { await value.runtime.shutdown() }
})

it('keeps the browser context after a transient screenshot timeout and recovers on a later frame', async () => {
  const value=worker()
  try {
    await value.command(1,'init',{width:1000,height:700})
    const timeout=new Error('screenshot timeout'); timeout.name='TimeoutError'
    value.page.screenshot.mockRejectedValue(timeout)
    value.input.write(JSON.stringify({id:2,action:'watch',enabled:true})+'\n')
    await vi.waitFor(()=>expect(value.page.screenshot.mock.calls.length).toBeGreaterThan(1))
    expect(value.exit).not.toHaveBeenCalled()
    expect(value.browser.close).not.toHaveBeenCalled()
    value.page.screenshot.mockResolvedValue(Buffer.from('recovered'))
    await vi.waitFor(()=>expect(value.frames.some(frame=>frame.image===Buffer.from('recovered').toString('base64'))).toBe(true))
  } finally { await value.runtime.shutdown() }
})

it('rejects an already-navigated non-HTTP popup without replacing the current page', async () => {
  const value=worker()
  try {
    await value.command(1,'init',{width:1000,height:700})
    const popup={url:()=> 'file:///workspace/document',close:vi.fn(async()=>{})}
    value.page.emit('popup',popup)
    await vi.waitFor(()=>expect(popup.close).toHaveBeenCalledOnce())
    await value.command(2,'watch',{enabled:true})
    expect(value.frames.filter(frame=>frame.type==='frame').at(-1).url).toBe('https://example.com')
    expect(value.browser.close).not.toHaveBeenCalled()
  } finally { await value.runtime.shutdown() }
})

it('adopts a generated blob document after its initially empty popup URL commits',async()=>{
  const value=worker()
  let url=''
  const popup=Object.assign(new EventEmitter(), {
    url:()=>url,isClosed:()=>false,viewportSize:()=>({width:1000,height:700}),
    screenshot:async()=>Buffer.from('preview'),title:async()=> 'Generated preview',
    setDefaultTimeout:vi.fn(),setDefaultNavigationTimeout:vi.fn(),close:vi.fn(async()=>{}),
    waitForURL:vi.fn(async()=>{url='blob:https://example.com/document'}),
  })
  value.page.close=vi.fn(async()=>value.page.emit('close'))
  try {
    await value.command(1,'init',{width:1000,height:700})
    value.page.emit('popup',popup)
    await vi.waitFor(()=>expect(value.frames.some(frame=>frame.url===url && url.startsWith('blob:'))).toBe(true))
    expect(popup.waitForURL).toHaveBeenCalledOnce()
    expect(popup.close).not.toHaveBeenCalled()
    expect(value.page.close).toHaveBeenCalledOnce()
    expect(value.exit).not.toHaveBeenCalled()
  } finally {await value.runtime.shutdown()}
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
    url='file:///workspace/document'
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
    await vi.waitFor(()=>expect(value.frames.some(frame=>frame.type==='result'&&frame.id===2&&frame.error)).toBe(true))
    expect(value.page.screenshot.mock.calls.slice(0,2).map(([arg])=>arg.timeout)).toEqual([8000,3500])
    expect(value.frames.some(frame=>frame.type==='fatal')).toBe(false)
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

it('tracks held pointer modifiers and refuses to cut a selection observed before another action', async () => {
  const value=worker()
  value.page.keyboard.down=vi.fn(async()=>{});value.page.keyboard.up=vi.fn(async()=>{})
  value.page.evaluate=vi.fn(async()=> 'selected text')
  try {
    await value.command(1,'init',{width:1000,height:700})
    await value.command(2,'move',{x:20,y:30,modifiers:['Shift']})
    expect(value.page.keyboard.down).toHaveBeenCalledWith('Shift')
    await value.command(3,'release-input')
    expect(value.page.keyboard.up).toHaveBeenCalledWith('Shift')
    await value.command(4,'selection')
    const selected=value.frames.find(frame=>frame.type==='result'&&frame.id===4).value
    expect(selected.text).toBe('selected text')
    await value.command(5,'text',{text:'another action'})
    await value.command(6,'cut-selection',{text:selected.text,expected_revision:selected.revision})
    expect(value.frames.find(frame=>frame.type==='result'&&frame.id===6).error).toContain('页面已变化')
    expect(value.page.keyboard.press).not.toHaveBeenCalledWith('ControlOrMeta+X')
  } finally { await value.runtime.shutdown() }
})
