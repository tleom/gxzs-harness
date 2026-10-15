import { expect, it } from 'vitest'
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
  expect(content[0].text).toContain('personal:mcp:records')
  expect(content[0].text).not.toContain('tool_299')
  const mentions = await service.mentionSnapshot(refs, snapshot)
  expect(mentions).toEqual([{ id: 'personal:mcp:records', kind: 'tools', name: '资料库' }])
  expect(runDto({ selection: { resource_mentions: refs, mentioned_resources: mentions }, mcpTools: snapshot }).mentioned_resources).toEqual(mentions)
})

it('keeps global and personal same-name plugins separate and deduplicates legacy tool refs', async () => {
  const service = new WorkbenchService({})
  service.listSkills = async () => []
  const tools = [...catalog, { ...catalog[0], id: 'global:mcp:records:tool_0', scope: 'global' }]
  const refs = normalizeResourceMentions({ plugins: ['personal:mcp:records', 'global:mcp:records'], tools: [catalog[0].id] })
  expect(await service.mentionSnapshot(refs, tools)).toHaveLength(2)
  const text = appendResourceInstructions([], refs, tools, [])[0].text
  expect(text.match(/personal:mcp:records/g)).toHaveLength(1)
  expect(text).toContain('global:mcp:records')
})

it('rejects stale and cross-scope plugin references before run admission', async () => {
  const service = new WorkbenchService({})
  service.mcpCatalog = async () => catalog
  await expect(service.freezeMcpTools({}, [], ['global:mcp:records'])).rejects.toMatchObject({ status: 409 })
  expect(() => normalizeResourceMentions({ plugins: ['x'.repeat(261)] })).toThrow('资源引用无效')
  expect(() => normalizeResourceMentions({ plugins: Array(101).fill('p') })).toThrow('资源引用无效')
})
