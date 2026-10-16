import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const original = `                                block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
                                block.arguments = parseStreamingJson(block.partialArgs);`
const prepared = `                                block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
                                // gxzs: DSH consumes raw argument deltas; parse once in finishBlock.
                                // Re-parsing every incomplete prefix blocks health and lease renewal.`

export function assertDshArgumentConsumer(source) {
  const delta = source.slice(source.indexOf('case "toolcall_delta":'), source.indexOf('case "toolcall_end":'))
  if (!delta.includes('argumentsDelta: event.delta') || delta.includes('.partial')
    || !source.includes('arguments: JSON.stringify(event.toolCall.arguments)'))
    throw new Error('DSH streamed argument consumer changed; inspect upstream before upgrading')
}

export function prepareArgumentStream(source) {
  const oldCount = source.split(original).length - 1
  const newCount = source.split(prepared).length - 1
  if (oldCount + newCount !== 1 || !source.includes('const finishBlock = (block) => {')
    || source.split('block.arguments = parseStreamingJson(block.partialArgs);').length - 1 !== (oldCount ? 2 : 1))
    throw new Error('pi-ai argument stream contract changed; inspect upstream before upgrading')
  return oldCount ? source.replace(original, prepared) : source
}

export async function argumentStreamPaths(profile) {
  const require = createRequire(join(resolve(profile), 'package.json'))
  const consumer = require.resolve('@deepseek-ai/dsh-llm-pi-ai')
  const consumerMetadata = JSON.parse(await readFile(join(dirname(consumer), '../package.json'), 'utf8'))
  if (consumerMetadata.version !== '0.2.1-alpha.2') throw new Error('Unverified DSH argument consumer version')
  const dependencyRequire = createRequire(consumer)
  const folder = dependencyRequire.resolve.paths('@earendil-works/pi-ai')
    .map(path => join(path, '@earendil-works/pi-ai')).find(path => existsSync(join(path, 'package.json')))
  if (!folder) throw new Error('pi-ai dependency not installed')
  const metadata = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
  if (metadata.version !== '1.1.0') throw new Error('Unverified pi-ai argument stream version')
  return { consumer, provider: join(folder, 'dist/api/openai-completions.js') }
}

export async function prepareDshStreamArguments(profile) {
  const { consumer, provider } = await argumentStreamPaths(profile)
  assertDshArgumentConsumer(await readFile(consumer, 'utf8'))
  const source = await readFile(provider, 'utf8')
  const result = prepareArgumentStream(source)
  if (result !== source) await writeFile(provider, result)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareDshStreamArguments(process.argv[2] || fileURLToPath(new URL('../profiles/workbench/', import.meta.url)))
