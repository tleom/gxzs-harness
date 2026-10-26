import { afterEach, describe, expect, it, vi } from 'vitest'
import { resourceScopes } from '../src/resources.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture() {
  const providers = new Map()
  const server = { id: 'personal:mcp:demo', version: 'v1', manifest_version: 'm1', capabilities: { resources: {} } }
  const run = { id: 'r1', ownerId: 'owner', status: 'running', selection: { mcp_servers: [server] } }
  const agent = { id: 's1', ctx: { get: name => name === 'mcpResources' ? {
    register: (id, provider) => { providers.set(id, provider); return () => providers.delete(id) },
  } : undefined } }
  const authorization = { ownerId: run.ownerId, runId: run.id, resource: server }
  const runtime = { ownerId: run.ownerId, mcpCatalogState: { ready: true }, mcpPolicy: { max_call_seconds: 350 },
    executionRun: () => run, authorizeMcpCall: vi.fn(async () => authorization) }
  const platform = { json: vi.fn(async () => ({ data: { resources: [] } })) }
  const scopes = resourceScopes({ workbenchRuntime: runtime, workbenchPlatformClient: platform })
  scopes.sync(agent, [server])
  return { runtime, platform, scopes, server, authorization, request: (extra = {}) => providers.get(server.id).request(
    { method: 'resources/list' }, { agent, callId: 'call-1', signal: new AbortController().signal, ...extra }) }
}

describe('native MCP resource scope', () => {
  it.each([14, 5000])('keeps the deadline within policy when the host clock is ahead by %i ms', async skew => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const h = fixture()
    await h.request()
    const call = h.platform.json.mock.calls[0][0]
    expect(call.deadlineMs).toBe(1_345_000)
    expect(JSON.parse(call.body).deadline_ms - (Date.now() - skew)).toBeLessThanOrEqual(350_000)
    h.scopes.clear(); vi.restoreAllMocks()
  })
  it('uses an earlier caller deadline and refuses an expired call before authorization', async () => {
    const h = fixture(), deadline = Date.now() + 1000
    await h.request({ deadlineMs: deadline })
    expect(h.platform.json.mock.calls[0][0].deadlineMs).toBe(deadline)
    h.platform.json.mockClear(); h.runtime.authorizeMcpCall.mockClear()
    await expect(h.request({ deadlineMs: Date.now() - 1 })).rejects.toThrow('deadline')
    expect(h.runtime.authorizeMcpCall).not.toHaveBeenCalled()
    expect(h.platform.json).not.toHaveBeenCalled()
    h.scopes.clear()
  })
  it.each(['cancelled', 'expired', 'catalog-unavailable', 'rebound'])('does not dispatch after admission becomes %s', async state => {
    const h = fixture(), controller = new AbortController()
    let release
    h.runtime.authorizeMcpCall.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const deadline = Date.now() + 500
    const pending = h.request({ signal: controller.signal, deadlineMs: deadline })
    const outcome = pending.catch(error => error)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    if (state === 'cancelled') controller.abort()
    if (state === 'expired') vi.spyOn(Date, 'now').mockReturnValue(deadline + 1)
    if (state === 'catalog-unavailable') h.runtime.mcpCatalogState.ready = false
    if (state === 'rebound') h.scopes.clear()
    release(h.authorization)
    expect(await outcome).toBeInstanceOf(Error)
    expect(h.platform.json).not.toHaveBeenCalled()
    h.scopes.clear(); vi.restoreAllMocks()
  })
  it('registers resource-only servers per agent and removes stale generations', async () => {
    const registered = new Map()
    const registry = { register: vi.fn((name, provider) => { registered.set(name, provider); return () => registered.delete(name) }) }
    const server = { id: 'global:mcp:cases', name: 'cases', version: '1', manifest_version: 'm1', capabilities: { resources: {} } }
    const run = { id: 'run-a', ownerId: 'owner-a', status: 'running', selection: { mcp_servers: [server] }, mcpTools: [] }
    const agent = { id: 'session-a', ctx: { get: name => name === 'mcpResources' ? registry : undefined } }
    const runtime = { ownerId: 'owner-a', mcpCatalogState: { ready: true }, executionRun: () => run,
      authorizeMcpCall: vi.fn(async () => ({ ownerId: run.ownerId, runId: run.id, resource: server })) }
    const platform = { json: vi.fn(async () => ({ data: { resources: [{ name: 'case', uri: 'fixture://case' }] } })) }
    const scopes = resourceScopes({ workbenchRuntime: runtime, workbenchPlatformClient: platform })
    scopes.sync(agent, [server])
    expect(registered.has(server.id)).toBe(true)
    await expect(registered.get(server.id).request({ method: 'resources/list', cursor: 'next' },
      { agent, callId: 'native-call', signal: new AbortController().signal })).resolves.toMatchObject({ resources: [{ name: 'case' }] })
    expect(JSON.parse(platform.json.mock.calls[0][0].body)).toMatchObject({
      run_id: run.id, server_id: server.id, version: '1', manifest_version: 'm1', method: 'resources/list', params: { cursor: 'next' },
    })
    scopes.sync(agent, [{ ...server, version: '2' }])
    expect(registered.size).toBe(0)
    scopes.clear()
  })
  it('does not expose another owner or a fenced run', () => {
    const register = vi.fn()
    const server = { id: 'global:mcp:cases', name: 'cases', version: '1', manifest_version: 'm', capabilities: { resources: {} } }
    const run = { ownerId: 'owner-b', status: 'running', selection: { mcp_servers: [server] } }
    const ctx = { workbenchRuntime: { ownerId: 'owner-a', mcpCatalogState: { ready: true }, executionRun: () => run } }
    const scopes = resourceScopes(ctx)
    const agent = { id: 's', ctx: { get: name => name === 'mcpResources' ? { register } : undefined } }
    scopes.sync(agent, [server])
    expect(register).not.toHaveBeenCalled()
    run.ownerId = 'owner-a'; run.stopConfirmation = { fenced: true }
    scopes.sync(agent, [server])
    expect(register).not.toHaveBeenCalled()
  })
})
