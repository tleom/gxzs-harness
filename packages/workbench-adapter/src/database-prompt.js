const preferenceContext = 'gxzs:user-preferences'
const responseStyles = {
  default: '',
  professional: '专业可靠的回答，请措辞准确、结构清楚，并明确区分事实、判断与不确定信息',
  enthusiastic: '热情积极的回答，请使用积极、有活力的语气，给出具体鼓励和可推进的方向',
  concise: '简洁务实的回答，请直接给出结论与重点，明确可执行的步骤，减少重复说明',
  humorous: '轻松幽默的回答，请在适合的场合使用自然、得体的幽默，保持内容清晰并贴合话题',
  patient: '耐心细致的回答，请循序渐进地解释复杂内容，必要时提供步骤、例子和术语说明',
}

/** Render user-owned preferences literally; an old backend contributes no preferences. */
export function renderUserPreferences(preferences) {
  if (preferences === undefined) return ''
  if (!preferences || typeof preferences !== 'object') throw new Error('个性化配置无效')
  const fields = { preferredName: 100, identity: 200, customInstructions: 6000 }
  const content = {}
  for (const [key, limit] of Object.entries(fields)) {
    const value = preferences[key]
    if (typeof value !== 'string'
      || (key === 'customInstructions' ? [...value].length : value.length) > limit) throw new Error('个性化内容无效')
    content[key] = value.trim()
  }
  if (!Object.hasOwn(responseStyles, preferences.responseStyle)) throw new Error('个性化回答偏好无效')
  const lines = []
  if (content.preferredName) lines.push(`称呼偏好：在合适的场合，请称呼用户为「${content.preferredName}」。`)
  if (content.identity) lines.push(`身份或背景：用户自述为「${content.identity}」。请在与当前问题相关时，据此调整解释深度和举例方式。`)
  const style = responseStyles[preferences.responseStyle]
  if (style) lines.push(`回答偏好：用户偏好${style}。`)
  if (content.customInstructions) {
    const instructions = content.customInstructions.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')
    lines.push('自定义指令：以下是用户补充的长期要求。请将其作为理解用户偏好、组织回答和处理任务的参考，结合当前任务合理遵循：\n' + instructions)
  }
  return lines.length ? '用户个人偏好：适用于此用户的任务，本次明确要求优先；平台规则和工具权限仍按平台执行。\n'
    + lines.join('\n') : ''
}

/** Append platform instructions and register owner preferences as native user context. */
export function registerDatabasePrompt(ctx, ownerId) {
  const snapshots = new WeakMap()
  let unscoped = ''
  ctx.systemPrompt.context({
    name: preferenceContext, order: 50, required: true, interpolate: false,
    text: context => context.scope ? snapshots.get(context.scope) ?? '' : unscoped,
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    // Fetch per assembly: the first turn and subsequent turns see the published
    // value, including disabling it. Failure must not silently drop instructions.
    const payload = await ctx.workbenchPlatformClient.json({
      owner: { ownerId }, method: 'GET', route: 'workbench/config',
      signal: context.signal, timeoutMs: 5000,
    })
    const config = payload?.data
    if (!config || typeof config.enabled !== 'boolean')
      throw new Error('平台提示词配置无效')
    if (config.enabled && typeof config.system_prompt !== 'string')
      throw new Error('平台提示词必须是文本')
    const text = renderUserPreferences(config.user_preferences)
    const previous = context.scope ? snapshots.get(context.scope) : unscoped
    if (context.scope) snapshots.set(context.scope, text)
    else unscoped = text
    const sections = config.enabled && config.system_prompt.trim() ? [...assembly.sections, {
      name: 'gxzs:database-prompt', text: config.system_prompt, interpolate: false,
    }] : assembly.sections
    const contexts = text || previous ? [...assembly.contexts.filter(item => item.name !== preferenceContext),
      { name: preferenceContext, text, interpolate: false }] : assembly.contexts
    if (sections === assembly.sections && contexts === assembly.contexts) return assembly
    return {
      ...assembly, sections, contexts,
    }
    // Required user context survives complete prompts and optional-context suppression.
  }, { global: true })
}
