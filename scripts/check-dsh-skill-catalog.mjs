// Exercise the exact profile dependency tree used by the Host image.
import { Context } from '../profiles/workbench/node_modules/@deepseek-ai/cordis/lib/index.js'
import SkillRegistry from '../profiles/workbench/node_modules/@deepseek-ai/dsh-skill/lib/index.js'
import { readFile } from 'node:fs/promises'

const ctx = new Context()
const registry = new SkillRegistry(ctx)
const candidate = (name, order_num) => ({ name, description: name, order_num,
  invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'catalog-check', rank: 100 })
const dispose = registry.registerProvider(() => ({
  name: 'catalog-check',
  list: async () => [{
    name: 'case-evidence', description: 'Evidence', metadata: { 'display-name': '办案材料整理' },
    invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'catalog-check', rank: 100,
  }, candidate('m-tie', 10), candidate('a-tie', 10), candidate('z-first', -2147483648),
  candidate('z-end', 2147483647), candidate('a-invalid', 2147483648), candidate('shared', -2147483648)],
  get: async () => undefined,
}))
const preferred = { name: 'shared', description: 'Preferred native source', content: 'Native body',
  invocation: { modelInvocable: false, userInvocable: true }, source: 'custom', provider: 'preferred', rank: 1 }
const disposePreferred = registry.registerProvider(() => ({
  name: 'preferred', list: async () => [preferred], get: async () => preferred,
}))
try {
  const summaries = await registry.list()
  const summary = summaries.find(skill => skill.name === 'case-evidence')
  if (summary?.name !== 'case-evidence' || summary.displayName !== '办案材料整理')
    throw new Error('DSH skill summary omits the display name')
  if (summaries.map(skill => skill.name).join(',') !== 'z-first,a-tie,m-tie,z-end,a-invalid,case-evidence,shared')
    throw new Error('DSH native catalog ignores publication order, numeric ties, or native source precedence')
  if (summaries.find(skill => skill.name === 'a-invalid').order_num !== undefined)
    throw new Error('DSH native catalog accepts an order outside the database int range')
  const loaded = await registry.get('shared')
  if (loaded?.provider !== 'preferred' || loaded.content !== preferred.content || loaded.invocation.modelInvocable !== false)
    throw new Error('DSH publication order changes native source precedence or invocation policy')
  const catalog = await readFile(new URL('../profiles/workbench/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js', import.meta.url), 'utf8')
  if (!catalog.includes('entry.displayName') || !catalog.includes('escapeText(entry.displayName)'))
    throw new Error('DSH model-facing skill catalog omits the display name')
  if (!catalog.includes('displayName: typeof displayName === "string"')
    || !catalog.includes('JSON.stringify([entry.name, entry.displayName ?? entry.name, entry.description])'))
    throw new Error('DSH catalog history and digest disagree on display names')
} finally {
  disposePreferred()
  dispose()
  await ctx.fiber.dispose()
}
