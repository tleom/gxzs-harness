import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { officePreset } from './preset-policy.mjs'
import { prepareWorkspaceChanges } from '../../scripts/prepare-workspace-changes.mjs'
import { prepareSessionClient } from '../../scripts/prepare-session-client.mjs'
import { prepareSubagentPrompt } from '../../scripts/prepare-subagent-prompt.mjs'
import { prepareSessionReferences } from '../../scripts/prepare-session-references.mjs'
import { prepareWorkbenchClient } from '../../scripts/prepare-workbench-client.mjs'
import { prepareDshStreamArguments } from '../../scripts/prepare-dsh-stream-arguments.mjs'
import { prepareDshAgentInbox } from '../../scripts/prepare-dsh-agent-inbox.mjs'

const root = dirname(fileURLToPath(import.meta.url))
await prepareWorkspaceChanges(root)
await prepareSessionClient(root)
await prepareSubagentPrompt(root)
await prepareSessionReferences(root)
await prepareWorkbenchClient(root)
await prepareDshStreamArguments(root)
await prepareDshAgentInbox(root)
const require = createRequire(import.meta.url)
const shipped = join(dirname(require.resolve('@deepseek-ai/dsh-web-app/package.json')), 'presets')
const patches = [readFileSync(join(root, 'cordis.patch.yml'), 'utf8')]
for (const name of readdirSync(shipped).filter(name => name.endsWith('.patch.yml')).sort()) {
  const source = readFileSync(join(shipped, name), 'utf8')
  // Override the native preset row while retaining its complete upstream composition.
  const override = source.slice(source.indexOf('    - id: preset-'))
    .replace(/^    /gm, '').replace(/^  name:.*\n/m, '')
  if (!override.startsWith('- id: preset-')) throw new Error(`Invalid native preset: ${name}`)
  patches.push(officePreset(override))
}
writeFileSync(join(root, 'cordis.runtime.patch.yml'), patches.join('\n'))
copyFileSync(join(root, 'cordis.runtime.patch.yml'),
  join(dirname(require.resolve('@gxzs/dsh-workbench-adapter/package.json')), 'lib/platform.patch.yml'))
