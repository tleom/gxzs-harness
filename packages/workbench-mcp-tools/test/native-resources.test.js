import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resourceScopes } from '../src/resources.js'

const nativeRequire = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = async name => import(pathToFileURL(nativeRequire.resolve(`@deepseek-ai/${name}`)).href)

it('exposes a resource-only provider through DSH native tools in exactly its owning agent scope', async () => {
  const [{ Context }, { default: Tools }, { default: Resources }, { default: Prompt }, { createScope }] = await Promise.all([
    native('cordis'), native('dsh-tools'), native('dsh-mcp-resources'), native('dsh-system-prompt'), native('dsh-scope'),
  ])
  const ctx = new Context()
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools, { mode: 'native' })
    await ctx.plugin(Resources)
    const agent = { id: 'agent-a', session: { id: 'session-a' } }, other = { id: 'agent-b' }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    const server = { id: 'global:mcp:records', name: 'records', scope: 'global', version: '1', manifest_version: 'm', capabilities: { resources: {} }, instructions: 'literal {{fixture}} instructions' }
    const personal = { ...server, id: 'personal:mcp:records', scope: 'personal', instructions: 'personal instructions' }
    const toolOnly = { ...server, id: 'global:mcp:tool-only', capabilities: { tools: {} }, instructions: 'tool-only instructions' }
    const servers = [server, personal, toolOnly]
    const run = { id: 'run', ownerId: 'owner', status: 'running', selection: { mcp_servers: servers } }
    const platform = { json: vi.fn(async () => ({ data: { contents: [{ uri: 'fixture://case', text: 'case data' }] } })) }
    const scopes = resourceScopes({ workbenchPlatformClient: platform, workbenchRuntime: {
      ownerId: 'owner', mcpCatalogState: { ready: true }, executionRun: () => run,
      authorizeMcpCall: async (_session, id) => ({ ownerId: 'owner', runId: 'run', resource: servers.find(item => item.id === id) }),
    } })
    scopes.sync(agent, servers)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toContain('read_mcp_resource')
    expect(ctx.tools.schemas(other).map(tool => tool.name)).not.toContain('read_mcp_resource')
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(assembly.sections.find(section => section.name === `mcp:${server.id}`).text).toContain('literal {{fixture}} instructions')
    expect(assembly.sections.find(section => section.name === `mcp:${toolOnly.id}`).text).toContain('tool-only instructions')
    expect((await ctx.systemPrompt.assemble({ scope: other })).sections.some(section => section.name === `mcp:${server.id}`)).toBe(false)
    const result = await ctx.tools.execute({ name: 'read_mcp_resource', arguments: { server: server.id, uri: 'fixture://case' },
      agent, callId: 'native-resource', signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result)).toContain('case data')
    expect((await ctx.tools.execute({ name: 'read_mcp_resource', arguments: { server: personal.id, uri: 'fixture://case' },
      agent, callId: 'personal-resource', signal: new AbortController().signal })).isError).toBe(false)
    run.stopConfirmation = { fenced: true }
    scopes.sync(agent, servers)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('read_mcp_resource')
    expect((await ctx.systemPrompt.assemble({ scope: agent })).sections.some(section => section.name === `mcp:${toolOnly.id}`)).toBe(false)
    scopes.clear()
    scope.rawDispose()
  } finally { await ctx.fiber.dispose() }
})
