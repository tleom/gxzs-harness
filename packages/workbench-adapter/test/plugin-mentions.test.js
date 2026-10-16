import { expect, it, vi } from 'vitest'
import { appendResourceInstructions, normalizeResourceMentions } from '../src/resource-mentions.js'
import { WorkbenchService, runDto } from '../src/service.js'

const catalog = Array.from({ length: 300 }, (_, i) => ({ id: `personal:mcp:records:tool_${i}`,
  scope: 'personal', server_id: 'records', provider_name: '资料库', provider_call_name: 'records', tool_name: `tool_${i}` }))

it('accepts one compact plugin reference for 300 tools and keeps the full authorization snapshot', async () => {
  const service = new WorkbenchService({})
  service.mcpCatalog = async () => catalog
  service.listSkills = async () => []
  const refs = normalizeResourceMentions({ plugins: ['personal:mcp:records', 'personal:mcp:records'] })
  expect(refs.plugins).toEqual(['personal:mcp:records'])
  const snapshot = await service.freezeMcpTools({}, refs.tools, refs.plugins)
  expect(snapshot).toHaveLength(300)
  const content = appendResourceInstructions([], refs, snapshot, [])
  expect(content[0].text).toContain('"name":"records"')
  expect(content[0].text).not.toContain('personal:mcp:records')
  expect(content[0].text).not.toContain('tool_299')
  const mentions = await service.mentionSnapshot(refs, snapshot)
  expect(mentions).toEqual([{ id: 'records', kind: 'tools', name: '资料库' }])
  expect(runDto({ selection: { resource_mentions: refs, mentioned_resources: mentions }, mcpTools: snapshot }).mentioned_resources).toEqual(mentions)
})

it('resolves legacy identities and deduplicates selected child tools without exposing scope', async () => {
  const service = new WorkbenchService({})
  service.listSkills = async () => []
  const tools = [...catalog, { ...catalog[0], id: 'global:mcp:records:tool_0', scope: 'global', provider_call_name: 'shared-records' }]
  const refs = normalizeResourceMentions({ plugins: ['personal:mcp:records', 'global:mcp:records'], tools: [catalog[0].id] })
  expect(await service.mentionSnapshot(refs, tools)).toHaveLength(2)
  const text = appendResourceInstructions([], refs, tools, [])[0].text
  expect(text.match(/"name":"records"/g)).toHaveLength(1)
  expect(text).toContain('"name":"shared-records"')
  expect(text).not.toContain(':mcp:')
})

it('rejects stale and cross-scope plugin references before run admission', async () => {
  const service = new WorkbenchService({})
  service.mcpCatalog = async () => catalog
  await expect(service.freezeMcpTools({}, [], ['global:mcp:records'])).rejects.toMatchObject({ status: 409 })
  expect(() => normalizeResourceMentions({ plugins: ['x'.repeat(261)] })).toThrow('资源引用无效')
  expect(() => normalizeResourceMentions({ plugins: Array(101).fill('p') })).toThrow('资源引用无效')
})

it('resolves names and retains task-to-plugin binding at each inline position', async () => {
  const tools = [...catalog, { ...catalog[0], id: 'global:mcp:memory:save', scope: 'global', server_id: 'memory', provider_call_name: 'memory', provider_name: '全局记忆' }]
  const service = new WorkbenchService({})
  service.mcpCatalog = async () => tools
  service.listSkills = async () => []
  const mentions = normalizeResourceMentions({ plugins: ['records', 'memory'] })
  const text = '用查资料，再用保存结论'
  const positions = [{ kind: 'tools', id: 'plugin:mcp:personal:mcp:records', offset: 1 },
    { kind: 'tools', id: 'memory', offset: 7 }, { kind: 'tools', id: 'not-selected', offset: 0 }]
  await expect(service.freezeMcpTools({}, [], mentions.plugins)).resolves.toEqual(tools)
  const content = await service.resourceContent([{ type: 'text', text }], mentions, tools, undefined, [], positions)
  expect(content[0].text).toBe('用【插件：records】查资料，再用【插件：memory】保存结论')
  expect(content[1].text).not.toContain(':mcp:')
  expect(await service.mentionSnapshot(mentions, tools, undefined, positions, text)).toEqual([
    { kind: 'tools', id: 'records', name: '资料库', offset: 1 },
    { kind: 'tools', id: 'memory', name: '全局记忆', offset: 7 },
  ])
})

it('rejects ambiguous canonical names even when a legacy ID identifies one provider', async () => {
  const service = new WorkbenchService({})
  service.mcpCatalog = async () => [...catalog, { ...catalog[0], id: 'global:mcp:records:t', scope: 'global' }]
  await expect(service.freezeMcpTools({}, [], ['records'])).rejects.toThrow('调用名重复')
  await expect(service.freezeMcpTools({}, [], ['personal:mcp:records'])).rejects.toThrow('调用名重复')
})

it('checks create, rename and enable against the owner inventory before a manager write', async () => {
  const personalMcp = vi.fn(async () => ({ saved: true }))
  const json = vi.fn(async () => ({ plugins: [{ id: 'global:mcp:memory', name: 'memory' }, { id: 'personal:mcp:existing', name: 'existing' }] }))
  const service = new WorkbenchService({ fileManager: { personalMcp }, platformClient: { json } })
  for (const body of [{ operation: 'mcp_save', name: 'memory' }, { operation: 'mcp_save', name: 'existing', new_name: 'memory' },
    { operation: 'mcp_toggle', name: 'memory', enabled: true }])
    await expect(service.mutateResource(body, { ownerId: 'owner' })).rejects.toThrow('调用名已存在')
  for (const name of ['9bad', 'Upper', 'bad.name', 'x'.repeat(65)])
    await expect(service.mutateResource({ operation: 'mcp_save', name }, { ownerId: 'owner' })).rejects.toThrow('以小写字母开头')
  expect(personalMcp).not.toHaveBeenCalled()
  await service.mutateResource({ operation: 'mcp_save', name: 'new_name' }, { ownerId: 'owner' })
  await service.mutateResource({ operation: 'mcp_save', name: 'existing' }, { ownerId: 'owner' })
  expect(personalMcp).toHaveBeenCalledTimes(2)
  expect(json).toHaveBeenCalledWith({ owner: { ownerId: 'owner' }, method: 'GET', route: 'mcp/plugins' })
})
