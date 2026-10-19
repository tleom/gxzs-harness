import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { GlobalSkillProvider, orderGlobalSkills, publishedGlobalSkills } from '../src/global.js'

function fixture() {
  let rows = [{ id: 'z-last', order_num: 20 }, { id: 'a-first', order_num: 10 }]
  const platform = { json: vi.fn(async () => ({ data: { global_skills: rows } })) }
  const candidate = name => ({ name, locator: { directory: `/opt/workbench-global/skills/${name}` } })
  const native = { list: vi.fn(async () => [candidate('unpublished'), candidate('z-last'), candidate('a-first')]),
    get: vi.fn(async value => ({ name: value.name, content: 'Native body', resourceBase: { kind: 'directory', path: value.locator.directory } })),
    dispose: vi.fn() }
  const control = { invalidate: vi.fn() }
  return { platform, native, control, setRows(value) { rows = value },
    provider: new GlobalSkillProvider(native, platform, { ownerId: 'tenant:7' }, control) }
}

describe('published global skills', () => {
  it('retains native root precedence when two roots contain the same skill', async () => {
    const test = fixture()
    const first = { name: 'a-first', locator: { directory: '/first-root/a-first' } }
    test.native.list.mockResolvedValue([first, { name: 'a-first', locator: { directory: '/second-root/a-first' } }])
    expect((await test.provider.list()).candidates).toEqual([first])
  })

  it('loads the real native SKILL.md definition with its original resource directory', async () => {
    const parent = path.resolve(process.env.GXZS_TEST_TMP_ROOT ?? tmpdir())
    const root = await mkdtemp(path.join(parent, 'published-skills-'))
    const lifecycle = new AbortController()
    const control = { invalidate: vi.fn(), signal: lifecycle.signal }
    const native = new FileSystemSkillProvider({ get: () => undefined, logger: { warn: vi.fn() } }, control,
      { providerName: 'gxzs-filesystem', includeDefaultRoots: false, customSkillDirs: [root], watch: false })
    try {
      await mkdir(path.join(root, 'pdf', 'references'), { recursive: true })
      await writeFile(path.join(root, 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Native PDF skill\n---\nRead references/guide.txt')
      await writeFile(path.join(root, 'pdf', 'references', 'guide.txt'), 'Reference body')
      const platform = { json: async () => ({ data: { global_skills: [{ id: 'pdf', order_num: 10 }] } }) }
      const provider = new GlobalSkillProvider(native, platform, { ownerId: 'tenant:7' }, control)
      const candidate = (await provider.list()).candidates[0]
      expect(candidate.name).toBe('pdf')
      const definition = await provider.get(candidate)
      expect(definition.content).toContain('references/guide.txt')
      expect(definition.resourceBase).toEqual({ kind: 'directory', path: path.join(root, 'pdf') })
    } finally {
      lifecycle.abort()
      await native.dispose()
      if (path.dirname(root) !== parent) throw new Error('unexpected test directory')
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes only registered directories in numeric order and retains native resources', async () => {
    const { provider } = fixture()
    const { candidates } = await provider.list()
    expect(candidates.map(skill => skill.name)).toEqual(['a-first', 'z-last'])
    expect(await provider.get(candidates[0])).toMatchObject({ content: 'Native body',
      resourceBase: { path: '/opt/workbench-global/skills/a-first' } })
  })

  it('rechecks publication when loading an already advertised skill', async () => {
    const test = fixture()
    const candidate = (await test.provider.list()).candidates[0]
    test.setRows([])
    expect(await test.provider.get(candidate)).toBeUndefined()
    expect(test.native.get).not.toHaveBeenCalled()
    expect(test.control.invalidate).toHaveBeenCalledOnce()
  })

  it('requires the skill name to match its directory and rejects malformed database rows', async () => {
    const test = fixture()
    test.native.list.mockResolvedValue([{ name: 'a-first', locator: { directory: '/opt/workbench-global/skills/other' } }])
    expect((await test.provider.list()).candidates).toEqual([])
    for (const rows of [[{ id: '../other', order_num: 0 }], [{ id: 'demo', order_num: 0.5 }],
      [{ id: 'demo', order_num: 2147483648 }], [{ id: 'demo', order_num: 0 }, { id: 'demo', order_num: 1 }]]) {
      test.setRows(rows)
      await expect(publishedGlobalSkills(test.platform, { ownerId: 'tenant:7' })).rejects.toThrow('发布配置无效')
    }
  })

  it('uses stable identifiers to break numeric ties while preserving personal order', () => {
    const skills = [{ id: 'personal:z', scope: 'personal' }, { id: 'z-last', scope: 'global' },
      { id: 'a-first', scope: 'global' }, { id: 'personal:a', scope: 'personal' }]
    expect(orderGlobalSkills(skills, [{ id: 'z-last', order_num: 10 }, { id: 'a-first', order_num: 10 }])
      .map(skill => skill.id)).toEqual(['a-first', 'z-last', 'personal:z', 'personal:a'])
  })
})
