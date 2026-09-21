import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

const catalogTool = {
  id: 'personal:server:search', runtime_name: 'personal_mcp_search', version: 'v1', manifest_version: 'm1',
  scope: 'personal', server_id: 'server', tool_name: 'search', description: 'Search records',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
}

function setup({ authorized = true } = {}) {
  const definitions = new Map()
  const platform = { json: vi.fn(async ({ route }) => route === 'mcp/catalog'
    ? { tools: [catalogTool] }
    : { result: { content: [{ type: 'text', text: 'found' }] } }) }
  const ctx = {
    tools: { register: vi.fn((definition) => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) }) },
    workbenchPlatformClient: platform,
    workbenchRuntime: { ownerId: 't:1', authorizeMcp: vi.fn(() => authorized ? { ownerId: 't:1', runId: 'run-1' } : undefined) },
    on: vi.fn(), effect: vi.fn(), logger: { warn: vi.fn() },
  }
  return { ctx, definitions, platform }
}

describe('platform MCP proxy tools', () => {
  it('registers bounded external schemas while validating bounds before proxy I/O', async () => {
    const { ctx, definitions, platform } = setup()
    const inputSchema = { type: 'object', properties: {
      references: { type: 'object', properties: { values: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 } } },
      max_results: { type: 'integer', minimum: 1, maximum: 20 },
      start_date: { type: 'string', format: 'date' },
    } }
    platform.json.mockResolvedValueOnce({ tools: [{ ...catalogTool, inputSchema }] })
    await apply(ctx)
    const tool = definitions.get(catalogTool.runtime_name)
    expect(tool.parameters.properties.max_results).toMatchObject({ type: 'integer', description: 'minimum: 1; maximum: 20' })
    expect(inputSchema.properties.max_results.maximum).toBe(20)
    const exec = { agent: { id: 's1' }, signal: new AbortController().signal }
    await expect(tool.execute({ max_results: 21 }, exec)).rejects.toThrow('maximum')
    await expect(tool.execute({ references: { values: [] } }, exec)).rejects.toThrow('minItems')
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(0)
    await expect(tool.execute({ max_results: 5, references: { values: ['one'] } }, exec)).resolves.toBeDefined()
  })
  it('registers catalog tools and proxies only frozen authorized calls', async () => {
    const { ctx, definitions, platform } = setup()
    await apply(ctx)
    const tool = definitions.get('personal_mcp_search')
    expect(tool).toBeDefined()
    await expect(tool.execute({ query: 'case' }, { agent: { id: 's1' }, signal: new AbortController().signal })).resolves.toEqual({ content: [{ type: 'text', text: 'found' }] })
    expect(ctx.workbenchRuntime.authorizeMcp).toHaveBeenCalledWith('s1', catalogTool.id, 'v1')
    const call = platform.json.mock.calls.find(([request]) => request.route === 'mcp/call')[0]
    expect(JSON.parse(call.body.toString())).toMatchObject({ run_id: 'run-1', resource_id: catalogTool.id, version: 'v1', arguments: { query: 'case' } })
  })

  it('rejects calls not frozen for the active run before platform I/O', async () => {
    const { ctx, definitions, platform } = setup({ authorized: false })
    await apply(ctx)
    await expect(definitions.get('personal_mcp_search').execute({}, { agent: { id: 's1' }, signal: new AbortController().signal })).rejects.toThrow('not authorized')
    expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/call')).toHaveLength(0)
  })

  it.each([502, 503])('starts without MCP tools when the optional platform returns %s', async (status) => {
    const { ctx, definitions } = setup()
    ctx.workbenchPlatformClient.json.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status }))
    await expect(apply(ctx)).resolves.toBeUndefined()
    expect(definitions.size).toBe(0)
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
