import { createHash, createHmac, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, waitSessionActivity } from '../src/index.js'
import { publishedModels } from './model-fixture.js'

const cleanups = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function setup() {
  const key = Buffer.alloc(32, 9).toString('base64')
  vi.stubEnv('TEST_ASSERTION_KEY', key)
  const sessions = new Map()
  let handler
  const context = {
    get: name => context[name],
    webServer: { register: vi.fn((route) => { handler = route.handler; return () => {} }) },
    sessionController: {
      modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, groups: [{ id: 'p', models: [{ id: 'm' }] }] }),
      create: async (request = {}) => {
        const sessionId = request.sessionId || randomUUID()
        sessions.set(sessionId, { id: sessionId, seq: 0, append: vi.fn(function () { this.seq += 1; return { seq: this.seq - 1 } }) })
        return { sessionId }
      },
      prompt: async () => ({ accepted: true }),
      selectModel: async () => ({ selected: { provider: 'p', model: 'm' } }),
      rename: async ({ title }) => ({ title, seq: 1 }),
    },
    fs: {}, workbenchFileManager: {
      workspaceId: '33333333-3333-4333-8333-333333333333',
      operate: vi.fn(async (payload) => {
        if (payload.operation === 'manifest') return { version: 'tree-v1', items: 0, size: 0, files: [] }
        if (payload.operation === 'list') return {
          path: payload.path,
          entries: [{ name: 'a.bin', path: `${payload.path}/a.bin`, kind: 'file', size: 2, version: null, downloadable: true }],
        }
        if (payload.operation === 'stat') return {
          name: 'a.bin', path: payload.path, kind: 'file', size: 2, version: 'sha256-v1', downloadable: true,
        }
        if (payload.operation === 'get') return { name: 'a.bin', data: 'AP8=', version: 'sha256-v1' }
        return { path: payload.path, version: 'v1', deleted: payload.operation === 'delete' }
      }),
    },
    workbenchPlatformClient: {
      request: vi.fn(async () => ({ status: 200, headers: new Headers({ 'content-type': 'application/json' }), bytes: Buffer.from('{"data":{"text":"ok"}}') })),
      json: vi.fn(async ({ route }) => route === 'workbench/config' ? publishedModels() : ({ tools: [] })),
    },
    agents: { get: (id) => sessions.has(id) ? { id, session: sessions.get(id) } : undefined }, commands: {},
    logger: { warn: vi.fn() },
    skills: { list: vi.fn(async () => []), get: async () => undefined },
    tokenMeter: { measure: vi.fn(() => ({ totalTokens: 0, baseline: { kind: 'none' } })) },
    systemPrompt: { section: vi.fn(() => () => {}), getSectionOrder: () => 3000 },
    tools: { register: vi.fn(() => () => {}) },
    on: vi.fn(), emit: vi.fn(), reflect: { provide: vi.fn() },
    effect: (factory) => cleanups.push(factory()),
  }
  apply(context, {
    basePath: '/ai/workbench', databasePath: ':memory:', workspace: '/workspace',
    assertionIssuer: 'gxzs', assertionAudiencePath: '/console/api/workbench', assertionKeyEnv: 'TEST_ASSERTION_KEY',
    ownerId: 't:42', humanInputTimeoutSeconds: 60,
  })
  cleanups.push(() => vi.unstubAllEnvs())
  return { handler, key, context }
}

async function call(handler, key, method, route, value, authenticated = true, userId = '42', extraHeaders = {}, onResponse) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value))
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: 'gxzs', aud: 'agent-workbench', sub: `t:${userId}`, tenant_id: 't', user_id: userId, name: '用户',
    iat: now, exp: now + 60, jti: randomUUID(), method,
    target: `/console/api/workbench${route}`, body_sha256: createHash('sha256').update(body).digest('hex'),
    content_type: 'application/json', last_event_id: '',
  })).toString('base64url')
  const signature = createHmac('sha256', Buffer.from(key, 'base64')).update(`${header}.${payload}`).digest('base64url')
  const req = Readable.from(body.length ? [body] : [])
  req.method = method
  req.url = `/ai/workbench${route}`
  req.headers = { 'content-type': 'application/json', ...(authenticated ? { 'x-gxzs-assertion': `${header}.${payload}.${signature}` } : {}), ...extraHeaders }
  const response = { status: undefined, body: undefined, chunks: [] }
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(status, headers) { response.status = status; response.headers = headers; this.headersSent = true },
    write(text) { response.chunks.push(text); return true },
    end(text) {
      if (!text) response.body = undefined
      else { try { response.body = JSON.parse(text) } catch { response.body = Buffer.from(text) } }
    },
  })
  onResponse?.(res)
  await handler(req, res)
  return response
}

describe('authenticated workbench HTTP handler', () => {
  it('cancels the owner file read when its response connection closes', async () => {
    const { handler, key, context } = setup()
    const previous = context.workbenchFileManager.operate.getMockImplementation()
    let entered, response, observedSignal
    const reading = new Promise(resolve => { entered = resolve })
    context.workbenchFileManager.operate.mockImplementation((payload, signal) => {
      if (payload.operation !== 'stat') return previous(payload, signal)
      observedSignal = signal
      entered()
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const request = call(handler, key, 'GET', '/files/stat?path=a.bin', undefined, true, '42', {}, res => { response = res })
    await reading
    response.destroyed = true
    response.emit('close')
    const result = await request
    expect(observedSignal.aborted).toBe(true)
    expect(result.status).toBeUndefined()
    expect(response.listenerCount('close')).toBe(0)
  })
  it('bounds a stalled native activity query without deleting private files', async () => {
    const context = { waterfall: vi.fn(() => new Promise(() => {})) }
    await expect(waitSessionActivity(context, 'session', { timeoutMs: 20 })).rejects.toThrow('did not settle')
    expect(context.waterfall).toHaveBeenCalledOnce()
  })
  it('blocks file deletion while a completed parent still owns background children', async () => {
    const { handler, key, context } = setup()
    const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    const sessionId = runtime.database.getChat('t:42', chat.id).sessionId
    runtime.hasOwnedWork = vi.fn(id => id === sessionId)
    const response = await call(handler, key, 'DELETE', '/files', { path: 'case/a.txt' })
    expect(response.status).toBe(409)
    expect(context.workbenchFileManager.operate.mock.calls.some(([request]) => request.operation === 'delete')).toBe(false)
    runtime.hasOwnedWork = () => false
    expect((await call(handler, key, 'DELETE', '/files', { path: 'case/a.txt' })).status).toBe(200)
  })
  it('defers a live scheduled receipt until the first verified MCP catalog', async () => {
    const { handler, key, context } = setup()
    const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpCatalogState = { ready: false }
    const sessionId = runtime.database.getChat('t:42', chat.id).sessionId
    const payload = { agent: { id: sessionId }, message: { id: 'live-schedule', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'scheduled prompt' }] }, turn: 1 }
    const claim = context.on.mock.calls.find(([name]) => name === 'agent/inbox/claimed')[1]
    const onEvent = context.on.mock.calls.find(([name]) => name === 'session/event')[1]
    onEvent({ id: sessionId }, { type: 'agent/inbox/spliced', seq: 0, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [payload.message] } })
    onEvent({ id: sessionId }, { type: 'user/message', seq: 1, data: payload.message })
    claim(payload)
    expect(runtime.database.getRun('t:42', 'live-schedule')).toBeUndefined()
    const gate = context.on.mock.calls.find(([name]) => name === 'agent/pre-step')[1]
    runtime.scheduler.admitNativeStep = vi.fn(async () => ({ kind: 'accept' }))
    const signal = new AbortController().signal
    const admitted = gate({ agent: payload.agent, messages: [payload.message], turn: 1, signal }, () => {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runtime.scheduler.admitNativeStep).not.toHaveBeenCalled()
    runtime.mcpCatalogState = { ready: true }
    runtime.mcpResources = () => [{ id: 'verified', version: 'v1' }]
    await expect(admitted).resolves.toEqual({ kind: 'accept' })
    expect(runtime.scheduler.admitNativeStep).toHaveBeenCalledOnce()
    expect(runtime.database.getRun('t:42', 'live-schedule').mcpTools).toEqual([{ id: 'verified', version: 'v1' }])
  })
  it.each(['PATCH', 'DELETE'])('cancels a pending native schedule %s mutation on response disconnect', async method => {
    const { handler, key, context } = setup()
    const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    const sessionId = runtime.database.getChat('t:42', chat.id).sessionId
    let response, signal
    const mutation = vi.fn(async (...args) => {
      signal = args.at(-1)
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    context.schedule = { catalog: async () => [{ id: 'task', sessionId }], [method === 'PATCH' ? 'update' : 'delete']: mutation }
    const pending = call(handler, key, method, '/schedules/task', { title: 'Edited reminder' }, true, '42', {}, res => { response = res })
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce())
    response.emit('close')
    await pending
    expect(signal.aborted).toBe(true)
    expect(response.listenerCount('close')).toBe(0)
  })
  it('cancels a scheduled pre-step while waiting for the first MCP catalog', async () => {
    const { context } = setup()
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpCatalogState = { ready: false }
    runtime.scheduler.admitNativeStep = vi.fn()
    const gate = context.on.mock.calls.find(([name]) => name === 'agent/pre-step')[1]
    const abort = new AbortController()
    const rejected = gate({ agent: { id: 'native' }, turn: 1, messages: [{ id: 'scheduled', source: { kind: 'schedule' } }], signal: abort.signal }, () => {})
    abort.abort()
    await expect(rejected).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtime.scheduler.admitNativeStep).not.toHaveBeenCalled()
  })
  it('cancels a pending native schedule creation when the response disconnects',async()=>{
    const {handler,key,context}=setup()
    const chat=(await call(handler,key,'POST','/chats',{})).body.data
    let response,signal
    context.schedule={create:vi.fn(async(_session,_request,abort)=>{
      signal=abort
      await new Promise((resolve,reject)=>abort.addEventListener('abort',()=>reject(abort.reason),{once:true}))
    })}
    const pending=call(handler,key,'POST',`/chats/${chat.id}/schedules`,{title:'提醒',prompt:'remind',after_seconds:60},true,'42',{},value=>{response=value})
    await vi.waitFor(()=>expect(context.schedule.create).toHaveBeenCalledOnce())
    response.emit('close')
    await pending
    expect(signal.aborted).toBe(true)
    expect(response.listenerCount('close')).toBe(0)
  })

  it('admits an already-delivered schedule even when display title enrichment fails',async()=>{
    const {context}=setup()
    const runtime=context.reflect.provide.mock.calls.find(([name])=>name==='workbenchRuntime')[1]
    runtime.executionRun=()=>({id:'delivered',sessionId:'native',query:'schedule_id_json: "task"',selection:{native_source:'schedule'},mcpTools:[]})
    runtime.scheduler.admitNativeStep=vi.fn(async()=>({kind:'accept'}))
    context.schedule={catalog:vi.fn(async()=>{throw new Error('storage unavailable')})}
    context.logger={warn:vi.fn()}
    const gate=context.on.mock.calls.find(([name])=>name==='agent/pre-step')[1]
    await expect(gate({agent:{id:'native'}},()=>{})).resolves.toEqual({kind:'accept'})
    expect(runtime.scheduler.admitNativeStep).toHaveBeenCalledOnce()
    expect(context.logger.warn).toHaveBeenCalledWith('Scheduled delivery title enrichment deferred')
  })
  it('reports live but unready until native recovery and MCP bootstrap are complete', async () => {
    const { handler, key, context } = setup()
    await expect(call(handler, key, 'GET', '/health', undefined, false)).resolves.toMatchObject({ status: 503, body: { live: true, ready: false } })
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpCatalogState = { ready: true, status: 'ready' }
    await expect(call(handler, key, 'GET', '/health', undefined, false)).resolves.toMatchObject({ status: 200, body: { live: true, ready: true, recovery: 'ready' } })
    runtime.mcpCatalogState = { ready: false, status: 'unavailable' }
    await expect(call(handler, key, 'GET', '/health', undefined, false)).resolves.toMatchObject({ status: 503, body: { live: true, ready: false, resources: 'unavailable' } })
  })

  it('does not expose the retired migration endpoint', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'POST', '/migration/import', {})).resolves.toMatchObject({ status: 501 })
  })

  it('returns a real assertion-derived identity without a data envelope', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'GET', '/identity')).resolves.toMatchObject({ status: 200, body: { user: { id: '42', name: '用户' }, workspaceId: 't' } })
  })

  it('advertises the implemented personal resource management protocol', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'GET', '/catalog')).resolves.toMatchObject({
      status: 200,
      body: { data: { resources_protocol: 1, native_history_protocol: 1 } },
    })
  })

  it('publishes personal skills and registers only the database prompt extension', async () => {
    const { handler, key, context } = setup()
    context.skills.list.mockResolvedValueOnce([
      { name: 'legal-draft', description: '法律文书', source: 'user-dsh', provider: 'gxzs-sandbox-personal' },
      { name: 'global-skill', description: '全局技能', source: 'bundled', provider: 'gxzs' },
    ])
    await expect(call(handler, key, 'GET', '/catalog')).resolves.toMatchObject({
      status: 200,
      body: { data: { skills: [
        { id: 'personal:legal-draft', scope: 'personal' },
        { id: 'global-skill', scope: 'global' },
      ] } },
    })
    expect(context.systemPrompt.section.mock.calls.map(([section]) => section.name)).toEqual(['gxzs:sidebar-browser', 'gxzs:sidebar-terminal'])
    const assemble = context.on.mock.calls.find(([event]) => event === 'system-prompt/assemble')[1]
    context.workbenchPlatformClient.json.mockResolvedValueOnce({ data: { enabled: true, system_prompt: '数据库规则' } })
    const original = { sections: [{ name: 'deployment:persona-prefix', text: '原生身份' }], contexts: [], tools: [], variables: {} }
    const result = await assemble(original, {}, async () => original)
    expect(result.sections).toEqual([...original.sections, { name: 'gxzs:database-prompt', text: '数据库规则', interpolate: false }])
  })

  it('loads the model catalog without waiting for MCP or skill discovery', async () => {
    const { handler, key, context } = setup()
    context.skills.list.mockImplementation(() => new Promise(() => {}))
    context.workbenchPlatformClient.json.mockImplementation(({ route }) =>
      route === 'workbench/config' ? Promise.resolve(publishedModels()) : new Promise(() => {}))
    await expect(call(handler, key, 'GET', '/catalog?view=models')).resolves.toMatchObject({
      status: 200, body: { data: { models: [{ id: 'p/m' }], tools: [], skills: [] } },
    })
    expect(context.skills.list).not.toHaveBeenCalled()
  })

  it('rejects missing assertions before routing', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'GET', '/chats', undefined, false)).resolves.toMatchObject({ status: 401 })
  })

  it('protects live MCP authorization with signed owner-bound requests', async () => {
    const { handler, key } = setup()
    const route = '/runs/missing/mcp-authorization?resource_id=global%3Amcp%3Aweb%3Asearch&version=v1'
    await expect(call(handler, key, 'GET', route)).resolves.toMatchObject({ status: 200, body: { data: { authorized: false } } })
    await expect(call(handler, key, 'GET', route, undefined, false)).resolves.toMatchObject({ status: 401 })
    await expect(call(handler, key, 'GET', route, undefined, true, '99')).resolves.toMatchObject({ status: 403 })
  })

  it('rejects another validly signed user at the host boundary', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'GET', '/files', undefined, true, '99')).resolves.toMatchObject({ status: 403 })
  })

  it('proxies only fixed platform preview/share routes with verified owner context', async () => {
    const { handler, key, context } = setup()
    const preview = await call(handler, key, 'GET', '/files/preview?path=case%2Fa.pdf')
    expect(preview.status).toBe(200)
    expect(context.workbenchPlatformClient.request).toHaveBeenCalledWith(expect.objectContaining({
      owner: expect.objectContaining({ ownerId: 't:42' }), method: 'GET', route: 'files/preview', query: '?path=case%2Fa.pdf',
    }))
    await call(handler, key, 'POST', '/files/shares', { path: 'case/a.docx', expires_days: 7 })
    expect(context.workbenchPlatformClient.request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'POST', route: 'files/shares' }))
  })

  it('isolates Word conversion behind the authenticated platform route', async () => {
    const { handler, key, context } = setup()
    context.officeToPdf = { convert: vi.fn(() => { throw new Error('Host converter must not run') }) }
    const route = '/files/preview?path=case%2Fa.docx'
    await expect(call(handler, key, 'GET', route, undefined, false)).resolves.toMatchObject({ status: 401 })
    await expect(call(handler, key, 'GET', route, undefined, true, '99')).resolves.toMatchObject({ status: 403 })
    expect(context.workbenchPlatformClient.request).not.toHaveBeenCalled()
    await expect(call(handler, key, 'GET', route)).resolves.toMatchObject({ status: 200 })
    expect(context.workbenchPlatformClient.request).toHaveBeenCalledWith(expect.objectContaining({
      owner: expect.objectContaining({ ownerId: 't:42' }), method: 'GET', route: 'files/preview', query: '?path=case%2Fa.docx',
    }))
    expect(context.officeToPdf.convert).not.toHaveBeenCalled()
  })

  it('opens an owner-authorized native chat event stream through the public HTTP route', async () => {
    const {handler,key,context}=setup()
    const chat=await call(handler,key,'POST','/chats',{})
    context.sessionController.follow=vi.fn(async function* (request,signal) {
      expect(request).toMatchObject({address:{kind:'session'},assistantStream:true,maxMessages:500})
      expect(signal).toBeInstanceOf(AbortSignal)
      yield {type:'snapshot',header:{cwd:'/host/private'},projections:{},cursor:-1,records:[],hasMore:false,assistantStream:{revision:0}}
    })
    const route=`/chats/${chat.body.data.id}/events`
    await expect(call(handler,key,'GET',route,undefined,false)).resolves.toMatchObject({status:401})
    await expect(call(handler,key,'GET',route,undefined,true,'99')).resolves.toMatchObject({status:403})
    expect(context.sessionController.follow).not.toHaveBeenCalled()
    const stream=await call(handler,key,'GET',route)
    expect(stream).toMatchObject({status:200,headers:{'content-type':'text/event-stream; charset=utf-8'}})
    expect(JSON.parse(stream.chunks[0].slice(6))).toMatchObject({event:'workbench_history',value:{type:'snapshot',cursor:-1}})
    expect(stream.chunks.join('')).not.toContain('/host/private')
    expect(context.sessionController.follow).toHaveBeenCalledOnce()
  })

  it('routes binary file mutations to the fixed workspace manager', async () => {
    const { handler, key, context } = setup()
    const uploaded = await call(handler, key, 'POST', '/files', { path: '/workspace/case/a.bin', version: null, data: 'AP8=' })
    expect(uploaded).toMatchObject({ status: 200, body: { data: { path: 'case/a.bin', version: 'v1' } } })
    expect(context.workbenchFileManager.operate).toHaveBeenCalledWith({ operation: 'upload', path: 'case/a.bin', version: null, data: 'AP8=' })
    await expect(call(handler, key, 'POST', '/files', { path: '/workspace', data: 'AA==' })).resolves.toMatchObject({ status: 403 })
    await expect(call(handler, key, 'POST', '/files/directories', { path: '../escape' })).resolves.toMatchObject({ status: 403 })
  })

  it('uses sandbox-manager metadata as the file version authority', async () => {
    const { handler, key, context } = setup()
    const listing = await call(handler, key, 'GET', '/files?path=case')
    expect(listing).toMatchObject({ status: 200, body: { data: { entries: [{ path: 'case/a.bin', version: null }] } } })
    const stat = await call(handler, key, 'GET', '/files/stat?path=case%2Fa.bin')
    expect(stat).toMatchObject({ status: 200, body: { data: { path: 'case/a.bin', version: 'sha256-v1' } } })
    await call(handler, key, 'DELETE', '/files', { path: 'case/a.bin', version: stat.body.data.version })
    expect(context.workbenchFileManager.operate).toHaveBeenLastCalledWith({
      operation: 'delete', path: 'case/a.bin', version: 'sha256-v1',
    })
  })

  it('blocks file deletion while any owner run is active', async () => {
    const { handler, key, context } = setup()
    const chat = await call(handler, key, 'POST', '/chats', {})
    await call(handler, key, 'POST', `/chats/${chat.body.data.id}/runs`, { query: 'work', request_key: 'run-1', version: 1 })
    context.workbenchFileManager.operate.mockClear()
    const deleted = await call(handler, key, 'DELETE', '/files', { path: 'case/a.bin', version: 'v1' })
    expect(deleted).toMatchObject({ status: 409 })
    expect(context.workbenchFileManager.operate).not.toHaveBeenCalled()
  })

  it('allocates a dated task directory and checks it when reopening the chat', async () => {
    const { handler, key, context } = setup()
    const created = await call(handler, key, 'POST', '/chats', {})
    const chatId = created.body.data.id
    const directory = context.workbenchFileManager.operate.mock.calls.at(-1)[0].path
    expect(directory).toMatch(new RegExp(`^conversations/\\d{4}-\\d{2}-\\d{2}/${chatId}$`))
    expect(context.workbenchFileManager.operate).toHaveBeenCalledWith({
      operation: 'mkdir', path: directory,
    })
    context.workbenchFileManager.operate.mockClear()
    await call(handler, key, 'GET', `/chats/${chatId}`)
    expect(context.workbenchFileManager.operate).toHaveBeenCalledWith({
      operation: 'list', path: directory,
    })
  })

  it('creates and lists owner-scoped chats with the expected envelope', async () => {
    const { handler, key } = setup()
    const created = await call(handler, key, 'POST', '/chats', {})
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ title: '新会话', version: 1, runs: [], selection: { model: 'p/m' } })
    const listed = await call(handler, key, 'GET', '/chats')
    expect(listed.body.data).toHaveLength(1)
    expect(listed.body.data[0].id).toBe(created.body.data.id)
  })
})


it('authenticates submission cancellation and fences a delayed POST', async () => {
  const { handler, key } = setup()
  const created = await call(handler, key, 'POST', '/chats', {})
  const id = created.body.data.id
  const route = `/chats/${id}/runs/stop`
  await expect(call(handler, key, 'POST', route, { request_key: 'slow-request' }, false)).resolves.toMatchObject({ status: 401 })
  await expect(call(handler, key, 'POST', route, { request_key: 'slow-request' }, true, 'other')).resolves.toMatchObject({ status: 403 })
  await expect(call(handler, key, 'POST', route, { request_key: 'slow-request' })).resolves.toMatchObject({ status: 200, body: { data: { accepted: true } } })
  await expect(call(handler, key, 'POST', `/chats/${id}/runs`, { query: 'late message', request_key: 'slow-request' })).resolves.toMatchObject({ status: 409 })
})


it('opens a fork through the authenticated HTTP API and rejects anonymous requests', async () => {
  const { handler, key, context } = setup()
  context.sessionController.fork = vi.fn(async () => ({ sessionId: 'fork-session' }))
  const onEvent = context.on.mock.calls.find(([name]) => name === 'session/event')[1]
  const onClaim = context.on.mock.calls.find(([name]) => name === 'agent/inbox/claimed')[1]
  // The mock session registry exposes the newly created session via agents.get.
  const originalGet = context.agents.get
  context.sessionController.create = async () => ({ sessionId: 'http-source-session' })
  const sourceChat = (await call(handler, key, 'POST', '/chats', {})).body.data.id
  context.agents.get = (value) => value === 'http-source-session' ? { id: value, session: { id: value, seq: 0 } } : originalGet(value)
  const sourceRun = (await call(handler, key, 'POST', `/chats/${sourceChat}/runs`, { query: 'fork source' })).body.data.id
  onEvent({ id: 'http-source-session' }, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  onClaim({ agent: { id: 'http-source-session' }, message: { id: 'message-one', source: { kind: 'user', rpcId: sourceRun } }, turn: 1 })
  onEvent({ id: 'http-source-session' }, { type: 'turn/end', seq: 8, data: { turn: 1, reason: { kind: 'completed' } } })
  expect((await call(handler, key, 'POST', `/runs/${sourceRun}/fork`, { request_key: 'fork-http' }, false)).status).toBe(401)
  const fork = await call(handler, key, 'POST', `/runs/${sourceRun}/fork`, { request_key: 'fork-http' })
  expect(fork.status).toBe(201)
  expect(fork.body.data.id).not.toBe(sourceChat)
  expect(fork.body.data.runs).toMatchObject([{ query: 'fork source', status: 'completed' }])
  expect(context.sessionController.fork).toHaveBeenCalledWith({ sessionId: 'http-source-session', atSeq: 8 })
})
