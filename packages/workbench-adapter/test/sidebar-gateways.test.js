import { expect, it, vi } from 'vitest'
import { WorkbenchTerminals } from '../src/terminals.js'
import { WorkbenchSubagents } from '../src/subagents.js'
import { sendError } from '../src/http.js'
const owner = { ownerId: 'signed-owner' }
const chat = { id: 'chat', sessionId: 'root' }
const child = { id: 'child', mode: 'continuable', label: '调查' }
const attachment = '12345678-1234-1234-1234-123456789abc'
const service = { requireChat: (who, id) => {
  if (who.ownerId !== owner.ownerId || id !== chat.id) throw Object.assign(new Error('missing'), { status: 404 })
  return chat
} }
it('shares a terminal allocation within one chat while other chats remain independent', async () => {
  const terminalId = '22345678-1234-1234-1234-123456789abc'
  const retained = new Map()
  let settle
  const native = {
    list: sessionId => retained.get(sessionId) || [],
    create: vi.fn((agent, request) => agent.session.id === 'chat'
      ? new Promise(resolve => { settle = () => { const terminal = { id: request.id }; retained.set('chat', [terminal]); resolve(terminal) } })
      : Promise.resolve({ id: request.id })),
  }
  const gateway = new WorkbenchTerminals({ native,
    service: { requireChat: (who, id) => { if (who.ownerId !== owner.ownerId) throw Object.assign(new Error('missing'), {status:404}); return {sessionId:id} } },
    sessions: { resolveAgent: async id => ({agent:{session:{id}}}) },
  })
  const signal = new AbortController().signal
  const first = gateway.create(owner, 'chat', {id:attachment}, signal)
  const second = gateway.create(owner, 'chat', {id:terminalId}, signal)
  await vi.waitFor(() => expect(native.create).toHaveBeenCalledOnce())
  settle()
  expect(await first).toEqual({id:attachment})
  expect(await second).toEqual({id:attachment})
  expect(await gateway.create(owner, 'chat', {id:terminalId}, signal)).toEqual({id:attachment})
  expect(native.create).toHaveBeenCalledOnce()
  for (const id of ['chat2','chat3','chat4']) await gateway.create(owner,id,{id:terminalId},signal)
  expect(native.create).toHaveBeenCalledTimes(4)
})
it('binds terminals to the signed Session and holds the native process until stream cancellation', async () => {
  const agent = { session: { id: chat.sessionId } }
  const released = vi.fn()
  const native = { list: vi.fn(() => []), create: vi.fn(), close: vi.fn(), write: vi.fn(),
    retain: vi.fn(async function* (_session, _id, signal) { try { yield { type: 'retained' }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) } finally { released() } }),
    follow: vi.fn(async function* () { yield { type: 'snapshot', screen: 'ready' } }) }
  const sessions = { resolveAgent: vi.fn(async () => ({ agent })) }
  const gateway = new WorkbenchTerminals({ native, service, sessions })
  await expect(gateway.create({ ownerId: 'foreign' }, chat.id, { id: attachment }, new AbortController().signal)).rejects.toMatchObject({ status: 404 })
  expect(native.create).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  const stream = gateway.follow(owner, chat.id, attachment, attachment, signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ event: 'workbench_terminal', value: { type: 'snapshot', screen: 'ready' } })
  expect(native.retain).toHaveBeenCalledWith(chat.sessionId, attachment, expect.any(AbortSignal))
  await stream.return()
  expect(released).toHaveBeenCalledOnce()
  await expect(gateway.control(owner, chat.id, attachment, 'write', { attachment_id: 'invalid' })).rejects.toMatchObject({ status: 400 })
  expect(native.write).not.toHaveBeenCalled()
})
it('authorizes native child history only through its parent catalog and rejects external local addresses', async () => {
  const sessions = { list: vi.fn(async () => ({ items: [
    { sessionId: 'root', projections: { values: { subagentCatalog: [child, { id: 'external', mode: 'external' }] } } },
    { sessionId: 'child', running: true, projections: { values: { title: '原生标题' } } },
    { sessionId: 'foreign' },
  ] })), page: vi.fn(async () => ({ records: [], hasMore: false })) }
  const gateway = new WorkbenchSubagents({ sessions, service })
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
  const native = { prompt: vi.fn(async () => ({ messageId: 'accepted' })) }
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
  const gateway = new WorkbenchSubagents({ sessions, service })
  const result = await gateway.history(owner, chat.id, child.id, { sessionId: child.id, throughSeq: 9, beforeSeq: 5 }, new AbortController().signal)
  expect(result.history_cursor).toBeNull()
  expect(sessions.page.mock.calls[1][0].address).toMatchObject({ kind: 'subagent', childSessionId: child.id })
})

it.each(['subagent/invalid-time-zone','subagent/parent-unavailable'])('settles a new rejected child receipt for native %s without an HTTP status', async code => {
  const error = { isDSHRemoteError: true, code }
  const receipt = { requestKey: `subagent-prompt:${child.id}:${attachment}`, status: 'running' }
  const runtime = { prepareChildPrompt: () => receipt, rejectChildPrompt: vi.fn() }
  const sessions = { list: async () => ({ items: [{ sessionId: 'root', projections: { values: { subagentCatalog: [child] } } }] }) }
  const gateway = new WorkbenchSubagents({ sessions, service, runtime, native: { prompt: async () => { throw error } } })
  await expect(gateway.prompt(owner,chat.id,child.id,{requestId:attachment,text:'continue'},new AbortController().signal)).rejects.toBe(error)
  expect(runtime.rejectChildPrompt).toHaveBeenCalledWith(receipt)
})
it('admits image-only continuation through the native image store and scopes binary reads to the owner', async () => {
  const native = {prompt:vi.fn(async () => ({messageId:'accepted'}))}
  const attachments = {readImage:vi.fn(async ref => ({ref,data:Buffer.from('image')}))}
  const sessions = {list:async () => ({items:[{sessionId:'root',agentAvailable:true,projections:{values:{subagentCatalog:[child]}}}]})}
  const gateway = new WorkbenchSubagents({native,sessions,service,attachments})
  const signal = new AbortController().signal
  const image = {mediaType:'image/png',data:'aW1hZ2U=',name:'调研.png'}
  await gateway.prompt(owner,chat.id,child.id,{requestId:attachment,text:'',images:[image]},signal)
  expect(native.prompt).toHaveBeenCalledWith(expect.objectContaining({content:[{type:'image',...image}]}),signal)
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
  const gateway = new WorkbenchSubagents({sessions,service})
  const result = await gateway.history(owner,chat.id,child.id,{sessionId:child.id,throughSeq:2,beforeSeq:3},new AbortController().signal)
  expect(result.runs[0].attachments).toEqual([{name:'调查.png',path:'native-image:image-id',size:12,native_image:{parentChatId:chat.id,childId:child.id,ref}}])
})

it('renders the first child user message once and retains later steering messages', async () => {
  const event = (seq,id,rpcId,text) => ({event:{seq,time:1000+seq,type:'user/message',data:{id,source:{kind:'user',rpcId},content:[{type:'text',text}]}}})
  const sessions={list:async()=>({items:[{sessionId:'root',projections:{values:{subagentCatalog:[child]}}}]}),page:async()=>({hasMore:false,records:[
    {event:{seq:1,time:1000,type:'turn/start',data:{turn:1}}},event(2,'first','request-first','首条'),event(3,'second','request-second','追加'),
  ]})}
  const gateway=new WorkbenchSubagents({sessions,service})
  const result=await gateway.history(owner,chat.id,child.id,{sessionId:child.id,throughSeq:3,beforeSeq:4},new AbortController().signal)
  expect(result.runs[0]).toMatchObject({query:'首条',message_id:'first'})
  expect(result.runs[0].events.filter(e=>e.event==='workbench_steering').map(e=>e.query)).toEqual(['追加'])
})
