import { createHash, createHmac, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, waitSessionActivity } from '../src/index.js'
import { WorkbenchDatabase } from '../src/persistence.js'
import { publishedModels } from './model-fixture.js'

// The HTTP fixture models /workspace through workbenchFileManager, without a
// real mount. Give only that virtual root a real temporary filesystem's stats.
vi.mock('node:fs', async (original) => {
  const fs = await original()
  const { tmpdir } = await import('node:os')
  return { ...fs, statfsSync: (path, ...args) => fs.statfsSync(path === '/workspace' ? tmpdir() : path, ...args) }
})

const cleanups = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function setup({ databasePath = ':memory:', configure = () => {} } = {}) {
  const key = Buffer.alloc(32, 9).toString('base64')
  vi.stubEnv('TEST_ASSERTION_KEY', key)
  const sessions = new Map()
  let handler
  const context = {
    get: name => context[name],
    webServer: { register: vi.fn((route) => { handler = route.handler; return () => {} }) },
    sessionController: {
      list: async () => ({ items: [] }),
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
    workspaceController: {
      follow: async function* () { yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } } },
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
    systemPrompt: { section: vi.fn(() => () => {}), context: vi.fn(() => () => {}), getSectionOrder: () => 3000 },
    tools: { register: vi.fn(() => () => {}) },
    on: vi.fn(), emit: vi.fn(), reflect: { provide: vi.fn() },
    effect: (factory) => cleanups.push(factory()),
  }
  configure(context)
  apply(context, {
    basePath: '/ai/workbench', databasePath, workspace: '/workspace',
    assertionIssuer: 'gxzs', assertionAudiencePath: '/console/api/workbench', assertionKeyEnv: 'TEST_ASSERTION_KEY',
    ownerId: 't:42', humanInputTimeoutSeconds: 60,
  })
  const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
  runtime.refreshMcpCatalog = vi.fn(async () => [])
  cleanups.push(() => vi.unstubAllEnvs())
  return { handler, key, context }
}

it('refuses new admission while native MCP registration is unavailable', async () => {
  const { handler, key, context } = setup()
  const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
  const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
  delete runtime.refreshMcpCatalog
  expect(await call(handler, key, 'POST', `/chats/${chat.id}/runs`, { query: 'read tools' })).toMatchObject({ status: 503 })
  expect(runtime.database.listRuns('t:42', chat.id)).toEqual([])
})

it('reports resource capabilities from loaded native services', async () => {
  const { handler, key, context } = setup()
  const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
  const capabilities = async () => (await call(handler, key, 'GET', '/health', undefined, false)).body.mcp_capabilities
  expect(await capabilities()).toMatchObject({ server_instructions: false, resources: false, resource_templates: false })
  runtime.mcpPlugins = () => []
  context.mcpResources = { register: vi.fn() }
  expect(await capabilities()).toMatchObject({ server_instructions: true, resources: true, resource_templates: true })
  delete context.mcpResources
  expect(await capabilities()).toMatchObject({ server_instructions: true, resources: false, resource_templates: false })
})

it('serializes absent native changes as null without hiding ownership or diff failures', async () => {
  const summary = vi.fn(() => undefined)
  const { handler, key } = setup({ configure: context => {
    context.workspaceChanges = { summary, diff: vi.fn(async () => undefined) }
  } })
  const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
  const route = `/chats/${chat.id}/changes?seq=10`
  expect(await call(handler, key, 'GET', route)).toMatchObject({ status: 200, body: { data: null } })
  expect((await call(handler, key, 'GET', `${route}&index=0`)).status).toBe(404)
  expect((await call(handler, key, 'GET', route, undefined, true, 'other')).status).toBe(403)
  expect(summary).toHaveBeenCalledTimes(1)
})

async function call(handler, key, method, route, value, authenticated = true, userId = '42', extraHeaders = {}, onResponse) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  const contentType = extraHeaders['content-type'] ?? 'application/json'
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: 'gxzs', aud: 'agent-workbench', sub: `t:${userId}`, tenant_id: 't', user_id: userId, name: '用户',
    iat: now, exp: now + 60, jti: randomUUID(), method,
    target: `/console/api/workbench${route}`, body_sha256: createHash('sha256').update(body).digest('hex'),
    content_type: contentType, last_event_id: '',
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
  it('invalidates the skill catalog when status polling confirms asynchronous publication', async () => {
    const { handler, key, context } = setup()
    let receipt = { import_id: 'a'.repeat(32), status: 'running' }
    context.workbenchFileManager.personalResources = vi.fn(async () => receipt)
    context.emit.mockClear()
    for (const status of ['ready', 'running', 'unknown', 'failed', 'cancelled', 'conflict']) {
      receipt = { ...receipt, status }
      expect((await call(handler, key, 'POST', '/resources', {
        operation: 'skill_import_status', import_id: receipt.import_id,
      })).body.data.status).toBe(status)
      expect(context.emit).not.toHaveBeenCalledWith('workbench/resources-changed')
    }
    receipt = { ...receipt, status: 'completed', id: 'report', version: 'v2' }
    const response = await call(handler, key, 'POST', '/resources', {
      operation: 'skill_import_status', import_id: receipt.import_id,
    })
    expect(response.status).toBe(200)
    expect(response.body.data).toEqual(receipt)
    expect(context.emit).toHaveBeenCalledWith('workbench/resources-changed')
  })
  it('accepts a 100 MiB package encoded through legacy skill JSON with a small MCP budget', async () => {
    const { handler, key, context } = setup()
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpPolicy = { request_bytes: 1024 }
    const content = '---\nname: large-json\ndescription: Legacy JSON fixture\n---\nBody'
    context.workbenchFileManager.personalResources = vi.fn(async body => {
      if (body.operation === 'skill_stage') return { import_id: body.import_id, content }
      if (body.operation === 'skill_prepare') return { name: 'large-json', version: null }
      if (body.operation === 'skill_import_status') return { status: 'ready' }
      if (body.operation === 'skill_inspect') return { content }
      if (body.operation === 'skill_import') return { status: 'completed', id: 'large-json', version: 'v1' }
      throw new Error('unexpected ' + body.operation)
    })
    const archive = Buffer.alloc(100 * 1024 * 1024).toString('base64')
    const response = await call(handler, key, 'POST', '/resources', { operation: 'skill_import', archive, version: null })
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({ id: 'large-json', version: 'v1' })
    const packages = context.workbenchFileManager.personalResources.mock.calls.filter(([body]) => body.archive)
    expect(packages).toHaveLength(1)
    expect(packages[0][0].archive).toBe(archive)
  }, 30_000)
  it('keeps small skill mutations independent from MCP budgets while enforcing MCP operations separately', async () => {
    const { handler, key, context } = setup()
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpPolicy = { request_bytes: 1024 }
    context.workbenchFileManager.personalResources = vi.fn(async () => ({ saved: true }))
    const skill = { operation: 'skill_update', name: 'demo', content: '---\nname: demo\ndescription: fixture\n---\n' + 'x'.repeat(2100) }
    const response = await call(handler, key, 'POST', '/resources', skill)
    expect(response.status).toBe(200)
    expect(context.workbenchFileManager.personalResources).toHaveBeenCalled()
    expect((await call(handler, key, 'POST', '/resources', { ...skill, operation: 'mcp_save' })).status).toBe(413)
  })
  it('accepts a cold MCP body above the generic ingress budget and refuses ordinary resources borrowing that budget', async () => {
    const { handler, key, context } = setup()
    const policy = { request_bytes: 40 * 1024 * 1024 }
    context.workbenchPlatformClient.loadMcpPolicy = vi.fn(async () => policy)
    const originalJson = context.workbenchPlatformClient.json
    context.workbenchPlatformClient.json = vi.fn(value => value.route === 'mcp/plugins' ? { plugins: [] } : originalJson(value))
    context.workbenchFileManager.personalMcp = vi.fn(async () => ({ saved: true }))
    const body = { content: 'x'.repeat(33 * 1024 * 1024), operation: 'mcp_save', name: 'demo' }
    expect((await call(handler, key, 'POST', '/resources', body)).status).toBe(200)
    expect(context.workbenchPlatformClient.loadMcpPolicy).toHaveBeenCalledOnce()
    expect(context.workbenchFileManager.personalMcp).toHaveBeenCalledWith(body, expect.any(AbortSignal))
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpPolicy = policy
    expect((await call(handler, key, 'POST', '/resources', { ...body, operation: 'skill_update' })).status).toBe(413)
  })
  it('uses the authenticated platform client for the public MCP content preview', async () => {
    const { handler, key, context } = setup()
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpPolicy = { request_bytes: 4096, max_call_seconds: 350 }
    const body = { server_id: 'global:mcp:fixture', version: '1', method: 'resources/list', params: {} }
    expect((await call(handler, key, 'POST', '/mcp/request', body)).status).toBe(200)
    expect(context.workbenchPlatformClient.json).toHaveBeenCalledWith(expect.objectContaining({ route: 'mcp/request',
      owner: expect.objectContaining({ ownerId: 't:42' }), signal: expect.any(AbortSignal) }))
  })
  it('correlates unexpected failures without logging secrets and bounds repeated diagnostics', async () => {
    const { handler, key, context } = setup()
    context.skills.list.mockRejectedValue(new TypeError('Bearer private-token /private/config'))
    let response
    for (let index = 0; index < 8; index++) response = await call(handler, key, 'GET', '/catalog?token=private-query')
    expect(response.status).toBe(500)
    expect(response.body.request_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(context.logger.warn).toHaveBeenCalledTimes(5)
    const diagnostic = JSON.parse(context.logger.warn.mock.calls[0][1])
    expect(diagnostic).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', error_type: 'TypeError',
      route: '^\\/catalog$', method: 'GET', owner_id: 't:42' })
    expect(JSON.stringify(context.logger.warn.mock.calls)).not.toMatch(/private|Bearer|token=|x-gxzs-assertion/)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
    try {
      response = await call(handler, key, 'GET', '/catalog')
      const resumed = JSON.parse(context.logger.warn.mock.calls.at(-1)[1])
      expect(resumed.suppressed).toBe(3)
      expect(resumed.request_id).toBe(response.body.request_id)
    } finally { clock.mockRestore() }
  })

  it('keeps expected authorization failures quiet and preserves a reply when logging fails', async () => {
    const { handler, key, context } = setup()
    expect((await call(handler, key, 'GET', '/catalog', undefined, false)).status).toBe(401)
    expect(context.logger.warn).not.toHaveBeenCalled()
    context.skills.list.mockRejectedValue(new Error('secret'))
    context.logger.warn.mockImplementation(() => { throw new Error('logger unavailable') })
    expect((await call(handler, key, 'GET', '/catalog')).status).toBe(500)
  })

  it('pages terminal history through a fixed cursor and retains owner authorization', async () => {
    const { handler, key, context } = setup()
    const { database } = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    const chat = database.createChat({ ownerId: 't:42', sessionId: 'page-test', selection: {} })
    const { run } = database.createRun({ ownerId: 't:42', chatId: chat.id, sessionId: chat.sessionId, query: 'paged', selection: {} })
    for (let index = 0; index < 300; index++) database.appendEvent('t:42', run.id, { event: 'workbench_activity', data: { index } })
    database.transitionRun('t:42', run.id, 'completed')
    const route = `/runs/${run.id}?after=0-0`
    expect((await call(handler, key, 'GET', route, undefined, false)).status).toBe(401)
    expect((await call(handler, key, 'GET', route, undefined, true, 'other')).status).toBe(403)
    const first = await call(handler, key, 'GET', route)
    expect(first.status).toBe(200)
    expect(first.body.data).toMatchObject({ status: 'completed', history_complete: false,
      events_cursor: '256-0', events_next_cursor: '256-0', events_through_cursor: '300-0' })
    database.appendEvent('t:42', run.id, { event: 'workbench_context', used_tokens: 5 })
    const last = await call(handler, key, 'GET', `/runs/${run.id}?after=256-0&through=300-0`)
    expect(last.status).toBe(200)
    expect(last.body.data).toMatchObject({ history_complete: true, events_cursor: '300-0', events_through_cursor: '300-0' })
    expect(last.body.data.events).toHaveLength(44)
    expect(last.body.data.events_next_cursor).toBeUndefined()
    expect((await call(handler, key, 'GET', `/runs/${run.id}?after=300-0&through=256-0`)).status).toBe(400)
    expect((await call(handler, key, 'GET', `/runs/${run.id}?after=bad`)).status).toBe(400)
    expect((await call(handler, key, 'GET', `/runs/${run.id}?view=state`)).body.data).toMatchObject({ events: [], events_cursor: '301-0' })
  })
  it('identifies catalog-blocked cold recovery and resumes in place after the dependency returns', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'workbench-recovery-'))
    const databasePath = join(folder, 'state.db')
    const database = new WorkbenchDatabase(databasePath)
    database.createChat({ ownerId: 't:42', sessionId: 'native', selection: {} })
    database.close()
    const message = { id: 'cold-notice', source: { kind: 'tool-jobs', form: 'notice' }, content: [{ type: 'text', text: 'completed' }] }
    const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, data: message }]
    const { handler, key, context } = setup({ databasePath, configure(ctx) {
      ctx.sessionQuery = { observeSession: vi.fn(async () => ({ events, [Symbol.dispose]() {} })) }
    } })
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpCatalogState = { ready: false, status: 'unavailable' }
    await vi.waitFor(async () => expect((await call(handler, key, 'GET', '/health', undefined, false)).body)
      .toMatchObject({ live: true, ready: false, recovery: 'failed', recovery_dependency: 'mcp_catalog', resources: 'unavailable' }))
    expect(runtime.database.getRun('t:42', message.id)).toBeUndefined()
    runtime.mcpCatalogState = { ready: true, status: 'ready' }
    runtime.mcpResources = () => [{ id: 'current-tool' }]
    await vi.waitFor(async () => expect(await call(handler, key, 'GET', '/health', undefined, false))
      .toMatchObject({ status: 200, body: { recovery: 'ready' } }), { timeout: 2500 })
    expect(runtime.database.getRun('t:42', message.id).mcpTools).toEqual([{ id: 'current-tool' }])
    expect((await call(handler, key, 'GET', '/health', undefined, false)).body.recovery_dependency).toBeUndefined()
  })
  it('resumes a cold pending inbox during startup without another user prompt', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'workbench-inbox-recovery-'))
    const databasePath = join(folder, 'state.db')
    const db = new WorkbenchDatabase(databasePath)
    db.createChat({ ownerId: 't:42', sessionId: 'cold', selection: {} })
    db.close()
    const message = { id: 'pending-reminder', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'remind' }] }
    const events = [{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } }]
    const resumePending = vi.fn()
    const resolveAgent = vi.fn(async () => ({ agent: { resumePending } }))
    const { handler, key, context } = setup({ databasePath, configure(ctx) {
      ctx.sessionQuery = { observeSession: async () => ({ events, [Symbol.dispose]() {} }) }
      ctx.sessionController.resolveAgent = resolveAgent
    } })
    cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpCatalogState = { ready: true, status: 'ready' }
    runtime.mcpResources = () => []
    await vi.waitFor(() => expect(resumePending).toHaveBeenCalledOnce())
    expect(resolveAgent).toHaveBeenCalledExactlyOnceWith('cold')
    expect(runtime.database.getRun('t:42', message.id)).toMatchObject({ status: 'queued', messageId: message.id })
    expect((await call(handler, key, 'GET', '/health', undefined, false)).body.recovery).toBe('ready')
  })
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
  it('returns the directory warning before any file operation for a live conversation or its parent', async () => {
    const { handler, key, context } = setup()
    const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
    context.workbenchFileManager.operate.mockClear()
    for (const path of [chat.file_directory, chat.file_directory.split('/').slice(0, -1).join('/')]) {
      const response = await call(handler, key, 'DELETE', '/files', { path, version: 'v1' })
      expect(response).toMatchObject({ status: 409, body: { code: 'DIRECTORY_IN_USE', message: '请先删除对应对话或工作区' } })
    }
    expect(context.workbenchFileManager.operate).not.toHaveBeenCalled()
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
  it('enriches the steered schedule receipt rather than the active target at pre-step', async () => {
    const { handler, key, context } = setup()
    const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    const db = runtime.database, sessionId = db.getChat('t:42', chat.id).sessionId
    runtime.mcpCatalogState = { ready: true }
    runtime.mcpResources = () => []
    const parent = db.createRun({ ownerId: 't:42', chatId: chat.id, sessionId, query: 'working', selection: {} }).run
    db.bindNativeTurn(parent, 1)
    context.schedule = { catalog: async () => [{ id: 'task', sessionId, title: '原计划' }] }
    runtime.scheduler.admitNativeStep = vi.fn(async () => ({ kind: 'accept' }))
    const message = { id: 'steered-schedule', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'schedule_id_json: "task"' }] }
    const gate = context.on.mock.calls.find(([name]) => name === 'agent/pre-step')[1]
    await gate({ agent: { id: sessionId }, messages: [message], turn: 1, signal: new AbortController().signal }, () => {})
    await vi.waitFor(() => expect(db.getRun('t:42', message.id)).toMatchObject({ status: 'steered', selection: { schedule_ids: ['task'], schedule_titles: ['原计划'] } }))
    expect(db.runForTurn(sessionId, 1).id).toBe(parent.id)
  })
  it('admits a busy turn while schedule display lookup remains pending', async () => {
    const { handler, key, context } = setup()
    const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    const db = runtime.database, sessionId = db.getChat('t:42', chat.id).sessionId
    runtime.mcpCatalogState = { ready: true }
    runtime.mcpResources = () => []
    const parent = db.createRun({ ownerId: 't:42', chatId: chat.id, sessionId, query: 'working', selection: {} }).run
    db.bindNativeTurn(parent, 1)
    let release
    context.schedule = { catalog: vi.fn(() => new Promise(resolve => { release = resolve })) }
    runtime.scheduler.admitNativeStep = vi.fn(async () => ({ kind: 'accept' }))
    const message = { id: 'pending-schedule', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'schedule_id_json: "task"' }] }
    const gate = context.on.mock.calls.find(([name]) => name === 'agent/pre-step')[1]
    const pending = gate({ agent: { id: sessionId }, messages: [message], turn: 1, signal: new AbortController().signal }, () => {})
    try {
      await vi.waitFor(() => expect(runtime.scheduler.admitNativeStep).toHaveBeenCalledOnce(), { timeout: 1000 })
      await expect(pending).resolves.toEqual({ kind: 'accept' })
      expect(db.getRun('t:42', message.id)).toMatchObject({ status: 'steered', selection: { schedule_ids: ['task'] } })
      expect(db.runForTurn(sessionId, 1).id).toBe(parent.id)
    } finally { release?.([]); await pending }
  })
  it('admits an in-turn child notice without waiting for a new MCP catalog', async () => {
    const { handler, key, context } = setup()
    const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    const db = runtime.database, sessionId = db.getChat('t:42', chat.id).sessionId
    const parent = db.createRun({ ownerId: 't:42', chatId: chat.id, sessionId, query: 'working', selection: {} }).run
    db.bindNativeTurn(parent, 1)
    runtime.mcpCatalogState = { ready: false }
    runtime.mcpResources = vi.fn(() => { throw new Error('catalog unavailable') })
    runtime.scheduler.admitNativeStep = vi.fn(async () => ({ kind: 'accept' }))
    const message = { id: 'busy-child', source: { kind: 'agent-message', senderSessionId: 'owned-child' }, content: [] }
    const gate = context.on.mock.calls.find(([name]) => name === 'agent/pre-step')[1]
    const controller = new AbortController()
    const pending = gate({ agent: { id: sessionId }, messages: [message], turn: 1, signal: controller.signal }, () => {})
    try {
      await vi.waitFor(() => expect(runtime.scheduler.admitNativeStep).toHaveBeenCalledOnce())
      await expect(pending).resolves.toEqual({ kind: 'accept' })
      expect(runtime.mcpResources).not.toHaveBeenCalled()
    } finally { controller.abort(); await pending.catch(() => {}) }
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
    const { handler, key, context } = setup()
    const chat = (await call(handler, key, 'POST', '/chats', {})).body.data
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    const sessionId = runtime.database.getChat('t:42', chat.id).sessionId
    runtime.mcpCatalogState = { ready: false }
    runtime.scheduler.admitNativeStep = vi.fn()
    const gate = context.on.mock.calls.find(([name]) => name === 'agent/pre-step')[1]
    const abort = new AbortController()
    const rejected = gate({ agent: { id: sessionId }, turn: 1, messages: [{ id: 'scheduled', source: { kind: 'schedule' } }], signal: abort.signal }, () => {})
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

  it.each(['closed', 'failure', 'aborted'])('reports a failed SSH %s after bootstrap without disclosing its error', async (mode) => {
    const { handler, key, context } = setup()
    await call(handler, key, 'GET', '/health', undefined, false)
    const runtime = context.reflect.provide.mock.calls.find(([name]) => name === 'workbenchRuntime')[1]
    runtime.mcpCatalogState = { ready: true, status: 'ready' }
    context.ssh = { closed: false, lifetime: new AbortController() }
    await vi.waitFor(async () => expect((await call(handler, key, 'GET', '/health', undefined, false)).status).toBe(200))
    context.agents.list = () => [{ status: 'idle', inbox: { nextTurn: [{}], nextStep: [] } }]
    context.jobs = { list: () => [] }
    context.schedule = { catalog: async () => {
      // Failure can happen while the durable activity catalog is being read.
      if (mode === 'aborted') context.ssh.lifetime.abort(new Error('secret transport details'))
      else context.ssh[mode] = mode === 'closed' ? true : new Error('secret transport details')
      return [{ status: 'active' }]
    } }
    const response = await call(handler, key, 'GET', '/health', undefined, false)
    expect(response).toMatchObject({ status: 503, body: { live: true, ready: false, recovery: 'ready',
      runtime_error: 'SSH_UNAVAILABLE', activity: { protocol: 2, status: 'ready', runningAgents: 0, pendingMessages: 1, activeSchedules: 1,
        registeredSchedules: 0, pendingScheduleReports: 1 } } })
    expect(JSON.stringify(response.body)).not.toContain('secret transport details')
    runtime.mcpCatalogState = { ready: false, status: 'unavailable' }
    expect((await call(handler, key, 'GET', '/health', undefined, false)).body.runtime_error).toBe('SSH_UNAVAILABLE')
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

  it('publishes global skills before personal skills and registers the database prompt extension', async () => {
    const { handler, key, context } = setup()
    context.skills.list.mockResolvedValueOnce([
      { name: 'legal-draft', description: '法律文书', source: 'user-dsh', provider: 'gxzs-sandbox-personal' },
      { name: 'global-skill', description: '全局技能', source: 'bundled', provider: 'gxzs' },
    ])
    await expect(call(handler, key, 'GET', '/catalog')).resolves.toMatchObject({
      status: 200,
      body: { data: { skills: [
        { id: 'global-skill', scope: 'global', order_num: 0 },
        { id: 'personal:legal-draft', scope: 'personal' },
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

  it('reads temporary files through owner-authorized routes without allowing listing or mutation', async () => {
    const { handler, key, context } = setup()
    const operate = context.workbenchFileManager.operate.getMockImplementation()
    context.workbenchFileManager.operate.mockImplementation(async payload => payload.operation === 'get'
      ? { data: Buffer.from('text').toString('base64'), version: 'v1' } : operate(payload))
    context.workbenchFileManager.download = vi.fn(async () => { throw Object.assign(new Error('文件不存在'), { status: 404 }) })
    const query = '?path=%2Ftmp%2Frender%2Fa.png'
    for (const route of ['/files/stat', '/files/text', '/files/download']) {
      expect((await call(handler, key, 'GET', route + query, undefined, false)).status).toBe(401)
      expect((await call(handler, key, 'GET', route + query, undefined, true, 'other')).status).toBe(403)
      expect((await call(handler, key, 'GET', route + query)).status).toBe(route.endsWith('/download') ? 404 : 200)
    }
    expect(context.workbenchFileManager.operate).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/render/a.png' }), expect.any(AbortSignal))
    expect(context.workbenchFileManager.download).toHaveBeenCalledWith('/tmp/render/a.png', expect.any(AbortSignal))
    context.workbenchFileManager.operate.mockClear()
    expect((await call(handler, key, 'GET', '/files' + query)).status).toBe(403)
    expect((await call(handler, key, 'DELETE', '/files', { path: '/tmp/render/a.png', version: 'v1' })).status).toBe(403)
    expect((await call(handler, key, 'POST', '/files/directories', { path: '/tmp/new' })).status).toBe(403)
    expect((await call(handler, key, 'GET', '/files/stat?path=%2Ftmp%2F..%2Fsecret')).status).toBe(400)
    expect(context.workbenchFileManager.operate).not.toHaveBeenCalled()
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


it('authenticates a streamed upload and forwards binary bytes without JSON encoding', async () => {
  const { readFile } = await import('node:fs/promises')
  let stagedPath
  const { handler, key, context } = setup({ configure(context) {
    context.workbenchFileManager.upload = vi.fn(async (action, upload) => {
      expect(action).toBe('files')
      expect(upload.metadata).toMatchObject({ operation: 'upload', path: 'a.bin', size: 3 })
      stagedPath = upload.path
      expect((await readFile(upload.path)).subarray(upload.offset)).toEqual(Buffer.from([0, 255, 42]))
      return { path: 'a.bin', version: 'v2' }
    })
  } })
  const body = Buffer.concat([Buffer.from(JSON.stringify({ operation: 'upload', path: 'a.bin', size: 3 }) + '\n'), Buffer.from([0, 255, 42])])
  const headers = { 'content-type': 'application/octet-stream', 'content-length': String(body.length) }
  expect(await call(handler, key, 'POST', '/files/upload', body, true, '42', headers)).toMatchObject({ status: 200, body: { data: { version: 'v2' } } })
  await expect(readFile(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await call(handler, key, 'POST', '/files/upload', body, true, 'other', headers)).status).toBe(403)
  expect(context.workbenchFileManager.upload).toHaveBeenCalledOnce()
})
