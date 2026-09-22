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
  const resources = []
  const gestures = []
  for (const id of mentions.tools) {
    const tool = tools.find((item) => item.id === id)
    if (!tool) throw httpError(409, `引用的插件工具未启用或已不可用：${id}`)
    // DSH has no MCP slash gesture. Keep this boundary as a user reference
    // to registered public tool names; descriptions belong to tool definitions.
    resources.push(tool.runtime_name)
  }
  for (const id of mentions.skills) {
    const skill = skills.find((item) => item.enabled !== false && (item.id === id || item.name === id || `personal:${item.name}` === id))
    if (!skill) throw httpError(409, `引用的技能已不可用：${id}`)
    if (skill.invocation?.userInvocable === false) throw httpError(409, `技能不允许用户调用：${skill.name}`)
    // DSH's tool-skill pre-step owns loading, instructions and invocation policy.
    gestures.push(`/${skill.name}`)
  }
  const invocation = gestures.length ? [{ type: 'text', text: gestures.join(' ') }] : []
  if (!resources.length) return [...content, ...invocation]
  return [...content, { type: 'text', text: [
    '用户选择的 MCP 工具：',
    JSON.stringify(resources),
  ].join('\n') }, ...invocation]
}
