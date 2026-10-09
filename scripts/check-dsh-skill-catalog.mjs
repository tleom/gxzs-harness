// Exercise the exact profile dependency tree used by the Host image.
import { Context } from '../profiles/workbench/node_modules/@deepseek-ai/cordis/lib/index.js'
import SkillRegistry from '../profiles/workbench/node_modules/@deepseek-ai/dsh-skill/lib/index.js'
import { readFile } from 'node:fs/promises'

const registry = new SkillRegistry(new Context())
const dispose = registry.registerProvider(() => ({
  name: 'catalog-check',
  list: async () => [{
    name: 'case-evidence', description: 'Evidence', metadata: { 'display-name': '办案材料整理' },
    invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'catalog-check', rank: 100,
  }],
  get: async () => undefined,
}))
try {
  const [summary] = await registry.list()
  if (summary?.name !== 'case-evidence' || summary.displayName !== '办案材料整理')
    throw new Error('DSH skill summary omits the display name')
  const catalog = await readFile(new URL('../profiles/workbench/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js', import.meta.url), 'utf8')
  if (!catalog.includes('entry.displayName') || !catalog.includes('escapeText(entry.displayName)'))
    throw new Error('DSH model-facing skill catalog omits the display name')
} finally {
  dispose()
}
