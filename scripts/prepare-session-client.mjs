import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Preserve the caller's native submission identity in the published child branch. */
export function sessionClientSubmissionIdentity(source) {
  const bad = /(this\.remote\.subagents\.prompt\(\{\s+requestId: )randomUUID\(\),/g
  const fixed = /(this\.remote\.subagents\.prompt\(\{\s+requestId: )requestId \?\? randomUUID\(\),/g
  const badCount = [...source.matchAll(bad)].length
  const fixedCount = [...source.matchAll(fixed)].length
  if (!source.includes('async prompt(content, mode, signal, requestId)') || badCount + fixedCount !== 1)
    throw new Error('DSH Session client submission identity contract changed; inspect upstream before upgrading')
  return badCount ? source.replace(bad, '$1requestId ?? randomUUID(),') : source
}

export async function prepareSessionClient(profile) {
  const require = createRequire(join(profile, 'package.json'))
  const manifest = require.resolve('@deepseek-ai/dsh-api-session-controller/package.json')
  const metadata = JSON.parse(await readFile(manifest, 'utf8'))
  if (metadata.version !== '0.2.1-alpha.5') throw new Error(`Unverified Session client version: ${metadata.version}`)
  const entry = require.resolve('@deepseek-ai/dsh-api-session-controller/client')
  const source = await readFile(entry, 'utf8')
  const prepared = sessionClientSubmissionIdentity(source)
  if (prepared !== source) await writeFile(entry, prepared)
}
