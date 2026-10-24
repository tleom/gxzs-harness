import { describe, expect, it, vi } from 'vitest'
import { resourceScopes } from '../src/resources.js'

describe('native MCP resource scope', () => {
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
