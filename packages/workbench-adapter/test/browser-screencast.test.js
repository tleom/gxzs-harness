import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
const { createScreencast } = createRequire(import.meta.url)('../src/browser-screencast.cjs')
it('keeps CSS input coordinates while streaming native high-density pixels', async () => {
  const session=Object.assign(new EventEmitter(), {send:vi.fn(async()=>({}))})
  const stream=createScreencast({session,page:{viewportSize:()=>({width:1174,height:681})},getDeviceScaleFactor:()=>2.2,emit:async()=>true,nextId:()=>1})
  try {
    expect(await stream.start()).toBe(true)
    expect(session.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride',expect.objectContaining({width:1174,height:681,deviceScaleFactor:2.2}))
    expect(session.send).toHaveBeenCalledWith('Page.startScreencast',expect.objectContaining({format:'png',maxWidth:2583,maxHeight:1498}))
  } finally {await stream.dispose()}
})

it('keeps hidden high-density screenshots sharp without starting a stream', async () => {
  const session=Object.assign(new EventEmitter(),{send:vi.fn(async()=>({}))})
  const stream=createScreencast({session,page:{viewportSize:()=>({width:1000,height:650})},getDeviceScaleFactor:()=>2.2,emit:async()=>true,nextId:()=>1})
  try {
    await stream.resize()
    expect(session.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride',expect.objectContaining({width:1000,height:650,deviceScaleFactor:2.2}))
    expect(session.send.mock.calls.some(([name])=>name==='Page.startScreencast')).toBe(false)
    expect(stream.active).toBe(false)
  } finally {await stream.dispose()}
})

it('streams bounded CSS-resolution frames without changing the viewport and waits for viewer receipts', async () => {
  const session = Object.assign(new EventEmitter(), {send:vi.fn(async()=>({}))})
  const emit = vi.fn(async()=>true)
  let sequence=0
  const stream = createScreencast({session,page:{viewportSize:()=>({width:1000,height:700})},emit,nextId:()=>++sequence})
  expect(await stream.start()).toBe(true)
  expect(session.send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride',expect.objectContaining({
    width:1000,height:700,deviceScaleFactor:1,viewport:{x:0,y:0,width:1000,height:700,scale:1}}))
  expect(session.send).toHaveBeenCalledWith('Page.startScreencast',expect.objectContaining({format:'png',maxWidth:1000,maxHeight:700,everyNthFrame:4}))
  session.emit('Page.screencastFrame',{sessionId:7,data:'aA=='})
  await vi.waitFor(()=>expect(emit).toHaveBeenCalledOnce())
  expect(session.send.mock.calls.filter(([method])=>method==='Page.screencastFrameAck')).toHaveLength(0)
  await stream.acknowledge(1)
  expect(session.send).toHaveBeenCalledWith('Page.screencastFrameAck',{sessionId:7})
  await stream.dispose()
  expect(session.listenerCount('Page.screencastFrame')).toBe(0)
})

it('coalesces frames when the transport is slow and releases discarded frame receipts', async () => {
  const session = Object.assign(new EventEmitter(), {send:vi.fn(async()=>({}))})
  let release,sequence=0
  const emit=vi.fn(()=>new Promise(resolve=>{release=resolve}))
  const stream=createScreencast({session,page:{viewportSize:()=>({width:500,height:500})},emit,nextId:()=>++sequence})
  await stream.start()
  session.emit('Page.screencastFrame',{sessionId:1,data:'aA=='})
  session.emit('Page.screencastFrame',{sessionId:2,data:'aA=='})
  session.emit('Page.screencastFrame',{sessionId:3,data:'aA=='})
  await vi.waitFor(()=>expect(session.send).toHaveBeenCalledWith('Page.screencastFrameAck',{sessionId:2}))
  expect(emit).toHaveBeenCalledOnce()
  const firstRelease=release
  firstRelease(true)
  await vi.waitFor(()=>expect(emit).toHaveBeenCalledTimes(2))
  expect(emit.mock.calls[1][0].frame_id).toBe(3)
  release(true)
  await stream.dispose()
})

it('keeps rapidly repainted and large frames lossless', async()=>{
  vi.useFakeTimers()
  const session=Object.assign(new EventEmitter(),{send:vi.fn(async()=>({}))})
  let sequence=0
  const emit=vi.fn(async()=>true)
  const stream=createScreencast({session,page:{viewportSize:()=>({width:1920,height:1080})},emit,nextId:()=>++sequence})
  try {
    await stream.start()
    for(let id=1;id<=4;id++) {session.emit('Page.screencastFrame',{sessionId:id,data:'aA=='});await vi.advanceTimersByTimeAsync(1)}
    const data=Buffer.alloc(4500000).toString('base64')
    session.emit('Page.screencastFrame',{sessionId:5,data})
    await vi.advanceTimersByTimeAsync(1600)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({image:data,mediaType:'image/png'}))
    expect(session.send.mock.calls.filter(([name])=>name==='Page.startScreencast').map(([,args])=>args.format)).toEqual(['png'])
  } finally {await stream.dispose();vi.useRealTimers()}
})

it('does not restart encoding when a hidden view stops during CDP configuration', async()=>{
  let release
  const session=Object.assign(new EventEmitter(),{send:vi.fn(async name=>{if(name==='Emulation.setDeviceMetricsOverride')await new Promise(resolve=>{release=resolve});return{}})})
  const stream=createScreencast({session,page:{viewportSize:()=>({width:1000,height:700})},emit:async()=>true,nextId:()=>1})
  const starting=stream.start()
  await stream.stop()
  release()
  expect(await starting).toBe(false)
  expect(session.send.mock.calls.some(([name])=>name==='Page.startScreencast')).toBe(false)
  await stream.dispose()
})

it('stops an oversized lossless stream and reports failure without lowering quality', async()=>{
  const session=Object.assign(new EventEmitter(),{send:vi.fn(async()=>({}))})
  const emit=vi.fn(async()=>true),onUnavailable=vi.fn()
  const stream=createScreencast({session,page:{viewportSize:()=>({width:1920,height:1080})},emit,nextId:()=>1,onUnavailable})
  try {
    await stream.start()
    session.emit('Page.screencastFrame',{sessionId:1,data:'A'.repeat(Math.ceil(8*1024*1024/3)*4+4)})
    await vi.waitFor(()=>expect(onUnavailable).toHaveBeenCalledOnce())
    expect(emit).not.toHaveBeenCalled()
    expect(stream.active).toBe(false)
    expect(session.send).toHaveBeenCalledWith('Page.stopScreencast')
    expect(session.send.mock.calls.filter(([name])=>name==='Page.startScreencast').map(([,args])=>args.format)).toEqual(['png'])
  } finally {await stream.dispose()}
})
