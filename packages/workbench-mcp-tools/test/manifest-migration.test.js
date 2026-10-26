import { expect, it } from 'vitest'
import { WorkbenchService } from '../../workbench-adapter/src/service.js'
import { migrateEquivalentManifests } from '../src/manifest-migration.js'

function fixture() {
  const plugin = { id: 'global:mcp:demo', scope: 'global', version: '1', manifest_version: 'old',
    available: true, capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } }, protocol_version: '2025-11-25' }
  const tools = ['z', 'a'].map(name => ({ id: `global:mcp:demo:${name}`, scope: 'global', server_id: 'demo', version: '1',
    manifest_version: 'old', tool_name: name, runtime_name: `demo_${name}`, description: '查询',
    inputSchema: { type: 'object', properties: { name: { type: 'string', enum: ['a', 'b'] } } },
    outputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, execution: { taskSupport: 'optional' } }))
  const run = { id: 'run', status: 'running', mcpTools: tools, selection: { mcp_servers: [plugin] } }
  const current = structuredClone(tools).reverse().map(tool => ({ ...tool, manifest_version: 'new' }))
  const plugins = [{ ...structuredClone(plugin), manifest_version: 'new' }]
  return { run, current, plugins }
}

it('rebinds an identical complete global catalog across a hash/order upgrade without changing authority', () => {
  const { run, current, plugins } = fixture()
  const migrated = migrateEquivalentManifests(run, current, plugins)
  expect(migrated).not.toBe(run)
  expect(migrated.mcpTools.map(tool => tool.tool_name)).toEqual(['z', 'a'])
  expect(migrated.mcpTools.every(tool => tool.manifest_version === 'new')).toBe(true)
  expect(migrated.selection.mcp_servers[0].manifest_version).toBe('new')
  expect(run.mcpTools[0].manifest_version).toBe('old')
  expect(migrateEquivalentManifests(migrated, current, plugins)).toBe(migrated)
})

function personalFixture() {
  const { run, current, plugins } = fixture()
  for (const tool of [...run.mcpTools, ...current]) {
    tool.id = tool.id.replace('global:', 'personal:'); tool.scope = 'personal'
  }
  for (const plugin of [...run.selection.mcp_servers, ...plugins]) {
    plugin.id = plugin.id.replace('global:', 'personal:'); plugin.scope = 'personal'
  }
  const legacy = 'a'.repeat(64), runtime = 'b'.repeat(64)
  run.selection.mcp_servers[0].version = legacy
  for (const tool of run.mcpTools) tool.version = legacy
  plugins[0].version = runtime; plugins[0].legacy_version = legacy
  for (const tool of current) tool.version = runtime
  return { run, current, plugins, runtime }
}

it.each([fixture, personalFixture])('migrates definitions frozen by the actual admission path', async makeFixture => {
  const { run, current, plugins } = makeFixture()
  const admitted = await WorkbenchService.prototype.freezeMcpCatalog.call({
    refreshMcpCatalog: async () => ({ tools: run.mcpTools, plugins: run.selection.mcp_servers }),
  }, {}, [])
  run.mcpTools = admitted.tools
  const migrated = migrateEquivalentManifests(run, current, plugins)
  expect(migrated).not.toBe(run)
  expect(migrated.mcpTools.every(tool => tool.manifest_version === 'new')).toBe(true)
  expect(migrated.selection.mcp_servers[0].version).toBe(plugins[0].version)
  current[0].inputSchema.required = ['name']
  expect(migrateEquivalentManifests(run, current, plugins)).toBe(run)
})

it('migrates an unchanged personal configuration from its frozen file hash to the connection version', () => {
  const { run, current, plugins, runtime } = personalFixture()
  const migrated = migrateEquivalentManifests(run, current, plugins)
  expect(migrated).not.toBe(run)
  expect(migrated.mcpTools.every(tool => tool.version === runtime && tool.manifest_version === 'new')).toBe(true)
  expect(migrated.selection.mcp_servers[0]).toMatchObject({ version: runtime, manifest_version: 'new' })
  expect(run.mcpTools[0].version).toBe('a'.repeat(64))
})

it.each(['same-manifest', 'resources-only'])('preserves personal %s authorization during the version upgrade', mode => {
  const { run, current, plugins, runtime } = personalFixture()
  if (mode === 'same-manifest') {
    plugins[0].manifest_version = 'old'
    for (const tool of current) tool.manifest_version = 'old'
  } else {
    run.mcpTools = []; current.length = 0
    run.selection.mcp_servers[0].capabilities = { resources: {} }
    plugins[0].capabilities = { resources: {} }
  }
  const migrated = migrateEquivalentManifests(run, current, plugins)
  expect(migrated).not.toBe(run)
  expect(migrated.selection.mcp_servers[0].version).toBe(runtime)
  expect(migrated.mcpTools).toHaveLength(current.length)
})

it.each(['changed-file', 'missing-proof', 'tool-version', 'schema', 'capabilities', 'removed', 'fenced', 'stopped'])(
  'does not migrate a personal binding with %s', change => {
    const { run, current, plugins } = personalFixture()
    if (change === 'changed-file') plugins[0].legacy_version = 'c'.repeat(64)
    if (change === 'missing-proof') delete plugins[0].legacy_version
    if (change === 'tool-version') run.mcpTools[0].version = 'c'.repeat(64)
    if (change === 'schema') current[0].inputSchema.required = ['name']
    if (change === 'capabilities') plugins[0].capabilities.resources = {}
    if (change === 'removed') current.pop()
    if (change === 'fenced') run.stopConfirmation = { fenced: true }
    if (change === 'stopped') run.status = 'stopped'
    expect(migrateEquivalentManifests(run, current, plugins)).toBe(run)
  })

it.each(['input', 'output', 'annotations', 'execution', 'version', 'added', 'removed', 'capabilities', 'unavailable', 'incomplete', 'fenced', 'personal'])(
  'retains frozen authorization when %s differs', change => {
    const { run, current, plugins } = fixture()
    if (change === 'input') current[0].inputSchema.properties.name.enum.reverse()
    if (change === 'output') current[0].outputSchema.required = ['new']
    if (change === 'annotations') current[0].annotations.readOnlyHint = false
    if (change === 'execution') current[0].execution.taskSupport = 'required'
    if (change === 'version') current[0].version = '2'
    if (change === 'added') current.push({ ...current[0], id: 'extra', tool_name: 'extra' })
    if (change === 'removed') current.pop()
    if (change === 'capabilities') plugins[0].capabilities.resources = {}
    if (change === 'unavailable') plugins[0].available = false
    if (change === 'incomplete') run.selection.mcp_servers = []
    if (change === 'fenced') run.stopConfirmation = { fenced: true }
    if (change === 'personal') run.selection.mcp_servers[0].scope = 'personal'
    expect(migrateEquivalentManifests(run, current, plugins)).toBe(run)
  })
