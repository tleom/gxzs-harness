import { expect, it, vi } from 'vitest'
import { WorkbenchTerminals } from '../src/terminals.js'
import { WorkbenchSubagents } from '../src/subagents.js'

it('preserves the native capacity code so the UI and Agent can reuse an existing terminal', async () => {
  const native={list:()=>[],create:vi.fn(async()=>{throw Object.assign(new Error('limit'),{code:'terminal/limit-reached'})})}
  const gateway=new WorkbenchTerminals({native,service:{requireChat:()=>({sessionId:'root'})},sessions:{resolveAgent:async()=>({agent:{session:{id:'root'}}})}})
  await expect(gateway.create({ownerId:'owner'},'chat',{id:'12345678-1234-1234-1234-123456789abc',cols:80,rows:24},new AbortController().signal))
    .rejects.toMatchObject({status:409,code:'terminal/limit-reached'})
  expect(gateway.creating.size).toBe(0)
})
import { sendError } from '../src/http.js'
const owner = { ownerId: 'signed-owner' }
const chat = { id: 'chat', sessionId: 'root' }
const child = { id: 'child', mode: 'continuable', label: '调查' }
const descendants = entries => vi.fn(async () => entries.map(entry => ({ ...entry, kind: 'child', parentId: 'root', depth: 1, activity: 'inactive', hasChildren: false })))
const attachment = '12345678-1234-1234-1234-123456789abc'
const service = { requireChat: (who, id) => {
  if (who.ownerId !== owner.ownerId || id !== chat.id) throw Object.assign(new Error('missing'), { status: 404 })
  return chat
} }
it('reads child references from a disposable native observation without waking either Agent', async () => {
  const disposed=vi.fn(), observed={header:{id:'grandchild',parentSession:'child'},[Symbol.dispose]:disposed}
  const scoped={...service,sessionQuery:{observeSession:vi.fn(async()=>observed)},
    observedReferenceCandidates:vi.fn(async()=>[{path:'child.md',kind:'file'}])}
  const gateway=new WorkbenchSubagents({service:scoped,native:{listDescendants:async()=>[
    {id:'grandchild',kind:'child',mode:'continuable',parentId:'child',depth:2},
  ]},sessions:{list:async()=>({items:[]})}})
  const signal=new AbortController().signal
  expect(await gateway.references(owner,chat.id,'grandchild','',signal)).toHaveLength(1)
  expect(scoped.sessionQuery.observeSession).toHaveBeenCalledWith('grandchild',{signal})
  expect(scoped.observedReferenceCandidates).toHaveBeenCalledWith(owner,observed,'',signal)
  expect(disposed).toHaveBeenCalledOnce()
  await expect(gateway.references({ownerId:'foreign'},chat.id,'grandchild','',signal)).rejects.toMatchObject({status:404})
  await expect(gateway.references(owner,chat.id,'other','',signal)).rejects.toMatchObject({status:404})
  observed.header.parentSession='wrong-parent'
  await expect(gateway.references(owner,chat.id,'grandchild','',signal)).rejects.toMatchObject({status:403})
  expect(disposed).toHaveBeenCalledTimes(2)
  observed.header.parentSession='child'
  scoped.observedReferenceCandidates.mockRejectedValue(new Error('provider failed'))
  await expect(gateway.references(owner,chat.id,'grandchild','',signal)).rejects.toThrow('provider failed')
  expect(disposed).toHaveBeenCalledTimes(3)
})
it('allocates multiple terminals per chat and across chats, joining only retries of the same id', async () => {
  const retained=new Map(),pending=new Map()
  const native={list:sessionId=>retained.get(sessionId)||[],close:vi.fn(),create:vi.fn((agent,request)=>new Promise(resolve=>{
    pending.set(request.id,()=>{
      const info={id:request.id,state:'running'}
      retained.set(agent.session.id,[...(retained.get(agent.session.id)||[]),info]);resolve(info)
    })
  }))}
  const gateway=new WorkbenchTerminals({native,service:{requireChat:(who,id)=>{
    if(who.ownerId!==owner.ownerId) throw Object.assign(new Error('missing'),{status:404})
    return {sessionId:id}
  }},sessions:{resolveAgent:async id=>({agent:{session:{id}}})}})
  const secondId='22345678-1234-1234-1234-123456789abc',signal=new AbortController().signal
  const first=gateway.create(owner,'chat',{id:attachment},signal)
  const duplicate=gateway.create(owner,'chat',{id:attachment},signal)
  const second=gateway.create(owner,'chat',{id:secondId},signal)
  await vi.waitFor(()=>expect(native.create).toHaveBeenCalledTimes(2))
  pending.get(attachment)();pending.get(secondId)()
  expect(await first).toEqual({id:attachment,state:'running'})
  expect(await duplicate).toEqual(await first)
  expect(await second).toEqual({id:secondId,state:'running'})
  expect(await gateway.create(owner,'chat',{id:attachment},signal)).toEqual(await first)
  expect(native.create).toHaveBeenCalledTimes(2)
  expect(native.close).not.toHaveBeenCalled()
  for(const chatId of ['chat2','chat3','chat4']){
    const request=gateway.create(owner,chatId,{id:secondId},signal)
    await vi.waitFor(()=>expect(native.create).toHaveBeenCalledTimes(Number(chatId.at(-1))+1))
    pending.get(secondId)();await request
  }
})
it.each([false,true])('shares allocation cancellation across connected terminal callers: all disconnected %s', async all => {
  let complete, lifetime
  const native={list:()=>[],create:vi.fn((_agent,request,signal)=>new Promise((resolve,reject)=>{
    lifetime=signal; complete=()=>resolve({id:request.id,state:'running'}); signal.addEventListener('abort',()=>reject(signal.reason),{once:true})
  }))}
  const gateway=new WorkbenchTerminals({native,service,sessions:{resolveAgent:async()=>({agent:{session:{id:'root'}}})}})
  const a=new AbortController(),b=new AbortController()
  const first=gateway.create(owner,chat.id,{id:attachment},a.signal), second=gateway.create(owner,chat.id,{id:attachment},b.signal)
  await vi.waitFor(()=>expect(native.create).toHaveBeenCalledOnce())
  a.abort(new Error('first disconnected'))
  await expect(first).rejects.toThrow('first disconnected')
  expect(lifetime.aborted).toBe(false)
  if(all){b.abort(new Error('all disconnected')); await expect(second).rejects.toThrow('all disconnected'); expect(lifetime.aborted).toBe(true)}
  else {complete(); await expect(second).resolves.toMatchObject({id:attachment,state:'running'})}
})
it('preserves other exited terminal tabs while allocating a usable shell', async () => {
  const native={list:()=>[{id:attachment,state:'exited'}],close:vi.fn(async()=>{}),create:vi.fn(async(_agent,request)=>({id:request.id,state:'running'}))}
  const gateway=new WorkbenchTerminals({native,service,sessions:{resolveAgent:async()=>({agent:{session:{id:'root'}}})}})
  const id='22345678-1234-1234-1234-123456789abc'
  await expect(gateway.create(owner,chat.id,{id},new AbortController().signal)).resolves.toEqual({id,state:'running'})
  expect(native.close).not.toHaveBeenCalled()
})
it('waits for cancelled terminal cleanup before allocating for a reconnecting caller', async () => {
  let finishCleanup, lifetime
  const native={list:()=>[],create:vi.fn((_agent,request,signal)=>{
    if(native.create.mock.calls.length>1) return Promise.resolve({id:request.id,state:'running'})
    lifetime=signal
    return new Promise((_,reject)=>{ finishCleanup=()=>reject(new Error('old allocation cancelled')) })
  })}
  const gateway=new WorkbenchTerminals({native,service,sessions:{resolveAgent:async()=>({agent:{session:{id:'root'}}})}})
  const firstAbort=new AbortController()
  const first=gateway.create(owner,chat.id,{id:attachment},firstAbort.signal)
  await vi.waitFor(()=>expect(native.create).toHaveBeenCalledOnce())
  firstAbort.abort(new Error('disconnected'))
  await expect(first).rejects.toThrow('disconnected')
  expect(lifetime.aborted).toBe(true)
  const id=attachment
  const replacement=gateway.create(owner,chat.id,{id},new AbortController().signal)
  await Promise.resolve(); await Promise.resolve()
  expect(native.create).toHaveBeenCalledOnce()
  finishCleanup()
  await expect(replacement).resolves.toEqual({id,state:'running'})
  expect(native.create).toHaveBeenCalledTimes(2)
})
it('binds terminals to the signed Session and holds the native process until stream cancellation', async () => {
  const agent = { session: { id: chat.sessionId } }
  const released = vi.fn()
  const native = { list: vi.fn(() => []), create: vi.fn(), close: vi.fn(),
    environment: () => ({ maxBufferedBytes: 1024 }),
    retain: vi.fn(async function* (_session, _id, signal) { try { yield { type: 'retained' }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) } finally { released() } }) }
  const peer = { dispose: vi.fn(async () => {}) }
  const connection = { createPeer: vi.fn(() => peer) }
  const remote = { stream: vi.fn(async () => (async function* () { yield { type: 'snapshot', screen: 'ready' } })()) }
  const sessions = { resolveAgent: vi.fn(async () => ({ agent })) }
  const gateway = new WorkbenchTerminals({ native, service, sessions, connection, gateway: remote })
  await expect(gateway.create({ ownerId: 'foreign' }, chat.id, { id: attachment }, new AbortController().signal)).rejects.toMatchObject({ status: 404 })
  expect(native.create).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  const stream = gateway.follow(owner, chat.id, attachment, attachment, signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ event: 'workbench_terminal', value: { type: 'snapshot', screen: 'ready', environment: { maxBufferedBytes: 1024 } } })
  expect(remote.stream).toHaveBeenCalledWith(expect.objectContaining({ peer, namespace: 'terminal', method: 'attach', args: { agentId: chat.sessionId, id: attachment } }))
  expect(native.retain).toHaveBeenCalledWith(chat.sessionId, attachment, expect.any(AbortSignal))
  await stream.return()
  expect(released).toHaveBeenCalledOnce()
  expect(peer.dispose).toHaveBeenCalledOnce()
  await expect(gateway.control(owner, chat.id, attachment, 'write', { attachment_id: 'invalid' })).rejects.toMatchObject({ status: 400 })
  expect(gateway.attachments.size).toBe(0)
})
it('rejects invalid terminal inputs before the native stream and detaches on adapter unload', async () => {
  const gateway = new WorkbenchTerminals({ native: {}, service,
    sessions: { resolveAgent: async () => ({ agent: { session: { id: chat.sessionId } } }) } })
  const send = vi.fn(async () => {}), abort = vi.fn()
  gateway.attachments.set(`${owner.ownerId}/${chat.id}/${attachment}/${attachment}`, {
    uplink: { send }, abort, environment: { maxInputBytes: 4, maxCols: 500, maxRows: 200 },
  })
  await expect(gateway.control(owner, chat.id, attachment, 'write', { attachment_id: attachment, data: '中文' }))
    .rejects.toMatchObject({ status: 413 })
  await expect(gateway.control(owner, chat.id, attachment, 'resize', { attachment_id: attachment, cols: 1, rows: 10 }))
    .rejects.toMatchObject({ status: 400 })
  expect(send).not.toHaveBeenCalled()
  await gateway.control(owner, chat.id, attachment, 'resize', { attachment_id: attachment, cols: 80, rows: 24 })
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'resize', cols: 80, rows: 24 })
  const pending = new AbortController()
  gateway.creating.set('pending', { controller: pending })
  gateway.dispose()
  expect(abort).toHaveBeenCalledOnce()
  expect(pending.signal.aborted).toBe(true)
  expect(gateway.attachments.size).toBe(0)
})
it.each(['create','follow','control'])('does not start %s after disposal during Session resolution',async action=>{
  let resolve
  const native={create:vi.fn(),list:vi.fn(()=>[]),close:vi.fn(),retain:vi.fn()}
  const connection={createPeer:vi.fn()}
  const sessions={resolveAgent:vi.fn(()=>new Promise(done=>{resolve=done}))}
  const gateway=new WorkbenchTerminals({native,service,sessions,connection})
  const signal=new AbortController().signal
  const pending=action==='create'?gateway.create(owner,chat.id,{id:attachment},signal)
    :action==='follow'?gateway.follow(owner,chat.id,attachment,attachment,signal).next()
    :gateway.control(owner,chat.id,attachment,'close',{})
  const result=expect(pending).rejects.toMatchObject({status:503})
  gateway.dispose()
  resolve({agent:{session:{id:chat.sessionId}}})
  await result
  expect(native.create).not.toHaveBeenCalled()
  expect(native.close).not.toHaveBeenCalled()
  expect(connection.createPeer).not.toHaveBeenCalled()
  expect(gateway.knownSessions.size).toBe(0)
  await expect(gateway.create(owner,chat.id,{id:attachment},signal)).rejects.toMatchObject({status:503})
  expect(sessions.resolveAgent).toHaveBeenCalledOnce()
})
it.each([false,true])('distinguishes deleted terminals from retained closing slots: retained %s',async retained=>{
  const failure={isDSHRemoteError:true,code:'terminal/unavailable'}
  const native={environment:()=>({maxBufferedBytes:1024}),list:()=>retained?[{id:attachment}]:[],retain:()=>{throw failure}}
  const peer={dispose:vi.fn(async()=>{})}
  const gateway=new WorkbenchTerminals({native,service,sessions:{resolveAgent:async()=>({agent:{session:{id:chat.sessionId}}})},connection:{createPeer:()=>peer}})
  const stream=gateway.follow(owner,chat.id,attachment,attachment,new AbortController().signal)
  let error
  try{await stream.next()}catch(reason){error=reason}
  const res={writeHead:vi.fn(),end:vi.fn()}
  sendError(res,error)
  expect(res.writeHead.mock.calls[0][0]).toBe(retained?409:404)
  expect(peer.dispose).toHaveBeenCalledOnce()
  expect(gateway.attachments.size).toBe(0)
})
it('authorizes native child history only through its parent catalog and rejects external local addresses', async () => {
  const sessions = { list: vi.fn(async () => ({ items: [
    { sessionId: 'root', projections: { values: { subagentCatalog: [child, { id: 'external', mode: 'external' }] } } },
    { sessionId: 'child', running: true, projections: { values: { title: '原生标题' } } },
    { sessionId: 'foreign' },
  ] })), page: vi.fn(async () => ({ records: [], hasMore: false })) }
  const native = { listDescendants: descendants([child, { id: 'external', mode: 'external' }]) }
  const gateway = new WorkbenchSubagents({ sessions, service, native })
  const signal = new AbortController().signal
  expect((await gateway.catalog(owner, chat.id, signal))[0]).toMatchObject({ title: '调查', summary: '原生标题', running: true })
  await expect(gateway.history(owner, chat.id, 'foreign', {}, signal)).rejects.toMatchObject({ status: 404 })
  await expect(gateway.history(owner, chat.id, 'external', {}, signal)).rejects.toMatchObject({ status: 409 })
  await expect(gateway.history(owner, chat.id, child.id, { sessionId: 'foreign', throughSeq: 9, beforeSeq: 5 }, signal)).rejects.toMatchObject({ status: 400 })
  expect(sessions.page).not.toHaveBeenCalled()
  const result = await gateway.history(owner, chat.id, child.id, { sessionId: 'child', throughSeq: 9, beforeSeq: 5 }, signal)
  expect(sessions.page.mock.calls[0][0].address).toEqual({ kind: 'subagent', parentSessionId: 'root', childSessionId: 'child', mode: 'continuable' })
  expect(result.history_cursor).toBeNull()
})
it('returns stable input and terminal errors without publishing internal diagnostics', () => {
  const res = { writeHead: vi.fn(), end: vi.fn() }
  sendError(res, Object.assign(new Error('/private/config'), { name: 'ScheduleInputError', code: 'frequency_too_high' }))
  expect(res.writeHead.mock.calls[0][0]).toBe(400)
  expect(res.end.mock.calls[0][0]).not.toContain('/private')
  sendError(res, { isDSHRemoteError: true, code: 'terminal/unavailable', message: '/host/path' })
  expect(res.writeHead.mock.calls[1][0]).toBe(404)
})
it('routes only an owned continuable child through native subagent delivery', async () => {
  const native = { listDescendants: descendants([child, { id: 'once', mode: 'one-shot' }]), prompt: vi.fn(async () => ({ messageId: 'accepted' })) }
  const sessions = { list: async () => ({ items: [{ sessionId: 'root', agentAvailable: true, projections: { values: { subagentCatalog: [child, { id:'once', mode:'one-shot' }] } } }] }) }
  const gateway = new WorkbenchSubagents({ native, sessions, service })
  const request = { requestId:attachment, text:'继续调研' }, signal = new AbortController().signal
  await expect(gateway.prompt(owner,chat.id,'once',request,signal)).rejects.toMatchObject({status:409})
  await expect(gateway.prompt(owner,chat.id,'foreign',request,signal)).rejects.toMatchObject({status:404})
  expect(native.prompt).not.toHaveBeenCalled()
  await expect(gateway.prompt(owner,chat.id,child.id,request,signal)).resolves.toEqual({messageId:'accepted'})
  expect(native.prompt).toHaveBeenCalledWith({parentSessionId:'root',childSessionId:'child',mode:'continuable',delivery:'queue',requestId:attachment,content:[{type:'text',text:'继续调研'}]},signal)
})
it('hides a child cursor when only its descriptor metadata precedes the visible history', async () => {
  const sessions = { list: async () => ({ items: [{ sessionId: 'root', projections: { values: { subagentCatalog: [child] } } }] }),
    page: vi.fn(async request => request.maxMessages === 1
      ? { records: [{ event: { seq: 0, type: 'subagent/descriptor', data: {} } }], hasMore: false }
      : { records: [{ event: { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } } }], hasMore: true }) }
  const gateway = new WorkbenchSubagents({ sessions, service, native: { listDescendants: descendants([child]) } })
  const result = await gateway.history(owner, chat.id, child.id, { sessionId: child.id, throughSeq: 9, beforeSeq: 5 }, new AbortController().signal)
  expect(result.history_cursor).toBeNull()
  expect(sessions.page.mock.calls[1][0].address).toMatchObject({ kind: 'subagent', childSessionId: child.id })
})

it.each(['subagent/invalid-time-zone','subagent/parent-unavailable'])('settles a new rejected child receipt for native %s without an HTTP status', async code => {
  const error = { isDSHRemoteError: true, code }
  const receipt = { requestKey: `subagent-prompt:${child.id}:${attachment}`, status: 'running' }
  const runtime = { prepareChildPrompt: () => receipt, rejectChildPrompt: vi.fn() }
  const sessions = { list: async () => ({ items: [{ sessionId: 'root', projections: { values: { subagentCatalog: [child] } } }] }) }
  const gateway = new WorkbenchSubagents({ sessions, service, runtime, native: { listDescendants: descendants([child]), prompt: async () => { throw error } } })
  await expect(gateway.prompt(owner,chat.id,child.id,{requestId:attachment,text:'continue'},new AbortController().signal)).rejects.toBe(error)
  expect(runtime.rejectChildPrompt).toHaveBeenCalledWith(receipt)
})
it('admits image-only continuation through the native image store and scopes binary reads to the owner', async () => {
  const native = {listDescendants:descendants([child]),prompt:vi.fn(async () => ({messageId:'accepted'}))}
  const attachments = {saveImage:vi.fn(async () => ({attachmentId:'normalized',mediaType:'image/png'})),readImage:vi.fn(async ref => ({ref,data:Buffer.from('image')}))}
  const sessions = {list:async () => ({items:[{sessionId:'root',agentAvailable:true,projections:{values:{subagentCatalog:[child]}}}]})}
  const gateway = new WorkbenchSubagents({native,sessions,service,attachments})
  const signal = new AbortController().signal
  const image = {mediaType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',name:'调研.png'}
  await gateway.prompt(owner,chat.id,child.id,{requestId:attachment,text:'',images:[image]},signal)
  expect(native.prompt).toHaveBeenCalledWith(expect.objectContaining({content:[{type:'image',...image,data:'aW1hZ2U='}]}),signal)
  expect(attachments.saveImage).toHaveBeenCalledOnce()
  attachments.readImage.mockClear()
  await expect(gateway.prompt(owner,chat.id,child.id,{requestId:attachment,text:'',images:[{...image,mediaType:'text/html'}]},signal)).rejects.toMatchObject({status:400})
  const ref = {attachmentId:'image-id',mediaType:'image/png'}
  await expect(gateway.image({ownerId:'foreign'},chat.id,child.id,ref,signal)).rejects.toMatchObject({status:404})
  expect(attachments.readImage).not.toHaveBeenCalled()
  await gateway.image(owner,chat.id,child.id,ref,signal)
  expect(attachments.readImage).toHaveBeenCalledWith(ref,signal)
})
it('presents stored child image references through the shared attachment renderer', async () => {
  const ref = {attachmentId:'image-id',mediaType:'image/png',name:'调查.png',bytes:12,width:1,height:1}
  const sessions = {list:async () => ({items:[{sessionId:'root',projections:{values:{subagentCatalog:[child]}}}]}),page:async () => ({hasMore:false,records:[
    {event:{seq:1,time:1000,type:'turn/start',data:{turn:1}}},
    {event:{seq:2,time:1001,type:'user/message',data:{source:{kind:'user'},content:[{type:'image',attachment:ref}]}}},
  ]})}
  const gateway = new WorkbenchSubagents({sessions,service,native:{listDescendants:descendants([child])}})
  const result = await gateway.history(owner,chat.id,child.id,{sessionId:child.id,throughSeq:2,beforeSeq:3},new AbortController().signal)
  expect(result.runs[0].attachments).toEqual([{name:'调查.png',path:'native-image:image-id',size:12,native_image:{parentChatId:chat.id,childId:child.id,ref}}])
})

it('renders the first child user message once and retains later steering messages', async () => {
  const event = (seq,id,rpcId,text) => ({event:{seq,time:1000+seq,type:'user/message',data:{id,source:{kind:'user',rpcId},content:[{type:'text',text}]}}})
  const sessions={list:async()=>({items:[{sessionId:'root',projections:{values:{subagentCatalog:[child]}}}]}),page:async()=>({hasMore:false,records:[
    {event:{seq:1,time:1000,type:'turn/start',data:{turn:1}}},event(2,'first','request-first','首条'),event(3,'second','request-second','追加'),
  ]})}
  const gateway=new WorkbenchSubagents({sessions,service,native:{listDescendants:descendants([child])}})
  const result=await gateway.history(owner,chat.id,child.id,{sessionId:child.id,throughSeq:3,beforeSeq:4},new AbortController().signal)
  expect(result.runs[0]).toMatchObject({query:'首条',message_id:'first'})
  expect(result.runs[0].events.filter(e=>e.event==='workbench_steering').map(e=>e.query)).toEqual(['追加'])
})

it('uses the native recursive catalog and the true direct parent for nested history, steering and offline interruption', async () => {
  const native = { listDescendants: vi.fn(async () => [
    { ...child, kind: 'child', parentId: 'root', depth: 1, hasChildren: true },
    { id: 'grandchild', label: '复核', mode: 'continuable', kind: 'child', parentId: 'child', depth: 2, hasChildren: false },
    { id: 'unknown', kind: 'diagnostic', parentId: 'root', depth: 1, reason: 'unsupported' },
  ]), prompt: vi.fn(async () => ({ messageId: 'accepted' })), interruptByParent: vi.fn(() => ({ accepted: true })) }
  const sessions = { list: vi.fn(async () => ({ items: [
    { sessionId: 'root', agentAvailable: true }, { sessionId: 'child', agentAvailable: false },
    { sessionId: 'grandchild', running: true, projections: { values: { inbox: { 'next-turn': [{ id: 'queued' }], 'next-step': [] } } } },
  ] })), page: vi.fn(async () => ({ records: [], hasMore: false })), updateQueue: vi.fn(async () => ({ accepted: true })) }
  const gateway = new WorkbenchSubagents({ native, sessions, service })
  const signal = new AbortController().signal
  expect(await gateway.catalog(owner, chat.id, signal)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'grandchild', depth: 2, parentSessionId: 'child', parentAvailable: false, running: true }),
    expect.objectContaining({ id: 'unknown', mode: 'unknown', reason: 'unsupported' }),
  ]))
  await gateway.history(owner, chat.id, 'grandchild', { sessionId: 'grandchild', throughSeq: 2, beforeSeq: 3 }, signal)
  expect(sessions.page).toHaveBeenCalledWith(expect.objectContaining({ address: { kind: 'subagent', parentSessionId: 'child', childSessionId: 'grandchild', mode: 'continuable' } }), signal)
  await gateway.prompt(owner, chat.id, 'grandchild', { requestId: attachment, text: '立即纠正', delivery: 'steer' }, signal)
  expect(native.prompt).toHaveBeenCalledWith(expect.objectContaining({ parentSessionId: 'child', delivery: 'steer' }), signal)
  await gateway.stop(owner, chat.id, 'grandchild', signal)
  expect(native.interruptByParent).toHaveBeenCalledWith('grandchild', 'child', 'continuable')
  const action = { kind: 'edit', content: [{ type: 'text', text: '更新队列' }] }
  await gateway.updateQueue(owner, chat.id, 'grandchild', { itemId: 'queued', action }, signal)
  expect(sessions.updateQueue).toHaveBeenCalledWith({ sessionId: 'grandchild', itemId: 'queued', action })
  await expect(gateway.stop(owner, chat.id, 'foreign', signal)).rejects.toMatchObject({ status: 404 })
  await expect(gateway.prompt(owner, chat.id, 'grandchild', { requestId: attachment, text: 'bad', delivery: 'invalid' }, signal)).rejects.toMatchObject({ status: 400 })
})

it('does not present an unreadable native catalog as an empty catalog or an unknown parent as offline', async () => {
  const native = { listDescendants: descendants([child]) }
  const gateway = new WorkbenchSubagents({ native, service, sessions: { list: async () => ({ items: [] }) } })
  expect((await gateway.catalog(owner, chat.id))[0].parentAvailable).toBeUndefined()
  native.listDescendants.mockRejectedValue(new Error('catalog unavailable'))
  await expect(gateway.catalog(owner, chat.id)).rejects.toThrow('catalog unavailable')
})
