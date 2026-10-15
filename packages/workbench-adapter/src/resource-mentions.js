import { httpError } from './http.js'

export function registerRunResourceContext(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const agent = context.scope
    const run = ctx.workbenchRuntime.executionRun(agent?.session?.id ?? agent?.id)
    const text = run?.selection?.resource_context
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

export function appendResourceInstructions(content, mentions, tools) {
  const providers = new Map()
  for (const id of mentions.plugins ?? []) {
    const tool = tools.find(item => pluginId(item) === id)
    if (!tool) throw httpError(409, `引用的插件未启用或已不可用：${id}`)
    providers.set(pluginId(tool), {
      id: pluginId(tool), name: tool.provider_call_name ?? tool.server_id,
      displayName: tool.provider_name ?? tool.server_id,
    })
  }
  for (const id of mentions.tools) {
    const tool = tools.find((item) => item.id === id)
    if (!tool) throw httpError(409, `引用的插件工具未启用或已不可用：${id}`)
    const provider = tool.server_id ? pluginId(tool) : tool.provider ?? tool.runtime_name
    providers.set(provider, {
      id: provider,
      name: tool.provider_call_name ?? tool.server_id ?? provider,
      displayName: tool.provider_name ?? tool.server_id ?? provider,
    })
  }
  if (!providers.size) return content
  const hints = []
  // This generated block shares a user message with real gestures. JSON's
  // equivalent Unicode escape preserves metadata without creating /skill tokens.
  const metadata = JSON.stringify([...providers.values()]).replaceAll('/', '\\u002f')
  if (providers.size) hints.push(`用户优先指定插件：${metadata}。如提供 tool_search，先按插件 ID 搜索与任务相关的子工具，再调用返回的准确名称；否则从当前可用工具目录选择。若插件不适用，可以使用其他可用能力并说明原因。不要猜测工具名称。`)
  return [...content, { type: 'text', text: hints.join('\n') }]
}
