import { afterEach, expect, it, vi } from 'vitest'
import { SidebarLeases } from '../src/sidebar-leases.js'

const owner={ownerId:'owner'}, id='12345678-1234-1234-1234-123456789abc', chat='12345678-1234-1234-1234-123456789abd'
const window_id='12345678-1234-1234-1234-123456789abe'
afterEach(()=>vi.useRealTimers())
function fixture() {
  let holds=0, nativeHolds=0
  const browser={chatId:chat,closed:false,retainWindow:()=>{holds++;return()=>{holds--}}}
  const service={requireChat:(_,value)=>{if(value!==chat)throw Object.assign(new Error('denied'),{status:403});return{sessionId:'session'}}}
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
