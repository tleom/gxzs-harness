import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it, vi } from 'vitest'
import { SandboxSkillProvider } from '../src/index.js'

const skill = (overrides = {}) => ({
  id: 'demo', version: 'v1', enabled: true,
  content: '---\nname: demo\ndescription: Demo skill\n---\nUse this skill.', ...overrides,
})
const control = () => ({ signal: new AbortController().signal, invalidate: vi.fn() })

describe('sandbox personal skill provider', () => {
  it('advertises only valid enabled skills with remote resource paths', async () => {
    const manager = { personalResources: async () => ({ skills: [skill(), skill({ id: 'off', enabled: false }), skill({ id: 'bad' })] }) }
    const provider = new SandboxSkillProvider(manager, control())
    const observation = await provider.list()
    expect(observation.complete).toBe(false)
    expect(observation.candidates).toHaveLength(1)
    expect(observation.candidates[0]).toMatchObject({ name: 'demo', source: 'user-dsh', resourceBase: { path: '/workspace/skills/demo' } })
    expect((await provider.get(observation.candidates[0])).content).toContain('Use this skill.')
  })

  it('rejects stale or disabled skills at load time and invalidates the registry', async () => {
    let current = skill()
    const lifecycle = control()
    const provider = new SandboxSkillProvider({ personalResources: async () => ({ skills: [current] }) }, lifecycle)
    const candidate = (await provider.list()).candidates[0]
    current = skill({ version: 'v2' })
    expect(await provider.get(candidate)).toBeUndefined()
    current = skill({ enabled: false })
    expect(await provider.get(candidate)).toBeUndefined()
    expect(lifecycle.invalidate).toHaveBeenCalledTimes(2)
  })

  it('integrates with the actual DSH skill registry', async () => {
    const ctx = new Context()
    const registry = new SkillRegistry(ctx)
    let current = skill()
    const dispose = registry.registerProvider((lifecycle) => new SandboxSkillProvider({ personalResources: async () => ({ skills: [current] }) }, lifecycle))
    try {
      expect((await registry.list())[0].name).toBe('demo')
      expect((await registry.get('demo')).content).toContain('Use this skill.')
      current = skill({ enabled: false })
      expect(await registry.list()).toEqual([])
      expect(await registry.get('demo')).toBeUndefined()
    } finally { dispose() }
  })
})
