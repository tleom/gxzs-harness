import { describe, expect, it, vi } from 'vitest'
import { registerDatabasePrompt } from '../src/database-prompt.js'

function setup() {
  const ctx = { on: vi.fn(), workbenchPlatformClient: { json: vi.fn() } }
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
