import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { SandboxBrowser, WorkbenchBrowsers } from '../src/browsers.js'
import { WorkbenchTerminals } from '../src/terminals.js'

it('holds a hidden browser window without encoding frames and releases it when the window disconnects', async () => {
  const stdin=new PassThrough(),stdout=new PassThrough(),requests=[]
  stdin.on('data',bytes=>{
    const request=JSON.parse(String(bytes));requests.push(request)
    if(request.id)stdout.write(JSON.stringify({type:'result',id:request.id})+'\n')
  })
  const browser=new SandboxBrowser({spawn:spec=>({stdin,stdout,done:new Promise(resolve=>spec.signal.addEventListener('abort',resolve))})})
  const gateway=new WorkbenchBrowsers({create:()=>browser})
  const id='12345678-1234-1234-1234-123456789abc',owner={ownerId:'owner'},signal=new AbortController().signal
  await gateway.create(owner,{id},signal)
  stdout.write(JSON.stringify({type:'frame',image:'aA==',width:1000,height:700})+'\n')
  const stream=gateway.follow(owner,id,id,signal,false)
  expect((await stream.next()).value.value.writable).toBe(false)
  expect(gateway.activity()).toBe(1)
  expect(requests.some(value=>value.action==='watch'&&value.enabled)).toBe(false)
  await gateway.control(owner,id,{action:'visibility',attachment_id:id,visible:true},signal)
  expect((await stream.next()).value.value.writable).toBe(true)
  await gateway.control(owner,id,{action:'visibility',attachment_id:id,visible:false},signal)
  expect((await stream.next()).value.value.writable).toBe(false)
  expect(gateway.activity()).toBe(1)
  await stream.return()
  await Promise.resolve()
  expect(gateway.activity()).toBe(0)
  await gateway.close(owner,id)
})

it('counts native live terminal processes rather than saved tab metadata', () => {
  const gateway=new WorkbenchTerminals({native:{list:id=>id==='live'?[{state:'running'},{state:'exited'}]:[]}})
  gateway.knownSessions.add('live');gateway.knownSessions.add('gone')
  expect(gateway.activity()).toBe(1)
  expect(gateway.knownSessions.has('gone')).toBe(false)
  gateway.native.list=()=>[{state:'exited'}]
  expect(gateway.activity()).toBe(0)
})
