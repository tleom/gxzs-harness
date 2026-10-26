import { expect, it } from 'vitest'
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
