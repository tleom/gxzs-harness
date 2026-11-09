import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// npm does not apply DSH's pnpm patchedDependencies. Apply the unmodified
// release patch, including Gemini signatures, instead of maintaining a fork.
const patchFile = new URL('../patches/@earendil-works__pi-ai@1.3.0.patch', import.meta.url)

export function assertDshArgumentConsumer(source) {
  const delta = source.slice(source.indexOf('case "toolcall_delta":'), source.indexOf('case "toolcall_end":'))
  if (!delta.includes('argumentsDelta: event.delta') || delta.includes('.partial')
    || !source.includes('arguments: JSON.stringify(event.toolCall.arguments)'))
    throw new Error('DSH streamed argument consumer changed; inspect upstream before upgrading')
}

export async function upstreamPiAiPatches(profile) {
  const require = createRequire(join(resolve(profile), 'package.json'))
  const { parsePatch, applyPatch, reversePatch } = require('diff')
  return parsePatch(await readFile(patchFile, 'utf8')).map(patch => ({
    path: patch.newFileName.replace(/^b\//, ''),
    apply(source) {
      const result = applyPatch(source, patch)
      if (result !== false) return result
      if (applyPatch(source, reversePatch(patch)) !== false) return source
      throw new Error(`pi-ai ${patch.newFileName} contract changed; inspect upstream before upgrading`)
    },
    reverse: source => applyPatch(source, reversePatch(patch)),
  }))
}

export async function argumentStreamPaths(profile) {
  const require = createRequire(join(resolve(profile), 'package.json'))
  const consumer = require.resolve('@deepseek-ai/dsh-llm-pi-ai')
  const consumerMetadata = JSON.parse(await readFile(join(dirname(consumer), '../package.json'), 'utf8'))
  if (consumerMetadata.version !== '0.2.2-rc.1') throw new Error('Unverified DSH argument consumer version')
  const dependencyRequire = createRequire(consumer)
  const folder = dependencyRequire.resolve.paths('@earendil-works/pi-ai')
    .map(path => join(path, '@earendil-works/pi-ai')).find(path => existsSync(join(path, 'package.json')))
  if (!folder) throw new Error('pi-ai dependency not installed')
  const metadata = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
  if (metadata.version !== '1.3.0') throw new Error('Unverified pi-ai argument stream version')
  return { consumer, folder, provider: join(folder, 'dist/api/openai-completions.js') }
}

export async function prepareDshStreamArguments(profile) {
  const { consumer, folder } = await argumentStreamPaths(profile)
  assertDshArgumentConsumer(await readFile(consumer, 'utf8'))
  const writes = []
  for (const patch of await upstreamPiAiPatches(profile)) {
    const path = join(folder, patch.path)
    const source = await readFile(path, 'utf8')
    const result = patch.apply(source)
    if (result !== source) writes.push([path, result])
  }
  // Validate every hunk before modifying any provider.
  for (const [path, result] of writes) await writeFile(path, result)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareDshStreamArguments(process.argv[2] || fileURLToPath(new URL('../profiles/workbench/', import.meta.url)))
