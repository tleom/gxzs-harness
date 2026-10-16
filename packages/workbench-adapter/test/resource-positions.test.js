import { expect, it } from 'vitest'
import { positionResourceMentions, runResourceContext, resourceTextHash, goalMentionResources } from '../src/resource-mentions.js'

it('keeps goal display positions only for their captured objective and never mutates the durable snapshot', () => {
  const resources = [{ kind: 'skills', id: 'official-docx', name: '公文排版', offset: 2 }]
  const run = { selection: { mentioned_resources: resources, resource_position_hash: resourceTextHash('排版用这个') } }
  expect(goalMentionResources(run, '排版用这个')).toEqual(resources)
  expect(goalMentionResources(run, '重新整理报告')).toEqual([{ kind: 'skills', id: 'official-docx', name: '公文排版' }])
  expect(resources[0].offset).toBe(2)
  expect(goalMentionResources(undefined, '目标')).toEqual([])
})

it('retains inline order and offsets using only server-owned resource names and scope', () => {
  const resources = [{ kind: 'skills', id: 'legal', name: '法律研究' }, { kind: 'tools', id: 'global:mcp:law:lookup', name: '法律检索' }]
  const tools = [{ id: 'global:mcp:law:lookup', server_id: 'law', scope: 'global' }]
  const positions = [
    { kind: 'tools', id: 'plugin:mcp:global:mcp:law', offset: 3, name: '客户端名称' },
    { kind: 'skills', id: 'legal', offset: 8 },
    { kind: 'tools', id: 'personal:mcp:law', offset: 1 },
    { kind: 'skills', id: 'missing', offset: 0 },
    { kind: 'skills', id: 'legal', offset: -1 },
  ]
  expect(positionResourceMentions(resources, positions, 10, tools)).toEqual([
    { ...resources[1], offset: 3 }, { ...resources[0], offset: 8 },
  ])
  expect(positionResourceMentions(resources, [{ kind: 'skills', id: 'legal', offset: 99 }], 10, tools)).toEqual(resources)
  expect(positionResourceMentions(resources, undefined, 10, tools)).toBe(resources)
})

it('resolves any legacy child ID without crossing provider boundaries', () => {
  const tools = ['first', 'second', 'third'].map(name => ({ id: `personal:mcp:law:${name}`, server_id: 'law', scope: 'personal', provider_call_name: 'law' }))
  tools.push({ id: 'global:mcp:law:second', server_id: 'law', scope: 'global', provider_call_name: 'shared-law' })
  const resource = { kind: 'tools', id: 'law', name: '法律' }
  for (const id of [...tools.slice(0, 3).map(tool => tool.id), 'personal:mcp:law', 'law'])
    expect(positionResourceMentions([resource], [{ kind: 'tools', id, offset: 2 }], 4, tools)).toEqual([{ ...resource, offset: 2 }])
  expect(positionResourceMentions([resource], [{ kind: 'tools', id: tools[3].id, offset: 2 }], 4, tools)).toEqual([resource])
})

it('renders goal bindings from a durable snapshot only while they match the current native objective', () => {
  const objective = '请搜索视频', run = { query: objective,
    mcpTools: [{ id: 'personal:mcp:douyin:lookup', scope: 'personal', server_id: 'douyin', provider_call_name: 'douyin' }],
    selection: { command: 'goal', resource_context: 'selected plugin', resource_mentions: { plugins: ['douyin'] },
      resource_position_hash: resourceTextHash(objective), mentioned_resources: [{ kind: 'tools', id: 'douyin', offset: 1 }] } }
  expect(runResourceContext(JSON.parse(JSON.stringify(run)), objective)).toContain('请【插件：douyin】搜索视频')
  expect(runResourceContext(run, '其他目标')).toBe('selected plugin')
  expect(runResourceContext(run, undefined)).toBe('selected plugin')
  expect(run.query).toBe(objective)
})
