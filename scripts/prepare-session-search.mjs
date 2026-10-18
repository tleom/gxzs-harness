import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A live Session is already the authoritative search source. Its ordinary
// JSONL flush must not invalidate an observation that never read its cold log.
// Keep native membership/header, cold revision, binding and lifecycle checks.
export function sessionSearchLiveSource(source) {
  const changes = [
    ['samePersistenceSnapshots(persisted, after)', 'samePersistenceSnapshots(persisted, after, initiallyLive)'],
    ['function samePersistenceSnapshots(before, after) {', 'function samePersistenceSnapshots(before, after, live) {'],
    ['first.revision !== second.revision || !sameHeader(first.header, second.header)',
      '(!live.has(id) && first.revision !== second.revision) || !sameHeader(first.header, second.header)'],
  ]
  if (changes.every(([, after]) => source.includes(after))) return source
  for (const [before, after] of changes) {
    if (source.split(before).length !== 2) throw new Error('Review native session search before updating the live flush fix')
    source = source.replace(before, after)
  }
  return source
}

export async function prepareSessionSearch(root) {
  const directory = join(root, 'node_modules/@deepseek-ai/dsh-session-query-sqlite')
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (metadata.version !== '0.2.1-rc.2') throw new Error('Review native session search against the new DSH version first')
  const path = join(directory, 'lib/index.js')
  const source = await readFile(path, 'utf8')
  const stamp = '// gxzs-session-search-live:' + createHash('sha256').update(sessionSearchLiveSource.toString()).digest('hex')
  if (source.includes('// gxzs-session-search-live:') && !source.includes(stamp))
    throw new Error('Reinstall clean DSH packages before updating the live search fix')
  const next = sessionSearchLiveSource(source)
  if (next === source && !source.includes(stamp)) throw new Error('Unversioned live search fix; reinstall clean DSH packages')
  if (next !== source) await writeFile(path, next + '\n' + stamp + '\n')
}
