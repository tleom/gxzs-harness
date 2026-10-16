import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const original = 'machine.cancel({ kind: "disposed" });'
const prepared = 'machine.cancel({ kind: "disposed" }, { keepInbox: true });'

/** Process teardown must not discard durable messages that have not been claimed. */
export function prepareAgentInbox(source) {
  if (source.split(original).length + source.split(prepared).length !== 3
    || !source.includes('cancel(cause, options = {})') || !source.includes('if (!options.keepInbox) {')
    || !source.includes('await machine.whenIdle();'))
    throw new Error('DSH agent disposal contract changed; inspect upstream before upgrading')
  return source.replace(original, prepared)
}

export async function agentLoopPath(profile) {
  const require = createRequire(join(resolve(profile), 'package.json'))
  const path = require.resolve('@deepseek-ai/dsh-agent-loop')
  const metadata = JSON.parse(await readFile(join(dirname(path), '../package.json'), 'utf8'))
  if (metadata.version !== '0.2.1-alpha.2') throw new Error('Unverified DSH agent loop version')
  return path
}

export async function prepareDshAgentInbox(profile) {
  const path = await agentLoopPath(profile)
  const source = await readFile(path, 'utf8')
  const result = prepareAgentInbox(source)
  if (result !== source) await writeFile(path, result)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareDshAgentInbox(process.argv[2] || fileURLToPath(new URL('../profiles/workbench/', import.meta.url)))
