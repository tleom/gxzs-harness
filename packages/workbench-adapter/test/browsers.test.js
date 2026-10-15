import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { browserAction, SandboxBrowser, WorkbenchBrowsers } from '../src/browsers.js'
const id = '12345678-1234-1234-1234-123456789abc'
const signal = () => new AbortController().signal
it('binds RFB input to its owner, active attachment and current ordered display handshake', async () => {
  const worker = { closed:false, done:new Promise(()=>{}), command:vi.fn(async()=>({display:'kasm'})), dispose:vi.fn() }
  const gateway = new WorkbenchBrowsers({create:()=>worker})
  const owner={ownerId:'owner'}
  await gateway.create(owner,{id},signal())
  worker.controller=id;worker.displayConnection={id}
  await gateway.displayInput(owner,id,{attachment_id:id,connection:id,data:'AAEC'},signal())
  expect(worker.command).toHaveBeenLastCalledWith({action:'display-write',connection:id,data:'AAEC'},expect.any(AbortSignal))
  for (const data of ['', 'a', 'AA=A', 'AB==', 'A'.repeat(87388)])
    await expect(gateway.displayInput(owner,id,{attachment_id:id,connection:id,data},signal())).rejects.toMatchObject({status:400})
  await expect(gateway.displayInput({ownerId:'foreign'},id,{attachment_id:id,connection:id,data:'AA=='},signal())).rejects.toMatchObject({status:404})
  await expect(gateway.displayInput(owner,id,{attachment_id:id,connection:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',data:'AA=='},signal())).rejects.toMatchObject({status:409})
  expect(worker.closed).toBe(false)
})
it('cancels only its operation while keeping Chromium and other observers alive', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(), requests = []
  stdin.on('data', data => requests.push(JSON.parse(String(data))))
  const browser = new SandboxBrowser({spawn:spec => ({stdin,stdout,
    done:new Promise(resolve => spec.signal.addEventListener('abort',resolve))})})
  const controller = new AbortController()
  const first = browser.command({action:'navigate',url:'https://example.com'},controller.signal)
  controller.abort(new Error('view detached'))
  await expect(first).rejects.toThrow('view detached')
  expect(browser.closed).toBe(false)
  expect(browser.lifetime.signal.aborted).toBe(false)
  expect(requests.at(-1)).toEqual({action:'cancel',cancel_id:requests[0].id})
  const next = browser.command({action:'key',key:'Enter'})
  stdout.write(JSON.stringify({type:'result',id:requests.at(-1).id})+'\n')
  await expect(next).resolves.toBeUndefined()
  browser.dispose();await browser.done
})
it('bounds input and schemes without accepting command/config fields', () => {
  expect(browserAction({ action: 'navigate', url: 'https://www.baidu.com', command: 'rm' })).toEqual({ action: 'navigate', url: 'https://www.baidu.com/' })
  for (const url of ['file:///workspace/secrets', 'javascript:alert(1)', 'https://user:password@example.com'])
    expect(() => browserAction({ action: 'navigate', url })).toThrow()
  for (const request of [{action:'key',key:'evil()'}, {action:'resize',width:4000,height:800}, {action:'click',x:-1,y:0}, {action:'execute',script:'code'}])
    expect(() => browserAction(request)).toThrow()
  for(const count of [0,null,false,'']) expect(()=>browserAction({action:'click',x:0,y:0,count})).toThrow()
  expect(browserAction({action:'click',x:0,y:0})).toMatchObject({count:1,button:'left'})
})
it('keeps browser actions inside the owner binding and explicit controller lease', async () => {
  const browser = { command: vi.fn(async () => {}), dispose: vi.fn(), follow: vi.fn(), done: Promise.resolve() }
  const gateway = new WorkbenchBrowsers({ create: () => browser })
  await gateway.create({ownerId:'owner'}, {id}, signal())
  expect(browser.command).toHaveBeenCalledWith({action:'init',browser_id:id,width:1000,height:700}, expect.any(AbortSignal))
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
it('replaces only the same owner browser across chats, leaving other users isolated', async () => {
  const workers=[]
  const gateway=new WorkbenchBrowsers({create:()=> {
    let finish
    const worker={closed:false,command:vi.fn(async()=>{}),done:new Promise(resolve=>{finish=resolve}),
      dispose:vi.fn(function(){this.closed=true;finish()})}
    workers.push(worker);return worker
  },service:{requireChat:vi.fn()}})
  const root='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',next='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  await gateway.create({ownerId:'owner'},{id:root,chat_id:id},signal())
  await gateway.create({ownerId:'foreign'},{id:root,chat_id:id},signal())
  await gateway.create({ownerId:'owner'},{id:next,chat_id:next},signal())
  expect(workers[0].dispose).toHaveBeenCalledOnce()
  expect(workers[1].dispose).not.toHaveBeenCalled()
  expect(gateway.currentId({ownerId:'owner'},id)).toBeUndefined()
  expect(gateway.currentId({ownerId:'owner'},next)).toBe(next)
  expect(gateway.count('owner',id)).toBe(0)
  expect(gateway.require({ownerId:'foreign'},root)).toBe(workers[1])
  expect(()=>gateway.require({ownerId:'owner'},root)).toThrow()
  await gateway.close({ownerId:'owner'},root)
  expect(workers[2].dispose).not.toHaveBeenCalled()
  gateway.dispose()
})
it('never recreates a missing restored browser or replaces the current one while attaching', async()=>{
  const worker={closed:false,command:vi.fn(async()=>{}),dispose:vi.fn(),done:new Promise(()=>{})}
  const create=vi.fn(()=>worker),gateway=new WorkbenchBrowsers({create})
  await gateway.create({ownerId:'owner'},{id},signal())
  await expect(gateway.create({ownerId:'owner'},{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',existing:true},signal())).rejects.toMatchObject({status:404})
  expect(create).toHaveBeenCalledOnce()
  expect(worker.dispose).not.toHaveBeenCalled()
})
it('joins the initializing browser when the agent opens the same chat', async()=>{
  let ready
  const browser={closed:false,done:new Promise(()=>{}),dispose:vi.fn(),command:vi.fn(()=>new Promise(resolve=>{ready=resolve}))}
  const create=vi.fn(()=>browser),gateway=new WorkbenchBrowsers({create,service:{requireChat:vi.fn()}})
  const chatId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const first=gateway.create({ownerId:'owner'},{id,chat_id:chatId},signal())
  await vi.waitFor(()=>expect(gateway.currentId({ownerId:'owner'},chatId)).toBe(id))
  const current=gateway.currentId({ownerId:'owner'},chatId)
  expect(current).toBe(id)
  const second=gateway.create({ownerId:'owner'},{id:current,chat_id:chatId},signal())
  ready()
  await expect(first).resolves.toEqual({id})
  await expect(second).resolves.toEqual({id})
  expect(create).toHaveBeenCalledOnce()
  expect(browser.command).toHaveBeenCalledOnce()
})
it('does not remove a replacement browser when an earlier initialization fails', async () => {
  let rejectFirst, finishFirst
  const first = {closed:false,command:()=>new Promise((_,reject)=>{rejectFirst=reject}),
    done:new Promise(resolve=>{finishFirst=resolve}),dispose(){this.closed=true;finishFirst()}}
  const second = {closed:false,command:async()=>{},dispose:vi.fn()}
  let count = 0
  const gateway = new WorkbenchBrowsers({create:()=>count++ === 0 ? first : second})
  const pending = gateway.create({ownerId:'owner'},{id},signal())
  await vi.waitFor(()=>expect(rejectFirst).toBeTypeOf('function'))
  first.dispose()
  await first.done
  await gateway.create({ownerId:'owner'},{id},signal())
  rejectFirst(new Error('cancelled initialization'))
  await expect(pending).rejects.toThrow('cancelled initialization')
  expect(gateway.require({ownerId:'owner'},id)).toBe(second)
  gateway.dispose()
})
it('keeps shared initialization alive when its first browser caller disconnects', async () => {
  let ready
  const browser = { closed:false, lifetime:new AbortController(), done:new Promise(()=>{}), dispose:vi.fn(),
    command:vi.fn((_value,signal)=>new Promise((resolve,reject)=>{
      ready=resolve; signal.addEventListener('abort',()=>reject(signal.reason),{once:true})
    })) }
  const gateway=new WorkbenchBrowsers({create:()=>browser,service:{requireChat:vi.fn()}})
  const a=new AbortController(),b=new AbortController(),chatId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const first=gateway.create({ownerId:'owner'},{id,chat_id:chatId},a.signal)
  const second=gateway.create({ownerId:'owner'},{id,chat_id:chatId},b.signal)
  await vi.waitFor(()=>expect(browser.command).toHaveBeenCalledOnce())
  a.abort(new Error('first disconnected'))
  await expect(first).rejects.toThrow('first disconnected')
  expect(browser.lifetime.signal.aborted).toBe(false)
  expect(browser.dispose).not.toHaveBeenCalled()
  ready()
  await expect(second).resolves.toEqual({id})
  expect(browser.command).toHaveBeenCalledOnce()
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

it('waits for actual process exit before admitting a replacement and serializes competing opens', async()=>{
  const exits=[],workers=[]
  const gateway=new WorkbenchBrowsers({create:()=>{
    const worker={closed:false,command:async()=>{},dispose(){this.closed=true},done:new Promise(resolve=>exits.push(resolve))}
    workers.push(worker);return worker
  }})
  const a='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  await gateway.create({ownerId:'owner'},{id:a,chat_id:a},signal())
  const next=gateway.create({ownerId:'owner'},{id:b,chat_id:b},signal())
  await vi.waitFor(()=>expect(workers[0].closed).toBe(true))
  expect(workers).toHaveLength(1)
  exits[0]()
  await expect(next).resolves.toEqual({id:b})
  expect(workers).toHaveLength(2)
  const cancelled=new AbortController();cancelled.abort(new Error('cancelled open'))
  await expect(gateway.create({ownerId:'owner'},{id,chat_id:id},cancelled.signal)).rejects.toThrow('cancelled open')
  expect(workers[1].closed).toBe(false)
  gateway.dispose();for(const exit of exits)exit()
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

it('reports a nonzero subprocess exit as a connection failure even when done resolves', async () => {
  let finish
  const browser=new SandboxBrowser({spawn:()=>({stdin:new PassThrough(),stdout:new PassThrough(),done:new Promise(resolve=>{finish=resolve})})})
  const pending=browser.command({action:'init'})
  finish({exitCode:2,signal:null})
  await expect(pending).rejects.toMatchObject({status:502})
  await browser.done
  await expect(browser.follow(id,signal()).next()).rejects.toMatchObject({status:502})
})
