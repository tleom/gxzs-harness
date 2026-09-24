import { httpError } from './http.js'

export function normalizeResourceMentions(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw httpError(400, '资源引用无效')
  const result = {}
  for (const kind of ['tools', 'skills', 'knowledge']) {
    const ids = value?.[kind] ?? []
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !id || id.length > 260))
      throw httpError(400, '资源引用无效')
    result[kind] = [...new Set(ids)]
  }
  if (result.knowledge.length) throw httpError(501, '知识库引用尚未接入此版本')
  return result
}

export function appendResourceInstructions(content, mentions, tools, skills) {
  const providers = new Map()
  const preferredSkills = []
  for (const id of mentions.tools) {
    const tool = tools.find((item) => item.id === id)
    if (!tool) throw httpError(409, `引用的插件工具未启用或已不可用：${id}`)
    const provider = tool.provider && tool.provider !== 'mcp' ? tool.provider
      : tool.server_id ? `${tool.scope ?? 'global'}:${tool.server_id}` : tool.runtime_name
    providers.set(provider, tool.provider_name ?? tool.server_id ?? provider)
  }
  for (const id of mentions.skills) {
    const skill = skills.find((item) => item.enabled !== false && (item.id === id || item.name === id || `personal:${item.name}` === id))
    if (!skill) throw httpError(409, `引用的技能已不可用：${id}`)
    if (skill.invocation?.modelInvocable === false) throw httpError(409, `技能不允许 AI 调用：${skill.name}`)
    preferredSkills.push(skill.name)
  }
  if (!providers.size && !preferredSkills.length) return content
  const hints = []
  if (providers.size) hints.push(`用户指定插件：${JSON.stringify([...providers.values()])}。请先从当前实际可用的工具目录中选择该插件下合适的子工具调用；若不适用，再说明原因。不要猜测工具名称。`)
  if (preferredSkills.length) hints.push(`用户指定技能：${JSON.stringify(preferredSkills)}。请先按当前实际可用的技能目录中的准确名称调用；若不适用，再说明原因。不要猜测技能名称。`)
  return [...content, { type: 'text', text: hints.join('\n') }]
}
