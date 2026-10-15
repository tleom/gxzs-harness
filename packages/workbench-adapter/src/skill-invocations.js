import { httpError } from './http.js'

// This matches DSH's user gesture boundary; skill names come from its registry.
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

export function skillGestureNames(content) {
  return new Set(content.filter(block => block.type === 'text')
    .flatMap(block => [...block.text.matchAll(SKILL_GESTURE)].map(match => match[2])))
}

/** Durable identity only. DSH remains the sole owner of skill body loading. */
export function skillInvocationClaims(skills) {
  return skills.map(({ name, provider, source, path }) => ({ name, provider,
    ...(source !== undefined ? { source } : {}), ...(path !== undefined ? { path } : {}) }))
}

export function assertSkillInvocationClaims(skills, claims) {
  const current = skillInvocationClaims(skills)
  for (const claim of claims) {
    const skill = current.find(item => item.name === claim.name)
    if (!skill || Object.keys(claim).some(key => skill[key] !== claim[key]))
      throw httpError(409, `所选技能来源已改变，请重新选择后再发送：${claim.name}`, 'SKILL_SELECTION_CHANGED')
  }
}

/** Resolve human-selected skills in the exact Agent's native skill view. */
export async function resolveSkillInvocations(registry, ids, { agent, cwd, signal } = {}) {
  if (!ids.length) return []
  if (!agent) throw httpError(409, '会话暂时无法恢复，请稍后重试')
  signal?.throwIfAborted()
  const skills = await registry.list({ scope: agent, cwd, signal })
  signal?.throwIfAborted()
  const selected = new Map()
  for (const id of ids) {
    const personal = id.startsWith('personal:')
    const name = personal ? id.slice('personal:'.length) : id
    const skill = skills.find(item => item.name === name && item.enabled !== false
      && (!personal || item.provider === 'gxzs-sandbox-personal'))
    if (!skill) throw httpError(409, `引用的技能未启用或当前会话不可用：${id}`)
    if (skill.invocation?.userInvocable !== true)
      throw httpError(409, `技能不允许用户调用：${skill.name}`)
    selected.set(skill.name, skill)
  }
  return [...selected.values()]
}

/** Append native gestures to a human message without changing its display query. */
export function appendSkillInvocations(content, skills) {
  const existing = skillGestureNames(content)
  const missing = [...new Set(skills.map(skill => skill.name))].filter(name => !existing.has(name))
  return missing.length ? [...content, { type: 'text', text: missing.map(name => `/${name}`).join('\n') }] : content
}
