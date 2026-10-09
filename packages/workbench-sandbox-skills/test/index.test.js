import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it, vi } from 'vitest'
import { SandboxSkillProvider } from '../src/index.js'
import { readSkillDefinition } from '../src/definition.js'

const skill = (overrides = {}) => ({
  id: 'demo', version: 'v1', enabled: true,
  content: '---\nname: demo\ndescription: Demo skill\n---\nUse this skill.', ...overrides,
})
const control = () => ({ signal: new AbortController().signal, invalidate: vi.fn() })

describe('sandbox personal skill provider', () => {
  it('uses native frontmatter, invocation flags and an optional metadata display name', async () => {
    const definition = await readSkillDefinition('---\nname: report\ndescription: Reports\nmetadata:\n  displayName: 报告核验\ndisable-model-invocation: true\nuser-invocable: false\n---\nBody', { id: 'report' })
    expect(definition).toMatchObject({ name: 'report', displayName: '报告核验', metadata: { displayName: '报告核验' }, content: 'Body' })
    expect(definition.invocation).toMatchObject({ modelInvocable: false, userInvocable: false })
    const hyphenated = await readSkillDefinition('---\nname: report\ndescription: Reports\nmetadata:\n  display-name: 办案材料整理\n---\nBody', { id: 'report' })
    expect(hyphenated.displayName).toBe('办案材料整理')
    expect((await readSkillDefinition(skill().content)).displayName).toBe('demo')
    await expect(readSkillDefinition(skill().content, { id: 'other' })).rejects.toThrow('目录名')
  })
  it('advertises only valid enabled skills with remote resource paths', async () => {
    const manager = { personalResources: async () => ({ skills: [skill(), skill({ id: 'off', enabled: false }), skill({ id: 'bad' })] }) }
    const provider = new SandboxSkillProvider(manager, control())
    const observation = await provider.list()
    expect(observation.complete).toBe(true)
    expect(observation.candidates).toHaveLength(1)
    expect(observation.candidates[0]).toMatchObject({ name: 'demo', source: 'user-dsh', resourceBase: { path: '/workspace/skills/demo' } })
    expect((await provider.get(observation.candidates[0])).content).toContain('Use this skill.')
  })

  it('does not hide healthy providers when the personal manager is unavailable', async () => {
    const provider = new SandboxSkillProvider({ personalResources: async () => { throw new Error('manager unavailable') } }, control())
    expect(await provider.list()).toEqual({ candidates: [], complete: true })
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
    let current = skill({ content: '---\nname: demo\ndescription: Demo skill\nmetadata:\n  display-name: 办案材料整理\n---\nUse this skill.' })
    let lifecycle
    const dispose = registry.registerProvider((control) => {
      lifecycle = control
      return new SandboxSkillProvider({ personalResources: async () => ({ skills: [current] }) }, control)
    })
    try {
      expect((await registry.list())[0].name).toBe('demo')
      expect((await registry.get('demo')).content).toContain('Use this skill.')
      current = skill({ enabled: false })
      lifecycle.invalidate()
      expect(await registry.list()).toEqual([])
      expect(await registry.get('demo')).toBeUndefined()
    } finally { dispose() }
  })

  it('uses DSH custom-root precedence for an existing same-name personal skill', async () => {
    const ctx = new Context()
    const registry = new SkillRegistry(ctx)
    const global = { ...await readSkillDefinition(skill({ content: '---\nname: demo\ndescription: Global\n---\nGlobal body' }).content), provider: 'gxzs-filesystem', source: 'custom' }
    const disposeGlobal = registry.registerProvider(() => ({ name: 'gxzs-filesystem',
      list: async () => ({ candidates: [{ ...global, source: 'custom', rank: 300, locator: {} }], complete: true }),
      get: async () => global }))
    const disposePersonal = registry.registerProvider(control => new SandboxSkillProvider({ personalResources: async () => ({ skills: [skill()] }) }, control))
    try {
      expect((await registry.list())[0].provider).toBe('gxzs-filesystem')
      expect((await registry.get('demo')).content).toBe('Global body')
    } finally { disposePersonal(); disposeGlobal() }
  })
})
