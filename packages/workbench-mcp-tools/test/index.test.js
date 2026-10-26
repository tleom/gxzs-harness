import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { platformToolName, platformToolNames, publicToolName } from '../src/names.js'
import { apply } from '../src/index.js'
import * as schemas from '../src/schema.js'
import { buildCatalog, renderCatalog } from '../../tool-discovery/src/catalog.js'

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
    : { data: { result: { result: { content: [{ type: 'text', text: 'found' }] } } } }) }
  const ctx = {
    tools: { get: (name) => definitions.get(name), register: vi.fn((definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) }) },
    workbenchPlatformClient: platform,
    workbenchRuntime: { ownerId: 't:1', authorizeMcp: vi.fn(() => authorized ? { ownerId: 't:1', runId: 'run-1', resource: catalogTool } : undefined) },
    on: vi.fn(), effect: vi.fn((factory) => cleanups.push(factory())), logger: { warn: vi.fn() },
  }
  ctx.reflect = { provide: (name, service) => { ctx[name] = service } }
  ctx.workbenchRuntime.authorizeMcpCall = vi.fn(async (session, resource, version) => ctx.workbenchRuntime.authorizeMcp(session, resource, version))
  return { ctx, definitions, platform }
}

describe('platform MCP proxy tools', () => {
  it.each([
    ['renamed', 'tool_definitions_changed'], ['removed', 'tool_definitions_changed'],
    ['resource', 'configuration_changed'], ['legacy-renamed', 'tool_definitions_changed'],
    ['new-resource', 'run_authorization_required'],
  ])('keeps provider authorization explanations accurate for %s', async (scenario, reason) => {
    const { ctx, platform } = setup()
    const agent = { id: 's1', ctx: { tools: { restrict: () => () => {} } } }
    const server = { id: 'personal:mcp:server', name: 'server', scope: 'personal', version: 'v1', manifest_version: 'm1', available: true }
    const resource = scenario.includes('resource')
    ctx.workbenchRuntime.executionRun = () => ({ id: 'r1', ownerId: 't:1', status: 'running',
      mcpTools: resource ? [] : [catalogTool], selection: {
        mcp_servers: ['legacy-renamed', 'new-resource'].includes(scenario) ? [] : [server],
      } })
    ctx.workbenchRuntime.agents = { list: () => [agent] }
    const updated = resource ? { ...server, version: 'v2', capabilities: { resources: {} } } : { ...server, manifest_version: 'm2' }
    platform.json.mockResolvedValueOnce({ plugins: [updated], tools: resource || scenario === 'removed' ? [] : [
      { ...catalogTool, id: 'personal:mcp:server:renamed', tool_name: 'renamed', runtime_name: 'renamed', manifest_version: 'm2' },
    ] })
    await apply(ctx, { discovery: true })
    expect(ctx.toolDiscoveryCatalog.snapshot(agent)).toMatchObject({ tools: [], plugins: [{ available: false, unavailableReason: reason }] })
  })
  it('keeps all 226 frozen tools registered across catalog reorder refreshes', async () => {
    const { ctx, platform, definitions } = setup()
    const tools = Array.from({ length: 226 }, (_, i) => ({ ...catalogTool, id: `personal:mcp:server:tool_${i}`,
      tool_name: `tool_${i}`, runtime_name: `fixture_${i}` }))
    const agent = { id: 's1', ctx: { tools: { restrict: () => () => {} } } }
    ctx.workbenchRuntime.executionRun = () => ({ id: 'r1', ownerId: 't:1', status: 'running', mcpTools: tools })
    ctx.workbenchRuntime.agents = { list: () => [agent] }
    const plugin = { id: 'personal:mcp:server', name: 'server', scope: 'personal', available: true }
    platform.json.mockResolvedValueOnce({ tools, plugins: [plugin] })
    await apply(ctx, { discovery: true })
    const original = new Map(definitions)
    for (let i = 0; i < 3; i++) {
      platform.json.mockResolvedValueOnce({ tools: [...tools].reverse(), plugins: [plugin] })
      await ctx.workbenchRuntime.refreshMcpCatalog()
      expect(ctx.toolDiscoveryCatalog.snapshot(agent).tools).toHaveLength(226)
      for (const [name, definition] of original) expect(definitions.get(name)).toBe(definition)
    }
  })
  it.each([
    [{ version: 'v2' }, 'configuration_changed'],
    [{ manifest_version: 'm2' }, 'tool_definitions_changed'],
  ])('reports a changed frozen binding accurately: %s', async (change, reason) => {
    const { ctx, platform } = setup()
    const agent = { id: 's1', ctx: { tools: { restrict: () => () => {} } } }
    ctx.workbenchRuntime.executionRun = () => ({ id: 'r1', ownerId: 't:1', status: 'running', mcpTools: [catalogTool] })
    ctx.workbenchRuntime.agents = { list: () => [agent] }
    platform.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, ...change }],
      plugins: [{ id: 'personal:mcp:server', name: 'server', scope: 'personal', available: true }] })
    await apply(ctx, { discovery: true })
    expect(ctx.toolDiscoveryCatalog.snapshot(agent)).toMatchObject({ tools: [],
      plugins: [{ available: false, unavailableReason: reason }] })
  })
  it('reuses unchanged schema validation while applying current versions, definitions and removals', async () => {
    const { ctx, platform, definitions } = setup()
    const schema = { type: 'object', properties: { query: { type: 'string', minLength: 2 } } }
    const current = { ...catalogTool, inputSchema: schema }
    const adapt = vi.spyOn(schemas, 'adaptInputSchema')
    try {
      platform.json.mockImplementation(async ({ route }) => route === 'mcp/catalog'
        ? { tools: [JSON.parse(JSON.stringify(current))] }
        : { data: { result: { content: [{ type: 'text', text: 'found' }] } } })
      await apply(ctx)
      expect(adapt).toHaveBeenCalledTimes(1)
      for (let i = 0; i < 10; i++) await ctx.workbenchRuntime.refreshMcpCatalog()
      expect(adapt).toHaveBeenCalledTimes(1)
      current.version = 'v2'
      current.description = 'Changed description'
      const snapshot = await ctx.workbenchRuntime.refreshMcpCatalog()
      expect(snapshot.tools[0]).toMatchObject({ version: 'v2', description: 'Changed description' })
      expect(adapt).toHaveBeenCalledTimes(1)
      current.inputSchema.properties.query.minLength = 5
      await ctx.workbenchRuntime.refreshMcpCatalog()
      expect(adapt).toHaveBeenCalledTimes(2)
      await expect(definitions.get('search').execute({ query: 'abc' },
        { callId: 'changed-bounds', agent: { id: 's' }, signal: new AbortController().signal })).rejects.toThrow('schema')
      platform.json.mockResolvedValueOnce({ tools: [] })
      expect((await ctx.workbenchRuntime.refreshMcpCatalog()).tools).toEqual([])
      expect(definitions.has('search')).toBe(false)
    } finally { adapt.mockRestore() }
  })
  it('registers an implicit 2020-12 tool and validates concurrent requests before platform IO', async () => {
    const { ctx, definitions, platform } = setup()
    const inputSchema = { type: 'object', properties: { query: { type: 'string' }, account: { type: 'string' } },
      dependentRequired: { query: ['account'] } }
    platform.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, inputSchema }] })
    await apply(ctx)
    const tool = definitions.get('search')
    expect(tool).toBeDefined()
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => tool.execute(
      index % 2 ? { query: 'x', account: 'fixture' } : { query: 'x' },
      { callId: `dialect-${index}`, agent: { id: 's1' }, signal: new AbortController().signal })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(8)
    expect(results.filter(result => result.status === 'rejected').every(result => result.reason.message.includes('account'))).toBe(true)
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(8)
  })
  it('reserves native resource and recovery tool names before those scopes are activated', async () => {
    const { ctx, platform, definitions } = setup()
    const names = ['list_mcp_resources', 'read_mcp_resource', 'list_mcp_resource_templates', 'resume_mcp_task_0123456789abcdef']
    platform.json.mockResolvedValueOnce({ tools: names.map((tool_name, index) => ({ ...catalogTool,
      id: `personal:mcp:server:${tool_name}`, tool_name, runtime_name: `provider_${index}` })) })
    await apply(ctx)
    expect(definitions.size).toBe(names.length)
    for (const name of names) expect(definitions.has(name)).toBe(false)
  })

  it('keeps provider time available for task cancellation after the native wait times out', async () => {
    const { ctx, platform, definitions } = setup()
    const db = new DatabaseSync(':memory:')
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE runs(id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('run-1')")
    ctx.workbenchRuntime.database = { db }
    ctx.workbenchRuntime.mcpPolicy = { control_timeout_seconds: 0.2 }
    const tool = { ...catalogTool, execution: { taskSupport: 'required' } }
    const server = { id: 'personal:mcp:server', name: 'server', scope: 'personal', version: 'v1', manifest_version: 'm1',
      protocol_version: '2025-11-25', capabilities: { tasks: { requests: { tools: { call: {} } }, cancel: {} } } }
    const snapshot = status => ({ taskId: 'task', status, createdAt: '2026-10-24T00:00:00Z', lastUpdatedAt: '2026-10-24T00:00:00Z', ttl: 60000, pollInterval: 1 })
    let cancellation
    platform.json.mockImplementation(async request => {
      if (request.route === 'mcp/catalog') return { tools: [tool], plugins: [server] }
      const body = JSON.parse(request.body)
      if (body.method === 'tools/call') return { task_ticket: 'receipt', result: { task: snapshot('working') } }
      if (body.method === 'tasks/get') return new Promise((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      if (body.method === 'tasks/cancel') {
        cancellation = { request, body, at: Date.now() }
        return { result: snapshot('cancelled') }
      }
      throw Error('unexpected request')
    })
    try {
      await apply(ctx)
      const deadlineMs = Date.now() + 600
      await expect(definitions.get('search').execute({ query: 'x' }, { callId: 'timed-task', agent: { id: 's1' },
        signal: new AbortController().signal, deadlineMs })).rejects.toThrow()
      expect(cancellation).toBeDefined()
      expect(cancellation.body.deadline_ms).toBe(deadlineMs)
      expect(cancellation.body.deadline_ms - cancellation.at).toBeGreaterThan(1)
      expect(cancellation.request.signal.aborted).toBe(false)
    } finally { db.close() }
  })

  it('loads one complete catalog and applies the manager-owned call budget', async () => {
    const { ctx, platform, definitions } = setup()
    const second = { ...catalogTool, id: 'personal:server:other', runtime_name: 'personal_other', tool_name: 'other' }
    const policy = { request_bytes: 40 * 1024 * 1024, response_bytes: 40 * 1024 * 1024, max_call_seconds: 900, catalog_timeout_seconds: 300 }
    platform.loadMcpPolicy = vi.fn(async () => policy)
    platform.json.mockResolvedValueOnce({ tools: [catalogTool, second] })
    await apply(ctx)
    expect(platform.loadMcpPolicy).toHaveBeenCalledOnce()
    expect(platform.json.mock.calls[0][0].timeoutMs).toBeGreaterThan(180_000)
    expect([...definitions.keys()]).toEqual(['search', 'other'])
    expect(platform.json).toHaveBeenCalledOnce()
    expect(platform.json.mock.calls[0][0].query).toBeUndefined()
    await definitions.get('search').execute({ query: 'x' }, { callId: 'policy-call', agent: { id: 's1' }, signal: new AbortController().signal })
    const sent = platform.json.mock.calls.at(-1)[0]
    expect(sent.timeoutMs).toBe(895000)
    expect(JSON.parse(sent.body).resource_id).toBe(catalogTool.id)
  })

  it('keeps a healthy tool registered when a sibling schema is invalid', async () => {
    const { ctx, definitions, platform } = setup()
    platform.json.mockResolvedValueOnce({ tools: [catalogTool, { ...catalogTool, id: 'bad', runtime_name: 'bad', tool_name: 'bad', inputSchema: { type: 'string' } }] })
    await apply(ctx)
    expect([...definitions.keys()]).toEqual(['search'])
    expect(ctx.workbenchRuntime.mcpCatalogIssues()).toMatchObject([{ id: 'bad', reason: 'unsupported_schema' }])
  })
  it('updates live registration order when only one global plugin moves', async () => {
    const { ctx, platform, definitions } = setup()
    const tool = (name, order_num) => ({ ...catalogTool, id: `global:mcp:${name}:lookup`,
      runtime_name: `global_${name}`, scope: 'global', server_id: name,
      provider_call_name: name, order_num })
    const first = [tool('alpha', 0), tool('beta', 10), tool('zeta', 20)]
    platform.json.mockResolvedValue({ tools: first })
    await apply(ctx)
    const unchangedDefinition = definitions.get(platformToolNames(first).get(first[0].id))
    expect(unchangedDefinition).toBeDefined()
    const moved = [first[0], tool('zeta', 5), first[1]]
    platform.json.mockResolvedValue({ tools: moved })
    const admitted = await ctx.workbenchRuntime.refreshMcpCatalog()
    expect(ctx.workbenchRuntime.mcpResources().map(item => item.server_id)).toEqual(['alpha', 'zeta', 'beta'])
    expect(admitted.tools.map(item => item.server_id)).toEqual(['alpha', 'zeta', 'beta'])
    expect(definitions.get(platformToolNames(first).get(first[0].id))).toBe(unchangedDefinition)
  })

  it('carries SQL plugin order through authorized discovery into the model directory', async () => {
    const { ctx, platform } = setup()
    const agent = { id: 'chat', session: { id: 'chat' } }
    const tool = (name, order_num) => ({ ...catalogTool, id: `global:mcp:${name}:lookup`,
      runtime_name: `global_${name}`, scope: 'global', server_id: name,
      provider_call_name: name, order_num })
    const tools = [tool('zeta', -10), tool('alpha', 20)]
    ctx.workbenchRuntime.executionRun = () => ({ id: 'run-1', ownerId: 't:1', status: 'running', mcpTools: tools })
    const plugins = tools.map(item => ({ id: `global:mcp:${item.server_id}`, name: item.server_id,
      scope: 'global', order_num: item.order_num }))
    platform.json.mockResolvedValue({ tools, plugins })
    await apply(ctx, { discovery: true })
    const snapshot = ctx.toolDiscoveryCatalog.snapshot(agent)
    expect(snapshot.plugins.map(item => item.order_num)).toEqual([-10, 20])
    const catalog = buildCatalog(snapshot)
    expect([...renderCatalog(catalog, {}).matchAll(/- `([^`]+)`/g)].map(match => match[1])).toEqual(['zeta', 'alpha'])
  })

  it('keeps discovery revision and registered tools stable when personal card order changes', async () => {
    const { ctx, platform, definitions } = setup()
    const agent = { id: 'chat', session: { id: 'chat' } }
    ctx.workbenchRuntime.executionRun = () => ({ id: 'run-1', ownerId: 't:1', status: 'running', mcpTools: [catalogTool] })
    const plugins = ['server', 'other'].map(name => ({ id: `personal:mcp:${name}`, name, scope: 'personal', available: false }))
    platform.json.mockResolvedValueOnce({ tools: [catalogTool], plugins })
    await apply(ctx, { discovery: true })
    const first = ctx.toolDiscoveryCatalog.snapshot(agent)
    const definition = definitions.get('search')
    platform.json.mockResolvedValueOnce({ tools: [catalogTool], plugins: [...plugins].reverse() })
    await ctx.workbenchRuntime.refreshMcpCatalog()
    const reordered = ctx.toolDiscoveryCatalog.snapshot(agent)
    expect(reordered.revision).toBe(first.revision)
    expect(reordered.tools).toEqual(first.tools)
    expect(definitions.get('search')).toBe(definition)
  })
  it('keeps the registered definition across reordered catalog object members', async () => {
    const { ctx, platform, definitions } = setup()
    await apply(ctx)
    const first = definitions.get('search')
    const refresh = ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]
    platform.json.mockResolvedValue({ tools: [{ ...catalogTool, inputSchema: {
      additionalProperties: false, required: ['query'], properties: { query: { type: 'string' } }, type: 'object',
    } }] })
    await refresh()
    expect(definitions.get('search')).toBe(first)
    expect(ctx.tools.register).toHaveBeenCalledOnce()
    platform.json.mockResolvedValue({ tools: [{ ...catalogTool, inputSchema: {
      type: 'object', properties: { query: { type: 'integer' } }, required: ['query'], additionalProperties: false,
    } }] })
    await refresh()
    expect(definitions.get('search')).not.toBe(first)
    expect(ctx.tools.register).toHaveBeenCalledTimes(2)
  })
  it.each(['expired', 'waiting'])('honors an %s caller deadline before external MCP I/O', async state => {
    const { ctx, platform, definitions } = setup()
    await apply(ctx)
    ctx.workbenchRuntime.authorizeMcpCall.mockImplementation((_session, _id, _version, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        if (signal.aborted) reject(signal.reason)
      }))
    await expect(definitions.get('search').execute({ query: 'q' }, {
      callId: 'deadline', agent: { id: 's1' }, deadlineMs: Date.now() + (state === 'expired' ? -1 : 40),
    })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(ctx.workbenchRuntime.authorizeMcpCall).toHaveBeenCalledTimes(state === 'expired' ? 0 : 1)
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(0)
  })
  it.each(['ready', 'cancelled', 'revoked'])('waits for renewed admission before proxy I/O and rechecks %s state', async state => {
    const { ctx, platform, definitions } = setup()
    await apply(ctx)
    let release
    ctx.workbenchRuntime.authorizeMcpCall.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const controller = new AbortController()
    const pending = definitions.get('search').execute({ query: 'q' }, { callId: 'waiting-admission', agent: { id: 's1' }, signal: controller.signal })
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(0)
    if (state === 'cancelled') controller.abort()
    if (state === 'revoked') ctx.workbenchRuntime.mcpCatalogState.ready = false
    release({ runId: 'run-1', ownerId: 't:1', resource: catalogTool })
    const result = await outcome
    expect(Boolean(result.error)).toBe(state !== 'ready')
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(state === 'ready' ? 1 : 0)
  })
  it('keeps recovered plugin metadata visible without expanding the current frozen run authorization', async () => {
    const { ctx, platform } = setup()
    const agent = { id: 's1', ctx: { tools: { restrict: () => () => {} } } }
    let run = { id: 'r1', ownerId: 't:1', status: 'running', mcpTools: [] }
    ctx.workbenchRuntime.executionRun = () => run
    ctx.workbenchRuntime.agents = { list: () => [agent] }
    const plugin = { id: 'personal:mcp:server', name: 'server', scope: 'personal', available: false }
    platform.json.mockResolvedValueOnce({ tools: [], plugins: [plugin] })
    await apply(ctx, { discovery: true })
    platform.json.mockResolvedValueOnce({ tools: [catalogTool], plugins: [{ ...plugin, available: true }] })
    const frozen = await ctx.workbenchRuntime.refreshMcpCatalog()
    expect(frozen.tools).toMatchObject([{ id: catalogTool.id }])
    expect(frozen.tools[0].inputSchema).toEqual(catalogTool.inputSchema)
    expect(frozen.tools[0].runtime_name).toBe('search')
    for (const field of ['sourceInputSchema', 'definitionStamp', 'discoveryStamp', 'validateArguments'])
      expect(frozen.tools[0]).not.toHaveProperty(field)
    expect(ctx.toolDiscoveryCatalog.snapshot(agent)).toMatchObject({ tools: [], plugins: [
      { name: 'server', available: false, unavailableReason: 'run_authorization_required' },
    ] })
    run = { ...run, id: 'r2', mcpTools: [catalogTool] }
    expect(ctx.toolDiscoveryCatalog.snapshot(agent).tools).toHaveLength(1)
    expect(ctx.toolDiscoveryCatalog.snapshot(agent).plugins[0].unavailableReason).toBeUndefined()
    run = { ...run, ownerId: 'other-owner' }
    expect(ctx.toolDiscoveryCatalog.snapshot(agent).plugins).toEqual([])
  })
  it('does not freeze stale retained definitions after a failed admission refresh', async () => {
    const { ctx, platform, definitions } = setup()
    await apply(ctx)
    expect(definitions.size).toBe(1)
    platform.json.mockRejectedValueOnce(Object.assign(new Error('upstream details'), { status: 503 }))
    await expect(ctx.workbenchRuntime.refreshMcpCatalog()).rejects.toMatchObject({ status: 503, code: 'MCP_CATALOG_UNAVAILABLE' })
    expect(definitions.size).toBe(1)
    expect(ctx.workbenchRuntime.mcpCatalogState.status).toBe('degraded')
  })
  it.each([false, true])('coalesces concurrent admissions while preserving resource-change refreshes (%s)', async changed => {
    const { ctx, platform } = setup()
    await apply(ctx)
    const releases = []
    platform.json.mockClear().mockImplementation(() => new Promise(resolve => releases.push(resolve)))
    const admissions = Array.from({ length: 20 }, () => ctx.workbenchRuntime.refreshMcpCatalog())
    expect(platform.json).toHaveBeenCalledOnce()
    const refresh = ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]
    const update = changed ? refresh() : undefined
    releases[0]({ tools: [catalogTool] })
    if (changed) {
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      admissions.push(...Array.from({ length: 20 }, () => ctx.workbenchRuntime.refreshMcpCatalog()))
      releases[1]({ tools: [] })
    }
    const frozen = await Promise.all(admissions)
    await update
    expect(platform.json).toHaveBeenCalledTimes(changed ? 2 : 1)
    expect(frozen.every(({ tools }) => tools.length === (changed ? 0 : 1))).toBe(true)
  })
  it('keeps empty and unavailable plugin metadata owner-scoped and refreshes its revision', async () => {
    const { ctx, platform } = setup()
    const agent = { id: 's1', ctx: { tools: { restrict: () => () => {} } } }
    let run = { id: 'r1', ownerId: 't:1', status: 'running', mcpTools: [] }
    ctx.workbenchRuntime.executionRun = () => run
    ctx.workbenchRuntime.agents = { list: () => [agent] }
    const plugins = [
      { id: 'global:mcp:empty', name: 'empty', displayName: '空插件', scope: 'global', available: true },
      { id: 'personal:mcp:offline', name: 'offline', displayName: '离线插件', scope: 'personal', available: false },
    ]
    platform.json.mockResolvedValueOnce({ tools: [], plugins })
    await apply(ctx, { discovery: true })
    const first = ctx.toolDiscoveryCatalog.snapshot(agent)
    expect(first).toMatchObject({ ready: true, tools: [], plugins })
    platform.json.mockResolvedValueOnce({ tools: [], plugins: [{ ...plugins[0], description: '更新说明' }, plugins[1]] })
    await ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]()
    expect(ctx.toolDiscoveryCatalog.snapshot(agent).revision).not.toBe(first.revision)
    run = { ...run, ownerId: 'another-owner' }
    expect(ctx.toolDiscoveryCatalog.snapshot(agent)).toMatchObject({ ready: false, tools: [], plugins: [] })
  })

  for (const scope of ['global', 'personal']) it(`rejects required-task ${scope} tools without an authorized server declaration`, async () => {
    const { ctx, definitions, platform } = setup()
    platform.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, scope, execution: { taskSupport: 'required' } }] })
    await apply(ctx)
    await expect(definitions.get('search').execute({ query: 'q' }, {
      callId: 'task-required', agent: { id: 's1' }, signal: new AbortController().signal,
    })).rejects.toThrow('MCP 任务能力已改变')
    expect(platform.json).toHaveBeenCalledTimes(1)
  })
  it('passes server output schemas to the native MCP definition', async () => {
    const { ctx, definitions, platform } = setup()
    const outputSchema = { type: 'object', properties: { found: { type: 'boolean' } }, required: ['found'] }
    platform.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, outputSchema }] })
    await apply(ctx)
    expect(definitions.get('search').output.schema).toMatchObject({
      properties: { structuredContent: outputSchema }, required: ['content', 'structuredContent'],
    })
  })
  it('uses original names by default and adds stable disambiguation only when necessary', () => {
    expect(publicToolName('server', 'search')).toBe('search')
    expect(publicToolName('server', 'a.b')).not.toBe(publicToolName('server', 'a_b'))
    expect(publicToolName('server', 's'.repeat(70))).toHaveLength(64)
    expect(publicToolName('server', 'run_code')).not.toBe('run_code')
    expect(publicToolName('server', 'tool_search')).not.toBe('tool_search')
    expect(platformToolName({ ...catalogTool, scope: 'global', server_id: 'global-memory', tool_name: 'stg' })).toBe('stg')
    expect(platformToolName({ ...catalogTool, server_id: 'gaode', tool_name: 'maps_direction_bicycling' })).toBe('maps_direction_bicycling')
    const other = { ...catalogTool, id: 'global:server:search', scope: 'global' }
    const names = platformToolNames([catalogTool, other])
    expect(names.get(catalogTool.id)).toMatch(/^search_[a-f0-9]{12}$/)
    expect(names.get(catalogTool.id)).not.toBe(names.get(other.id))
    expect([...platformToolNames([other, catalogTool])].sort()).toEqual([...names].sort())
  })

  it('keeps discovery metadata authorized while denying MCP exposure before startup and after disposal', async () => {
    const { ctx, platform } = setup()
    let run = { id: 'run-1', ownerId: 't:1', status: 'running', mcpTools: [catalogTool] }
    const masks = new Set()
    const agent = { id: 's1', ctx: { tools: { restrict: policy => {
      masks.add(policy)
      return () => masks.delete(policy)
    } } } }
    ctx.workbenchRuntime.executionRun = vi.fn(() => run)
    ctx.workbenchRuntime.agents = { list: () => [agent] }
    await apply(ctx, { discovery: true })
    const bridge = ctx.toolDiscoveryCatalog
    expect([...masks]).toEqual([{ deny: ['search'] }])
    ctx.workbenchRuntime.executionRun.mockClear()
    const original = bridge.snapshot(agent)
    expect(ctx.workbenchRuntime.executionRun).toHaveBeenCalledTimes(1)
    expect(original).toMatchObject({ ready: true, authorityKey: 't:1\0run-1',
      tools: [{ id: catalogTool.id, name: 'search', pluginId: 'personal:mcp:server', pluginScope: 'personal' }],
      plugins: [{ id: 'personal:mcp:server', name: 'server' }] })
    const listener = vi.fn()
    const unsubscribe = bridge.subscribe(listener)
    bridge.setDiscoveryReady(true)
    bridge.setDiscoveryReady(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(masks.size).toBe(0)
    const assemble = ctx.on.mock.calls.find(([event]) => event === 'system-prompt/assemble')[1]
    expect((await assemble({}, { scope: agent }, async () => ({ tools: [], sections: [] }))).sections).toEqual([])
    platform.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, description: 'Changed without version bump' }] })
    await ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]()
    expect(bridge.snapshot(agent).revision).not.toBe(original.revision)
    run = { ...run, id: 'run-2' }
    expect(bridge.snapshot(agent).authorityKey).toBe('t:1\0run-2')
    run = { ...run, stopConfirmation: { fenced: true } }
    expect(bridge.snapshot(agent)).toMatchObject({ ready: false, tools: [], authorityKey: '' })
    expect((await assemble({}, { scope: agent }, async () => ({ tools: [{ name: 'search' }], sections: [] }))).tools).toEqual([])
    run = { ...run, stopConfirmation: undefined }
    run = { ...run, ownerId: 'foreign' }
    expect(bridge.snapshot(agent)).toMatchObject({ ready: false, tools: [], authorityKey: '' })
    bridge.setDiscoveryReady(false)
    expect([...masks]).toEqual([{ deny: ['search'] }])
    expect(bridge.managedNames()).toEqual(['search'])
    unsubscribe()
    const calls = listener.mock.calls.length
    bridge.notify()
    expect(listener).toHaveBeenCalledTimes(calls)
  })
  it('retains registered tools on transient catalog failure and removes them only after a successful empty catalog', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const refresh = ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]
    platform.json.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
    await refresh()
    expect(definitions.has(platformToolName(catalogTool))).toBe(true)
    expect(ctx.workbenchRuntime.mcpCatalogState).toMatchObject({ ready: true, status: 'degraded', errorCode: 'HTTP_503' })
    platform.json.mockResolvedValueOnce({ tools: [] })
    await refresh()
    expect(definitions.size).toBe(0)
  })
  it('returns personal MCP content through the real nested platform envelope', async () => {
    const { ctx, definitions } = setup()
    await apply(ctx)
    await expect(definitions.get('search').execute({ query: 'q' }, {
      callId: 'nested', agent: { id: 's1' }, signal: new AbortController().signal,
    })).resolves.toEqual({ content: [{ type: 'text', text: 'found' }] })
  })
  it('accepts the direct global result and rejects malformed or uncertain results visibly', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const tool = definitions.get('search')
    const exec = { callId: 'call-1', agent: { id: 's1' }, signal: new AbortController().signal }
    platform.json.mockResolvedValueOnce({ data: { result: { content: [{ type: 'text', text: 'global' }] } } })
    await expect(tool.execute({ query: 'q' }, exec)).resolves.toEqual({ content: [{ type: 'text', text: 'global' }] })
    platform.json.mockResolvedValueOnce({ data: { result: { result: { unexpected: true } } } })
    await expect(tool.execute({ query: 'q' }, exec)).rejects.toThrow('missing CallToolResult.content')
    platform.json.mockResolvedValueOnce({ data: { result: { error: '此前请求结果未知', uncertain: true } } })
    await expect(tool.execute({ query: 'q' }, exec)).rejects.toThrow('此前请求结果未知')
  })
  it('registers bounded external schemas while validating bounds before proxy I/O', async () => {
    const { ctx, definitions, platform } = setup()
    const inputSchema = { type: 'object', properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
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
    await expect(tool.execute({ title: '' }, exec)).rejects.toThrow('fewer than 1 characters')
    await expect(tool.execute({ title: 'x'.repeat(101) }, exec)).rejects.toThrow('more than 100 characters')
    await expect(tool.execute({ idempotencyKey: 'invalid key' }, exec)).rejects.toThrow('match pattern')
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(0)
    await expect(tool.execute({ title: '合法标题', max_results: 5, references: { values: ['one'] } }, exec)).resolves.toBeDefined()
  })
  it('registers catalog tools and proxies only frozen authorized calls', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const tool = definitions.get(platformToolName(catalogTool))
    expect(tool).toBeDefined()
    const controller = new AbortController()
    const signal = controller.signal
    await expect(tool.execute({ query: 'case' }, { callId: 'call-1', agent: { id: 's1' }, signal })).resolves.toEqual({ content: [{ type: 'text', text: 'found' }] })
    expect(ctx.workbenchRuntime.authorizeMcp).toHaveBeenCalledWith('s1', catalogTool.id, 'v1')
    const call = platform.json.mock.calls.find(([request]) => request.route === 'mcp/call')[0]
    expect(tool.name).toBe('search')
    expect(JSON.parse(call.body.toString())).toMatchObject({ run_id: 'run-1', resource_id: catalogTool.id, version: 'v1',
      server_id: 'server', tool_name: 'search', arguments: { query: 'case' } })
    expect(call.signal.aborted).toBe(false)
    controller.abort()
    expect(call.signal.aborted).toBe(true)
    expect(call.timeoutMs).toBeGreaterThan(0)
    expect(call.timeoutMs).toBeLessThanOrEqual(345_000)
    expect(JSON.parse(call.body.toString()).deadline_ms).toBe(call.deadlineMs)
  })

  it.each([14, 5000])('stays inside the platform deadline window when the host clock is %i ms ahead', async (clockSkewMs) => {
    vi.useFakeTimers()
    const hostNow = 1_790_000_000_000
    vi.setSystemTime(hostNow)
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    // Reproduce the platform admission rule with an independently lagging clock.
    // The old hostNow + 350000 value fails this rule even for 14 ms of skew.
    const platformNow = hostNow - clockSkewMs
    expect(hostNow + 350_000 - platformNow).toBeGreaterThan(350_000)
    platform.json.mockImplementationOnce(async (call) => {
      const remaining = JSON.parse(call.body.toString()).deadline_ms - platformNow
      if (remaining <= 0 || remaining > 350_000) throw new Error('deadline rejected')
      expect(call.deadlineMs).toBe(hostNow + 345_000)
      expect(call.timeoutMs).toBe(345_000)
      return { result: { content: [] } }
    })
    await expect(definitions.get(platformToolName(catalogTool)).execute({ query: 'case' }, {
      callId: 'clock-test', agent: { id: 's1' }, signal: new AbortController().signal,
    })).resolves.toEqual({ content: [] })
  })

  it('preserves an earlier caller deadline without resetting its remaining budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_790_000_000_000)
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const deadlineMs = Date.now() + 1200
    await definitions.get(platformToolName(catalogTool)).execute({ query: 'case' }, {
      callId: 'short-deadline', agent: { id: 's1' }, signal: new AbortController().signal, deadlineMs,
    })
    const call = platform.json.mock.calls.find(([request]) => request.route === 'mcp/call')[0]
    expect(call.deadlineMs).toBe(deadlineMs)
    expect(JSON.parse(call.body.toString()).deadline_ms).toBe(deadlineMs)
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
    await expect(updated.execute({ count: 1 }, { callId: 'call-stale', agent: { id: 's1' }, signal: new AbortController().signal })).rejects.toThrow('definition has changed')
    ctx.workbenchRuntime.authorizeMcp.mockReturnValue({ ownerId: 't:1', runId: 'run-2', resource: { ...catalogTool, manifest_version: 'm2' } })
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

  it('quarantines an invalid schema while keeping the catalog available', async () => {
    const { ctx } = setup()
    ctx.workbenchPlatformClient.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, inputSchema: { type: 'string' } }] })
    await apply(ctx)
    expect(ctx.workbenchRuntime.mcpCatalogState.status).toBe('ready')
    expect(ctx.tools.register).not.toHaveBeenCalled()
    expect(ctx.workbenchRuntime.mcpCatalogIssues()).toHaveLength(1)
  })

  it('quarantines duplicate runtime identities while retaining the valid tool', async () => {
    const { ctx } = setup()
    ctx.workbenchPlatformClient.json.mockResolvedValueOnce({ tools: [catalogTool, { ...catalogTool, id: 'global:other:search' }] })
    await apply(ctx)
    expect(ctx.workbenchRuntime.mcpCatalogState.status).toBe('ready')
    expect(ctx.tools.register).toHaveBeenCalledTimes(1)
    expect(ctx.workbenchRuntime.mcpCatalogIssues()).toHaveLength(1)
  })

  it('keeps same-name providers independently routable and refreshes aliases consistently', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const other = { ...catalogTool, id: 'global:other:search', scope: 'global', server_id: 'other', runtime_name: 'global_other_search' }
    const collisionName = platformToolNames([catalogTool, other]).get(catalogTool.id)
    const colliding = { ...catalogTool, id: `personal:mcp:alias:${collisionName}`, server_id: 'alias',
      name: collisionName, tool_name: collisionName, runtime_name: 'personal_alias' }
    const catalog = [catalogTool, other, colliding]
    platform.json.mockResolvedValueOnce({ tools: catalog })
    await ctx.on.mock.calls.find(([event]) => event === 'workbench/resources-changed')[1]()
    const names = platformToolNames(catalog)
    expect(definitions.has('search')).toBe(false)
    expect(definitions.size).toBe(3)
    ctx.workbenchRuntime.authorizeMcp.mockImplementation((_session, resourceId) => ({ ownerId: 't:1', runId: 'run-1', resource: catalog.find(tool => tool.id === resourceId) }))
    for (const tool of catalog) {
      await definitions.get(names.get(tool.id)).execute({ query: 'q' }, { callId: `call-${tool.scope}`, agent: { id: 's1' }, signal: new AbortController().signal })
      const body = JSON.parse(platform.json.mock.calls.at(-1)[0].body)
      expect(body).toMatchObject({ resource_id: tool.id, server_id: tool.server_id, tool_name: tool.tool_name })
    }
  })

  it('aliases a native tool collision while preserving its upstream identity', async () => {
    const { ctx, definitions, platform } = setup()
    const builtin = { name: 'search' }
    definitions.set('search', builtin)
    await apply(ctx)
    expect(definitions.get('search')).toBe(builtin)
    const alias = platformToolNames([catalogTool], name => name === 'search').get(catalogTool.id)
    expect(alias).not.toBe('search')
    await definitions.get(alias).execute({ query: 'q' }, { callId: 'alias-call', agent: { id: 's1' }, signal: new AbortController().signal })
    expect(JSON.parse(platform.json.mock.calls.at(-1)[0].body)).toMatchObject({ resource_id: catalogTool.id, tool_name: 'search' })
    await ctx.workbenchRuntime.refreshMcpCatalog()
    expect(definitions.size).toBe(2)
    expect(definitions.has(alias)).toBe(true)
  })

  it('recovers automatically when the first invalid catalog is repaired', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, definitions } = setup()
      ctx.workbenchPlatformClient.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, inputSchema: { type: 'string' } }] })
      await apply(ctx)
      expect(definitions.size).toBe(0)
      expect(ctx.workbenchRuntime.mcpCatalogState.status).toBe('ready')
      expect(ctx.workbenchRuntime.mcpCatalogIssues()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(30000)
      expect(ctx.workbenchRuntime.mcpCatalogState.status).toBe('ready')
      expect(definitions.has('search')).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('only exposes frozen selected tools to the model and refreshes native scope restrictions', async () => {
    const { ctx, platform, definitions } = setup()
    const weather = { ...catalogTool, id: 'personal:mcp:gaode:maps_weather', runtime_name: 'personal_gaode_weather', server_id: 'gaode', tool_name: 'maps_weather' }
    platform.json.mockResolvedValueOnce({ tools: [weather] })
    let run = { ownerId: 't:1', status: 'running', mcpTools: [] }
    ctx.workbenchRuntime.executionRun = vi.fn(() => run)
    const dispose = vi.fn()
    const agent = { id: 's1', ctx: { tools: { restrict: vi.fn(() => dispose) } } }
    ctx.workbenchRuntime.agents = { list: () => [agent] }
    await apply(ctx)
    expect(agent.ctx.tools.restrict).toHaveBeenCalledWith({ deny: ['maps_weather'] })
    const assemble = ctx.on.mock.calls.find(([event]) => event === 'system-prompt/assemble')[1]
    const next = async () => ({ tools: [{ name: 'read' }, { name: 'maps_weather' }], sections: [] })
    expect((await assemble({}, { scope: agent }, next)).tools).toEqual([{ name: 'read' }])
    run = { ...run, mcpTools: [weather] }
    ctx.on.mock.calls.find(([event]) => event === 'agent/inbox/claimed')[1]({ agent })
    expect(dispose).toHaveBeenCalledOnce()
    const available = await assemble({}, { scope: agent }, next)
    expect(available.tools.map(tool => tool.name)).toEqual(['read', 'maps_weather'])
    expect(available.sections[0].text).toContain('"name":"gaode"')
    expect(available.sections[0].text).toContain('maps_weather')
    ctx.workbenchRuntime.authorizeMcp.mockReturnValue({ ownerId: 't:1', runId: 'run-weather', resource: weather })
    await definitions.get('maps_weather').execute({ query: 'q' }, { callId: 'weather-call', agent, signal: new AbortController().signal })
    expect(JSON.parse(platform.json.mock.calls.at(-1)[0].body)).toMatchObject({ run_id: 'run-weather', resource_id: weather.id, server_id: 'gaode', tool_name: 'maps_weather' })
    run = { ...run, mcpTools: [{ ...weather, version: 'old' }] }
    expect((await assemble({}, { scope: agent }, next)).tools).toEqual([{ name: 'read' }])
    run = { ...run, ownerId: 'other' }
    expect((await assemble({}, { scope: agent }, next)).tools).toEqual([{ name: 'read' }])
    ctx.on.mock.calls.find(([event]) => event === 'agent/disposed')[1]({ agent })
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
