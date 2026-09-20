import { createHash, createHmac, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

const cleanups = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

function setup() {
  const key = Buffer.alloc(32, 9).toString('base64')
  vi.stubEnv('TEST_ASSERTION_KEY', key)
  vi.stubEnv('TEST_MIGRATION_TOKEN', 'migration-secret')
  const sessions = new Map()
  let handler
  const context = {
    webServer: { register: vi.fn((route) => { handler = route.handler; return () => {} }) },
    sessionController: {
      modelCatalog: async () => ({ default: { provider: 'p', model: 'm' }, groups: [] }),
      create: async (request = {}) => {
        const sessionId = request.sessionId || randomUUID()
        sessions.set(sessionId, { seq: 0, append: vi.fn(function () { this.seq += 1; return { seq: this.seq - 1 } }) })
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
      json: vi.fn(async () => ({ tools: [] })),
    },
    agents: { get: (id) => sessions.has(id) ? { session: sessions.get(id) } : undefined }, commands: {},
    skills: { list: vi.fn(async () => []), get: async () => undefined },
    tokenMeter: { measure: vi.fn(() => ({ totalTokens: 0, baseline: { kind: 'none' } })) },
    systemPrompt: { section: vi.fn(() => () => {}) },
    on: vi.fn(), emit: vi.fn(), reflect: { provide: vi.fn() },
    effect: (factory) => cleanups.push(factory()),
  }
  apply(context, {
    basePath: '/ai/workbench', databasePath: ':memory:', workspace: '/workspace',
    assertionIssuer: 'gxzs', assertionAudiencePath: '/console/api/workbench', assertionKeyEnv: 'TEST_ASSERTION_KEY',
    ownerId: 't:42', migrationTokenEnv: 'TEST_MIGRATION_TOKEN', humanInputTimeoutSeconds: 60,
  })
  cleanups.push(() => vi.unstubAllEnvs())
  return { handler, key, context }
}

async function call(handler, key, method, route, value, authenticated = true, userId = '42', extraHeaders = {}) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value))
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss: 'gxzs', aud: 'dify-workbench', sub: `t:${userId}`, tenant_id: 't', user_id: userId, name: '用户',
    iat: now, exp: now + 60, jti: randomUUID(), method,
    target: `/console/api/workbench${route}`, body_sha256: createHash('sha256').update(body).digest('hex'),
    content_type: 'application/json', last_event_id: '',
  })).toString('base64url')
  const signature = createHmac('sha256', Buffer.from(key, 'base64')).update(`${header}.${payload}`).digest('base64url')
  const req = Readable.from(body.length ? [body] : [])
  req.method = method
  req.url = `/ai/workbench${route}`
  req.headers = { 'content-type': 'application/json', ...(authenticated ? { 'x-gxzs-assertion': `${header}.${payload}.${signature}` } : {}), ...extraHeaders }
  const response = { status: undefined, body: undefined }
  const res = {
    headersSent: false,
    writeHead(status) { response.status = status; this.headersSent = true },
    end(text) {
      if (!text) response.body = undefined
      else { try { response.body = JSON.parse(text) } catch { response.body = Buffer.from(text) } }
    },
  }
  await handler(req, res)
  return response
}

describe('authenticated workbench HTTP handler', () => {
  it('requires a second migration token in addition to the owner assertion', async () => {
    const { handler, key } = setup()
    const bundle = {
      version: 1, source_id: 'empty-batch', owner_id: 't:42',
      workspace: { id: '33333333-3333-4333-8333-333333333333', tree_version: 'tree-v1', files: 0, bytes: 0, samples: [] },
      chats: [],
    }
    await expect(call(handler, key, 'POST', '/migration/import', bundle)).resolves.toMatchObject({ status: 401 })
    await expect(call(handler, key, 'POST', '/migration/import', bundle, true, '42', { 'x-gxzs-migration-token': 'migration-secret' }))
      .resolves.toMatchObject({ status: 200, body: { data: { source_id: 'empty-batch', chats: [] } } })
  })

  it('returns a real assertion-derived identity without a data envelope', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'GET', '/identity')).resolves.toMatchObject({ status: 200, body: { user: { id: '42', name: '用户' }, workspaceId: 't' } })
  })

  it('advertises the implemented personal resource management protocol', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'GET', '/catalog')).resolves.toMatchObject({
      status: 200,
      body: { data: { resources_protocol: 1 } },
    })
  })

  it('publishes personal skills and the GXZS assistant identity', async () => {
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
    expect(context.systemPrompt.section).toHaveBeenCalledWith({
      name: 'gxzs:identity', order: 1, text: '你的名字是公信智能办案助手。',
    })
  })

  it('rejects missing assertions before routing', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'GET', '/chats', undefined, false)).resolves.toMatchObject({ status: 401 })
  })

  it('rejects another validly signed user at the host boundary', async () => {
    const { handler, key } = setup()
    await expect(call(handler, key, 'GET', '/files', undefined, true, '99')).resolves.toMatchObject({ status: 403 })
  })

  it('proxies only fixed platform preview/share routes with verified owner context', async () => {
    const { handler, key, context } = setup()
    await call(handler, key, 'GET', '/files/preview?path=case%2Fa.docx')
    expect(context.workbenchPlatformClient.request).toHaveBeenCalledWith(expect.objectContaining({
      owner: expect.objectContaining({ ownerId: 't:42' }), method: 'GET', route: 'files/preview', query: '?path=case%2Fa.docx',
    }))
    await call(handler, key, 'POST', '/files/shares', { path: 'case/a.docx', expires_days: 7 })
    expect(context.workbenchPlatformClient.request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'POST', route: 'files/shares' }))
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

  it('creates and repairs owner chat directories', async () => {
    const { handler, key, context } = setup()
    const created = await call(handler, key, 'POST', '/chats', {})
    const chatId = created.body.data.id
    expect(context.workbenchFileManager.operate).toHaveBeenCalledWith({
      operation: 'mkdir', path: `conversations/${chatId}`,
    })
    context.workbenchFileManager.operate.mockClear()
    await call(handler, key, 'GET', `/chats/${chatId}`)
    expect(context.workbenchFileManager.operate).toHaveBeenCalledWith({
      operation: 'mkdir', path: `conversations/${chatId}`,
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
