import { afterEach, expect, it, vi } from 'vitest'
import { SidebarLeases } from '../src/sidebar-leases.js'

const owner={ownerId:'owner'}, id='12345678-1234-1234-1234-123456789abc', chat='12345678-1234-1234-1234-123456789abd'
const window_id='12345678-1234-1234-1234-123456789abe'
afterEach(()=>vi.useRealTimers())
function fixture() {
  let holds=0, nativeHolds=0
  const browser={chatId:chat,closed:false,retainWindow:()=>{holds++;return()=>{holds--}}}
  const service={requireChat:(_,value)=>{if(value!==chat)throw Object.assign(new Error('denied'),{status:403});return{id:chat,sessionId:'session'}}}
  const native={list:()=>[{id}], async *retain(session,terminal,signal){
    expect([session,terminal]).toEqual(['session',id]);nativeHolds++
    try{yield{type:'retained'};await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve()})}
    finally{nativeHolds--}
  }}
  const leases=new SidebarLeases({browsers:{require:()=>browser},terminals:{native,knownSessions:new Set()},service,ttlMs:100})
  return{leases,browser,holds:()=>holds,nativeHolds:()=>nativeHolds}
}
it('deduplicates window renewals, diffs resources, and releases native holders on window expiry',async()=>{
  vi.useFakeTimers()
  const f=fixture(), resources=[{kind:'browser',id,chat_id:chat},{kind:'terminal',id,chat_id:chat}]
  expect((await f.leases.update(owner,{window_id,resources})).held).toHaveLength(2)
  await f.leases.update(owner,{window_id,resources})
  expect(f.holds()).toBe(1);expect(f.nativeHolds()).toBe(1)
  await f.leases.update(owner,{window_id,resources:resources.slice(1)})
  expect(f.holds()).toBe(0)
  await vi.advanceTimersByTimeAsync(101)
  expect(f.nativeHolds()).toBe(0);expect(f.leases.windows.size).toBe(0)
})
it('keeps independent windows and does not resurrect a closed browser or create any resource',async()=>{
  const f=fixture(),resources=[{kind:'browser',id,chat_id:chat}]
  await f.leases.update(owner,{window_id,resources})
  const second='12345678-1234-1234-1234-123456789abf'
  await f.leases.update(owner,{window_id:second,resources})
  await f.leases.release(owner,window_id)
  expect(f.holds()).toBe(1)
  f.browser.closed=true
  f.browser.retainWindow=()=>{throw Object.assign(new Error('closed'),{status:410})}
  expect((await f.leases.update(owner,{window_id:second,resources})).held).toEqual([])
  expect(f.holds()).toBe(0);f.leases.dispose()
})
it('validates every resource ownership before applying a partial update',async()=>{
  const f=fixture()
  await expect(f.leases.update(owner,{window_id,resources:[{kind:'browser',id,chat_id:window_id}]})).rejects.toMatchObject({status:403})
  expect(f.leases.windows.size).toBe(0)
  await expect(f.leases.update(owner,{window_id,resources:Array(129).fill({})})).rejects.toMatchObject({status:400})
})
it('retains more than 128 existing terminals without a terminal quantity cap',async()=>{
  let retained=0
  const resources=Array.from({length:129},(_,index)=>({kind:'terminal',chat_id:chat,id:`12345678-1234-1234-1234-${index.toString(16).padStart(12,'0')}`}))
  const native={list:()=>resources,async *retain(_session,_id,signal){
    retained++
    try{yield{type:'retained'};await new Promise(resolve=>{
      signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve()
    })}finally{retained--}
  }}
  const leases=new SidebarLeases({browsers:{},terminals:{native,knownSessions:new Set()},service:{requireChat:()=>({sessionId:'session'})}})
  expect((await leases.update(owner,{window_id,resources})).held).toHaveLength(129)
  expect(retained).toBe(129)
  leases.dispose()
  await vi.waitFor(()=>expect(retained).toBe(0))
})

it('releases a late retain and rejects queued renewals after disposal',async()=>{
  const f=fixture(), release=vi.fn()
  let finish
  f.leases.retain=vi.fn(()=>new Promise(resolve=>{finish=()=>resolve({release,live:()=>true})}))
  const request={window_id,resources:[{kind:'terminal',id,chat_id:chat}]}
  const first=f.leases.update(owner,request)
  const firstResult=expect(first).rejects.toMatchObject({status:503})
  const queued=f.leases.update(owner,request)
  const queuedResult=expect(queued).rejects.toMatchObject({status:503})
  await vi.waitFor(()=>expect(f.leases.retain).toHaveBeenCalledOnce())
  f.leases.dispose()
  finish()
  await Promise.all([firstResult,queuedResult])
  expect(release).toHaveBeenCalledOnce()
  expect(f.leases.windows.size).toBe(0)
  expect(f.leases.serial.size).toBe(0)
  expect(f.leases.retain).toHaveBeenCalledOnce()
  await expect(f.leases.update(owner,request)).rejects.toMatchObject({status:503})
})

it('cancels a pending native retain when the service is disposed',async()=>{
  const f=fixture()
  let signal
  f.leases.terminals.native.retain=async function*(_session,_id,lifetime){
    signal=lifetime
    await new Promise(resolve=>{lifetime.addEventListener('abort',resolve,{once:true});if(lifetime.aborted)resolve()})
    lifetime.throwIfAborted()
  }
  const updating=f.leases.update(owner,{window_id,resources:[{kind:'terminal',id,chat_id:chat}]})
  const result=expect(updating).rejects.toMatchObject({status:503})
  await vi.waitFor(()=>expect(signal).toBeDefined())
  f.leases.dispose()
  expect(signal.aborted).toBe(true)
  await result
  expect(f.leases.windows.size).toBe(0)
})
