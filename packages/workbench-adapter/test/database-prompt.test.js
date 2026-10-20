import { describe, expect, it, vi } from 'vitest'
import { registerDatabasePrompt, renderUserPreferences } from '../src/database-prompt.js'

function setup() {
  const ctx = { on: vi.fn(), systemPrompt: { context: vi.fn() }, workbenchPlatformClient: { json: vi.fn() } }
  registerDatabasePrompt(ctx, 'tenant:user')
  const assemble = ctx.on.mock.calls[0][1]
  const original = { sections: [{ name: 'deployment:persona-prefix', text: 'native' }], contexts: [], tools: [], variables: {} }
  const run = () => assemble(original, {}, async () => original)
  return { ctx, original, run }
}

describe('database prompt injection', () => {
  it('preserves DSH assembly and appends literal database content exactly once', async () => {
    const { ctx, original, run } = setup()
    ctx.workbenchPlatformClient.json.mockResolvedValue({ data: { enabled: true, system_prompt: '规则 {{literal}}' } })
    const result = await run()
    expect(result.sections).toEqual([...original.sections, { name: 'gxzs:database-prompt', text: '规则 {{literal}}', interpolate: false }])
    expect(original.sections).toHaveLength(1)
    expect(result.tools).toBe(original.tools)
    expect(result.contexts).toBe(original.contexts)
    expect(ctx.workbenchPlatformClient.json).toHaveBeenCalledWith(expect.objectContaining({ owner: { ownerId: 'tenant:user' }, timeoutMs: 5000 }))
  })

  it('observes publication changes and disabling without retaining an old prompt', async () => {
    const { ctx, original, run } = setup()
    ctx.workbenchPlatformClient.json
      .mockResolvedValueOnce({ data: { enabled: true, system_prompt: 'A' } })
      .mockResolvedValueOnce({ data: { enabled: true, system_prompt: 'B' } })
      .mockResolvedValueOnce({ data: { enabled: false } })
      .mockResolvedValueOnce({ data: { enabled: true, system_prompt: ' ' } })
    expect((await run()).sections.at(-1).text).toBe('A')
    expect((await run()).sections.at(-1).text).toBe('B')
    expect(await run()).toBe(original)
    expect(await run()).toBe(original)
  })

  it('reports fetch and configuration failures instead of silently omitting instructions', async () => {
    const { ctx, run } = setup()
    ctx.workbenchPlatformClient.json.mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ data: { enabled: true, system_prompt: 42 } })
    await expect(run()).rejects.toThrow('unavailable')
    await expect(run()).rejects.toThrow('配置无效')
    await expect(run()).rejects.toThrow('必须是文本')
  })
})

const preferences = { version: 1, preferredName: '李律师',
  identity: '执行案件代理人', responseStyle: 'professional', customInstructions: '先给结论 {{literal}}' }
const emptyPreferences = { version: 0, preferredName: '', identity: '', responseStyle: 'default', customInstructions: '' }

it('keeps personal instructions at user level, reloads changes and clears empty preferences', async () => {
  const { ctx, run } = setup()
  ctx.workbenchPlatformClient.json
    .mockResolvedValueOnce({ data: { enabled: false, user_preferences: preferences } })
    .mockResolvedValueOnce({ data: { enabled: false, user_preferences: { ...preferences, preferredName: '李老师' } } })
    .mockResolvedValueOnce({ data: { enabled: false, user_preferences: emptyPreferences } })
  expect(ctx.systemPrompt.context).toHaveBeenCalledWith(expect.objectContaining({ required: true, interpolate: false }))
  const first = await run()
  expect(first.sections).toHaveLength(1)
  expect(first.contexts[0]).toMatchObject({ name: 'gxzs:user-preferences', interpolate: false })
  expect(first.contexts[0].text).toContain('李律师')
  expect(first.contexts[0].text).toContain('{{literal}}')
  expect((await run()).contexts[0].text).toContain('李老师')
  expect((await run()).contexts[0].text).toBe('')
})

it('rejects malformed preferences and contributes nothing for empty or older configurations', () => {
  expect(renderUserPreferences(undefined)).toBe('')
  expect(renderUserPreferences(emptyPreferences)).toBe('')
  expect(renderUserPreferences({ ...emptyPreferences, preferredName: ' ', identity: '\n', customInstructions: '\t' })).toBe('')
  expect(() => renderUserPreferences({ ...preferences, customInstructions: 'x'.repeat(6001) })).toThrow('内容无效')
  expect(() => renderUserPreferences({ ...preferences, responseStyle: 'unknown' })).toThrow('回答偏好无效')
})

it('builds natural instructions from filled fields and frames multiline custom requirements', () => {
  expect(renderUserPreferences({ ...preferences, customInstructions: '先给结论\r\n多使用实例 {{literal}}' })).toBe(
    '用户个人偏好：适用于此用户的任务，本次明确要求优先；平台规则和工具权限仍按平台执行。\n'
    + '称呼偏好：在合适的场合，请称呼用户为「李律师」。\n'
    + '身份或背景：用户自述为「执行案件代理人」。请在与当前问题相关时，据此调整解释深度和举例方式。\n'
    + '回答偏好：用户偏好专业可靠的回答，请措辞准确、结构清楚，并明确区分事实、判断与不确定信息。\n'
    + '自定义指令：以下是用户补充的长期要求。请将其作为理解用户偏好、组织回答和处理任务的参考，结合当前任务合理遵循：\n'
    + '> 先给结论\n> 多使用实例 {{literal}}')
  const addressOnly = renderUserPreferences({ ...emptyPreferences, preferredName: '李老师' })
  expect(addressOnly).toContain('请称呼用户为「李老师」')
  expect(addressOnly).not.toContain('回答偏好：')
})

it('counts the custom instruction limit in Unicode code points', () => {
  for (const customInstructions of ['汉'.repeat(5999) + '😀', '😀'.repeat(6000)]) {
    expect(renderUserPreferences({ ...emptyPreferences, customInstructions })).toContain(customInstructions)
  }
  expect(() => renderUserPreferences({ ...emptyPreferences, customInstructions: '😀'.repeat(6001) })).toThrow('内容无效')
})

it.each(['professional', 'enthusiastic', 'concise', 'humorous', 'patient'])(
  'applies the %s answer preference even when all text fields are empty', responseStyle => {
    const text = renderUserPreferences({ ...emptyPreferences, responseStyle })
    expect(text).toContain('回答偏好：用户偏好')
    expect(text).not.toContain('称呼偏好：')
    expect(text).not.toContain('自定义指令：')
  })

it.each([['imaginative', '天马行空'], ['sharp', '毒舌犀利']])(
  'renders the %s preference in the user context', (responseStyle, label) => {
    const text = renderUserPreferences({ ...emptyPreferences, responseStyle })
    expect(text).toContain(`回答偏好：用户偏好${label}的回答`)
    expect(text).not.toContain('称呼偏好：')
    expect(text).not.toContain('自定义指令：')
  })
