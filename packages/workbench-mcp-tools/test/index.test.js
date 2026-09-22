import { afterEach, describe, expect, it, vi } from 'vitest'
import { platformToolName, publicToolName } from '../src/names.js'
import { apply } from '../src/index.js'

const catalogTool = {
  id: 'personal:server:search', runtime_name: 'personal_mcp_search', version: 'v1', manifest_version: 'm1',
  scope: 'personal', server_id: 'server', tool_name: 'search', description: 'Search records',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
}

const cleanups = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers() })

function setup({ authorized = true } = {}) {
  const definitions = new Map()
  const platform = { json: vi.fn(async ({ route }) => route === 'mcp/catalog'
    ? { tools: [catalogTool] }
    : { result: { content: [{ type: 'text', text: 'found' }] } }) }
  const ctx = {
    tools: { register: vi.fn((definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) }) },
    workbenchPlatformClient: platform,
    workbenchRuntime: { ownerId: 't:1', authorizeMcp: vi.fn(() => authorized ? { ownerId: 't:1', runId: 'run-1' } : undefined) },
    on: vi.fn(), effect: vi.fn((factory) => cleanups.push(factory())), logger: { warn: vi.fn() },
  }
  return { ctx, definitions, platform }
}

describe('platform MCP proxy tools', () => {
  it('keeps native public names stable and separates server scopes', () => {
    expect(publicToolName('server', 'search')).toBe('mcp__server__search')
    expect(publicToolName('server', 'a.b')).not.toBe(publicToolName('server', 'a_b'))
    expect(publicToolName('s'.repeat(70), 'search')).toHaveLength(64)
    expect(platformToolName(catalogTool)).not.toBe(platformToolName({ ...catalogTool, scope: 'global' }))
  })
  it('retains registered tools on transient catalog failure and removes them only after a successful empty catalog', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const refresh = ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]
    platform.json.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
    await refresh()
    expect(definitions.has(platformToolName(catalogTool))).toBe(true)
    platform.json.mockResolvedValueOnce({ tools: [] })
    await refresh()
    expect(definitions.size).toBe(0)
  })
  it('registers bounded external schemas while validating bounds before proxy I/O', async () => {
    const { ctx, definitions, platform } = setup()
    const inputSchema = { type: 'object', properties: {
      references: { type: 'object', properties: { values: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 } } },
      max_results: { type: 'integer', minimum: 1, maximum: 20 },
      start_date: { type: 'string', format: 'date' },
    } }
    platform.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, inputSchema }] })
    await apply(ctx)
    const tool = definitions.get(platformToolName(catalogTool))
    expect(tool.parameters.properties.max_results).toMatchObject({ type: 'integer', description: 'minimum: 1; maximum: 20' })
    expect(inputSchema.properties.max_results.maximum).toBe(20)
    const exec = { callId: 'call-1', agent: { id: 's1' }, signal: new AbortController().signal }
    await expect(tool.execute({ max_results: 21 }, exec)).rejects.toThrow('<= 20')
    await expect(tool.execute({ references: { values: [] } }, exec)).rejects.toThrow('fewer than 1')
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(0)
    await expect(tool.execute({ max_results: 5, references: { values: ['one'] } }, exec)).resolves.toBeDefined()
  })
  it('registers catalog tools and proxies only frozen authorized calls', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const tool = definitions.get(platformToolName(catalogTool))
    expect(tool).toBeDefined()
    const signal = new AbortController().signal
    await expect(tool.execute({ query: 'case' }, { callId: 'call-1', agent: { id: 's1' }, signal })).resolves.toEqual({ content: [{ type: 'text', text: 'found' }] })
    expect(ctx.workbenchRuntime.authorizeMcp).toHaveBeenCalledWith('s1', catalogTool.id, 'v1')
    const call = platform.json.mock.calls.find(([request]) => request.route === 'mcp/call')[0]
    expect(JSON.parse(call.body.toString())).toMatchObject({ run_id: 'run-1', resource_id: catalogTool.id, version: 'v1', arguments: { query: 'case' } })
    expect(call.signal).toBe(signal)
    expect(call.timeoutMs).toBe(350_000)
    expect(JSON.parse(call.body.toString()).deadline_ms).toBe(call.deadlineMs)
  })

  it('rejects calls not frozen for the active run before platform I/O', async () => {
    const { ctx, definitions, platform } = setup({ authorized: false })
    await apply(ctx)
    await expect(definitions.get(platformToolName(catalogTool)).execute({}, { agent: { id: 's1' }, signal: new AbortController().signal })).rejects.toThrow('not authorized')
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(0)
  })

  it.each([502, 503])('starts without MCP tools when the optional platform returns %s', async (status) => {
    const { ctx, definitions } = setup()
    ctx.workbenchPlatformClient.json.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status }))
    await expect(apply(ctx)).resolves.toBeUndefined()
    expect(definitions.size).toBe(0)
    expect(ctx.workbenchRuntime.mcpCatalogState.ready).toBe(false)
  })

  it('recovers bootstrap authorization through polling and clears tools on later access denial', async () => {
    vi.useFakeTimers()
    const { ctx, definitions, platform } = setup()
    platform.json.mockRejectedValueOnce(Object.assign(new Error('host not registered'), { status: 401 }))
    await apply(ctx)
    expect(definitions.size).toBe(0)
    expect(ctx.workbenchRuntime.mcpCatalogState.ready).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(definitions.size).toBe(1)
    expect(ctx.workbenchRuntime.mcpCatalogState.ready).toBe(true)
    platform.json.mockRejectedValueOnce(Object.assign(new Error('access denied'), { status: 403 }))
    await ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]()
    expect(definitions.size).toBe(0)
    expect(ctx.workbenchRuntime.mcpCatalogState.ready).toBe(false)
  })

  it('refreshes a changed manifest even when configuration version is unchanged', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const old = definitions.get(platformToolName(catalogTool))
    platform.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, manifest_version: 'm2', inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } }] })
    await ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]()
    const updated = definitions.get(platformToolName(catalogTool))
    expect(updated).not.toBe(old)
    await updated.execute({ count: 1 }, { callId: 'call-2', agent: { id: 's1' }, signal: new AbortController().signal })
    const call = platform.json.mock.calls.find(([request]) => request.route === 'mcp/call')[0]
    expect(JSON.parse(call.body.toString()).manifest_version).toBe('m2')
  })

  it('serializes catalog reads and reruns a refresh invalidated while in flight', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    let resolveFirst
    platform.json.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    platform.json.mockResolvedValueOnce({ tools: [] })
    const refresh = ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]
    const first = refresh()
    const second = refresh()
    expect(platform.json).toHaveBeenCalledTimes(2)
    resolveFirst({ tools: [catalogTool] })
    await Promise.all([first, second])
    expect(platform.json).toHaveBeenCalledTimes(3)
    expect(definitions.size).toBe(0)
  })

  it('does not issue a call without a durable invocation id or after cancellation', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const tool = definitions.get(platformToolName(catalogTool))
    await expect(tool.execute({ query: 'x' }, { agent: { id: 's1' }, signal: new AbortController().signal })).rejects.toThrow('callId')
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(tool.execute({ query: 'x' }, { callId: 'call-1', agent: { id: 's1' }, signal: controller.signal })).rejects.toThrow('cancelled')
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(0)
  })

  it('rejects invalid JSON schemas before registering a partial catalog', async () => {
    const { ctx } = setup()
    ctx.workbenchPlatformClient.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, inputSchema: { type: 'string' } }] })
    await expect(apply(ctx)).rejects.toThrow()
    expect(ctx.tools.register).not.toHaveBeenCalled()
  })

  it('rejects duplicate runtime names without registering a partial catalog', async () => {
    const { ctx } = setup()
    ctx.workbenchPlatformClient.json.mockResolvedValueOnce({ tools: [catalogTool, { ...catalogTool, id: 'global:other:search' }] })
    await expect(apply(ctx)).rejects.toThrow('unique')
    expect(ctx.tools.register).not.toHaveBeenCalled()
  })
})
