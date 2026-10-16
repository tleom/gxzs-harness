import { httpError } from './http.js'
import { createHash } from 'node:crypto'

export const resourceTextHash = text => createHash('sha256').update(text).digest('hex')

export function runResourceContext(run, objective) {
  const text = run?.selection?.resource_context
  if (run?.selection?.command !== 'goal' || typeof objective !== 'string'
    || run.selection.resource_position_hash !== resourceTextHash(objective)) return text
  const marked = appendResourceInstructions([{ type: 'text', text: objective }],
    normalizeResourceMentions(run.selection.resource_mentions), run.mcpTools ?? [], run.selection.mentioned_resources)[0].text
  return marked === objective ? text : [text, `当前目标的插件点名位置（用户目标原文保持不变）：\n${marked}`].filter(Boolean).join('\n')
}

export function registerRunResourceContext(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const agent = context.scope
    const run = ctx.workbenchRuntime.executionRun(agent?.session?.id ?? agent?.id)
    const root = run && ctx.agents?.get(run.sessionId)
    const text = runResourceContext(run, root && ctx.goals?.get(root)?.objective)
    return text ? { ...assembly, sections: [...assembly.sections,
      { name: 'gxzs:run-resources', text, interpolate: false }] } : assembly
  }, { global: true })
}

export function normalizeResourceMentions(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw httpError(400, '资源引用无效')
  const result = {}
  for (const kind of ['tools', 'plugins', 'skills', 'knowledge']) {
    const ids = value?.[kind] ?? []
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !id || id.length > 260))
      throw httpError(400, '资源引用无效')
    result[kind] = [...new Set(ids)]
  }
  if (result.knowledge.length) throw httpError(501, '知识库引用尚未接入此版本')
  return result
}

export function pluginId(tool) {
  return `${tool.scope ?? 'global'}:mcp:${tool.server_id}`
}

export function pluginName(tool) {
  return tool.provider_call_name ?? tool.server_id
}

/** Legacy scoped IDs resolve only inside the current authorized catalog. */
export function resolvePlugin(tools, reference) {
  const matches = new Map(tools.filter(tool => pluginId(tool) === reference || pluginName(tool) === reference)
    .map(tool => [pluginId(tool), tool]))
  if (matches.size !== 1) throw httpError(409, matches.size
    ? `插件调用名重复，请修正后重试：${reference}` : `引用的插件未启用或已不可用：${reference}`)
  const tool = matches.values().next().value
  const name = pluginName(tool)
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw httpError(409, `插件调用名格式无效，请修正后重试：${reference}`)
  if (tools.some(item => pluginName(item) === name && pluginId(item) !== pluginId(tool)))
    throw httpError(409, `插件调用名重复，请修正后重试：${name}`)
  return tool
}

/** Positions locate selected resources in plain text; identities and labels stay server-owned. */
export function positionResourceMentions(resources, positions, textLength, tools = []) {
  if (!Array.isArray(positions)) return resources
  const placed = [], seen = new Set()
  for (const position of positions.slice(0, 300)) {
    if (!position || !Number.isInteger(position.offset) || position.offset < 0 || position.offset > textLength || typeof position.id !== 'string') continue
    const id = position.id.replace(/^plugin:[^:]*:/u, '')
    // Resolve every legacy child ID to its provider, not just the first tool.
    const providers = new Set(tools.filter(tool => tool.id === id || pluginId(tool) === id || pluginName(tool) === id)
      .map(pluginId))
    const resource = resources.find(item => {
      if (item.kind !== position.kind) return false
      if (item.id === id) return true
      const tool = item.kind === 'tools' ? tools.find(tool => tool.id === item.id || pluginId(tool) === item.id || pluginName(tool) === item.id) : undefined
      return tool && providers.size === 1 && providers.has(pluginId(tool))
    })
    const key = resource && `${resource.kind}:${resource.id}`
    if (!resource || seen.has(key)) continue
    seen.add(key)
    placed.push({ ...resource, offset: position.offset })
  }
  return [...placed, ...resources.filter(item => !seen.has(`${item.kind}:${item.id}`))]
}

export function appendResourceInstructions(content, mentions, tools, positions = []) {
  const providers = new Map()
  for (const id of mentions.plugins ?? []) {
    const tool = resolvePlugin(tools, id)
    providers.set(pluginId(tool), {
      name: pluginName(tool), 'display-name': tool.provider_name ?? tool.server_id,
    })
  }
  for (const id of mentions.tools) {
    const tool = tools.find((item) => item.id === id)
    if (!tool) throw httpError(409, `引用的插件工具未启用或已不可用：${id}`)
    const provider = tool.server_id ? pluginId(tool) : tool.provider ?? tool.runtime_name
    if (tool.server_id) resolvePlugin(tools, provider)
    providers.set(provider, {
      name: tool.provider_call_name ?? tool.server_id ?? provider,
      'display-name': tool.provider_name ?? tool.server_id ?? provider,
    })
  }
  if (!providers.size) return content
  const result = [...content]
  const index = result.findIndex(part => part.type === 'text')
  if (index >= 0) {
    let text = result[index].text
    const resources = [...providers.values()].map(provider => ({ kind: 'tools', id: provider.name, name: provider['display-name'] }))
    const placed = positionResourceMentions(resources, positions, text.length, tools)
      .filter(item => item.offset !== undefined).sort((a, b) => a.offset - b.offset)
    // Insert backwards so offsets continue to refer to the original query.
    for (const item of placed.reverse()) text = `${text.slice(0, item.offset)}【插件：${item.id}】${text.slice(item.offset)}`
    result[index] = { ...result[index], text }
  }
  // This generated block shares a user message with real gestures. JSON's
  // equivalent Unicode escape preserves metadata without creating /skill tokens.
  const metadata = JSON.stringify([...providers.values()]).replaceAll('/', '\\u002f')
  return [...result, { type: 'text', text: `用户优先指定插件：${metadata}。正文中的【插件：name】标记对应其所在位置的任务。使用 mcp 的 name 查看插件，或用 tool_search 的 name 限定搜索；搜索未命中时查看完整目录。按返回的准确名称加载并调用工具。点名本身不执行操作；未要求仅用这些插件时，仍可使用其他合适能力。` }]
}
