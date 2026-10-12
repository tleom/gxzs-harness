import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { browserAction, SandboxBrowser, WorkbenchBrowsers } from '../src/browsers.js'
const id = '12345678-1234-1234-1234-123456789abc'
const signal = () => new AbortController().signal
it('bounds input and schemes without accepting command/config fields', () => {
  expect(browserAction({ action: 'navigate', url: 'https://www.baidu.com', command: 'rm' })).toEqual({ action: 'navigate', url: 'https://www.baidu.com/' })
  for (const url of ['file:///workspace/secrets', 'javascript:alert(1)', 'https://user:password@example.com'])
    expect(() => browserAction({ action: 'navigate', url })).toThrow()
  for (const request of [{action:'key',key:'evil()'}, {action:'resize',width:4000,height:800}, {action:'click',x:-1,y:0}, {action:'execute',script:'code'}])
    expect(() => browserAction(request)).toThrow()
})
it('keeps browser actions inside the owner binding and explicit controller lease', async () => {
  const browser = { command: vi.fn(async () => {}), dispose: vi.fn(), follow: vi.fn(), done: Promise.resolve() }
  const gateway = new WorkbenchBrowsers({ create: () => browser })
  await gateway.create({ownerId:'owner'}, {id}, signal())
  expect(browser.command).toHaveBeenCalledWith({action:'init',width:1000,height:700}, expect.any(AbortSignal))
  expect(() => gateway.require({ownerId:'foreign'}, id)).toThrow()
  await expect(gateway.control({ownerId:'owner'}, id, {attachment_id:id, action:'key', key:'Enter'}, signal())).rejects.toMatchObject({status:409})
  browser.controller = id
  await gateway.control({ownerId:'owner'}, id, {attachment_id:id,action:'key',key:'Enter'}, signal())
  expect(browser.command).toHaveBeenLastCalledWith({action:'key',key:'Enter'}, expect.any(AbortSignal))
  await gateway.close({ownerId:'foreign'}, id)
  expect(browser.dispose).not.toHaveBeenCalled()
  await gateway.close({ownerId:'owner'}, id)
  expect(browser.dispose).toHaveBeenCalledOnce()
})
it('does not remove a replacement browser when an earlier initialization fails', async () => {
  let rejectFirst
  const first = {closed:false,command:()=>new Promise((_,reject)=>{rejectFirst=reject}),dispose(){this.closed=true}}
  const second = {closed:false,command:async()=>{},dispose:vi.fn()}
  let count = 0
  const gateway = new WorkbenchBrowsers({create:()=>count++ === 0 ? first : second})
  const pending = gateway.create({ownerId:'owner'},{id},signal())
  first.dispose()
  await gateway.create({ownerId:'owner'},{id},signal())
  rejectFirst(new Error('cancelled initialization'))
  await expect(pending).rejects.toThrow('cancelled initialization')
  expect(gateway.require({ownerId:'owner'},id)).toBe(second)
  gateway.dispose()
})
it('streams a bounded latest frame, reports takeover, and aborts its sandbox process on close', async () => {
  let finish
  const stdout = new PassThrough(), stdin = new PassThrough()
  stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk))
    stdout.write(JSON.stringify({type:'result',id:request.id})+'\n')
  })
  const subprocess = {spawn:vi.fn(spec => ({stdin,stdout,done:new Promise(resolve => {finish=resolve;spec.signal.addEventListener('abort', () => resolve({exitCode:0}))})}))}
  const browser = new SandboxBrowser(subprocess)
  stdout.write(JSON.stringify({type:'frame',image:'aGVsbG8=',width:1000,height:700,url:'https://example.com',title:'test'})+'\n')
  const firstAbort = new AbortController(), otherAbort = new AbortController()
  const first = browser.follow(id, firstAbort.signal)[Symbol.asyncIterator]()
  expect((await first.next()).value.value.writable).toBe(true)
  const other = browser.follow('other', otherAbort.signal)[Symbol.asyncIterator]()
  expect((await other.next()).value.value.writable).toBe(true)
  expect((await first.next()).value.value.writable).toBe(false)
  firstAbort.abort(); await first.return()
  otherAbort.abort(); await other.return()
  browser.dispose(); await browser.done
  expect(subprocess.spawn.mock.calls[0][0].signal.aborted).toBe(true)
  finish({exitCode:0})
})
it('retains the replacement stream lease when an earlier stream with the same attachment exits', async () => {
  const stdout = new PassThrough(), stdin = new PassThrough()
  stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk))
    stdout.write(JSON.stringify({type:'result',id:request.id})+'\n')
  })
  const browser = new SandboxBrowser({spawn:spec => ({stdin,stdout,done:new Promise(resolve => spec.signal.addEventListener('abort',resolve))})})
  stdout.write(JSON.stringify({type:'frame',image:'aA==',width:1000,height:700})+'\n')
  const old = browser.follow(id,signal()), replacement = browser.follow(id,signal())
  await old.next()
  expect((await replacement.next()).value.value.writable).toBe(true)
  expect((await old.next()).value.value.writable).toBe(false)
  await old.return()
  expect(browser.controller).toBe(id)
  expect((await replacement.next()).value.value.writable).toBe(true)
  await browser.command({action:'text',text:'still writable'})
  await replacement.return()
  browser.dispose(); await browser.done
})
it('propagates a fatal worker error to the active stream and invalidates the browser', async () => {
  const stdout = new PassThrough(), stdin = new PassThrough()
  const browser = new SandboxBrowser({spawn:spec => ({stdin,stdout,done:new Promise(resolve => spec.signal.addEventListener('abort',resolve))})})
  const stream = browser.follow(id,signal())
  const next = stream.next()
  stdout.write(JSON.stringify({type:'fatal',error:'网页进程已退出，请重新打开浏览器'})+'\n')
  await expect(next).rejects.toMatchObject({status:502,message:'网页进程已退出，请重新打开浏览器'})
  await expect(browser.command({action:'key',key:'Enter'})).rejects.toMatchObject({status:410})
  expect(browser.closed).toBe(true)
  await browser.done
})

it('counts closing subprocesses until done before admitting replacement browsers', async () => {
  const exits=[], workers=[]
  const gateway=new WorkbenchBrowsers({create:()=> {
    const value={closed:false,command:async()=>{},dispose(){this.closed=true},done:new Promise(resolve=>exits.push(resolve))}
    workers.push(value)
    return value
  }})
  for(let index=0;index<4;index++) {
    const browserId=`12345678-1234-1234-1234-123456789ab${index}`
    await gateway.create({ownerId:'owner'},{id:browserId},signal())
    workers[index].dispose()
  }
  await expect(gateway.create({ownerId:'owner'},{id},signal())).rejects.toMatchObject({status:429})
  expect(workers).toHaveLength(4)
  exits[0](); await Promise.resolve()
  await gateway.create({ownerId:'owner'},{id},signal())
  expect(workers).toHaveLength(5)
  gateway.dispose(); for(const exit of exits) exit()
})

it('reconciles watch state after a queued disable overlaps a replacement stream and a full action queue', async () => {
  const stdout=new PassThrough(),stdin=new PassThrough(),requests=[]
  stdin.on('data',chunk=>requests.push(JSON.parse(String(chunk))))
  const browser=new SandboxBrowser({spawn:spec=>({stdin,stdout,done:new Promise(resolve=>spec.signal.addEventListener('abort',resolve))})})
  const reply=id=>stdout.write(JSON.stringify({type:'result',id})+'\n')
  stdout.write(JSON.stringify({type:'frame',image:'aA==',width:1000,height:700})+'\n')
  const old=browser.follow(id,signal())
  await old.next(); reply(requests[0].id)
  await vi.waitFor(()=>expect(browser.watchEnabled).toBe(true))
  const actions=Array.from({length:31},()=>browser.command({action:'key',key:'Enter'}))
  await old.return()
  const disable=requests.at(-1)
  expect(disable).toMatchObject({action:'watch',enabled:false})
  const replacement=browser.follow(id,signal())
  await replacement.next()
  for(const request of requests.filter(request=>request.action==='key')) reply(request.id)
  await Promise.all(actions)
  reply(disable.id)
  await vi.waitFor(()=>expect(requests.at(-1)).toMatchObject({action:'watch',enabled:true}))
  reply(requests.at(-1).id)
  await vi.waitFor(()=>expect(browser.watchEnabled).toBe(true))
  await replacement.return()
  browser.dispose(); await browser.done
})
