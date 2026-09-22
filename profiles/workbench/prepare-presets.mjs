import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { officePreset } from './preset-policy.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const shipped = join(dirname(require.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'presets')
for (const name of readdirSync(shipped)) {
  const target = join(root, 'presets', name)
  cpSync(join(shipped, name), target, { recursive: true })
  const path = join(target, 'agent.cordis.yml')
  const source = readFileSync(path, 'utf8')
  writeFileSync(path, officePreset(source))
}
