#!/usr/bin/env node
// Read-only compatibility check for mounted historical sessions. No agent or
// model is constructed; report counts and hashed identities, never messages.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require = createRequire('/opt/workbench/profiles/workbench/package.json')
const native = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, JsonlPersistence] = await Promise.all([native('cordis'), native('dsh-session-persistence-jsonl')])
let failures = 0
const verifyWrite = process.argv.includes('--verify-write-copy')
for (const root of process.argv.slice(2).filter(value => value !== '--verify-write-copy')) {
  const ctx = new Context()
  let temporary
  let total = 0, opened = 0, events = 0
  try {
    if (verifyWrite) {
      temporary = await mkdtemp(join(tmpdir(), 'gxzs-session-upgrade-'))
      await cp(root, join(temporary, 'sessions'), { recursive: true })
    }
    await ctx.plugin(JsonlPersistence, { root: temporary ? join(temporary, 'sessions') : root })
    const snapshots = await ctx.sessionPersistence.list()
    total = snapshots.length
    for (const snapshot of snapshots) {
      let handle
      try {
        handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
        const content = await handle.read()
        if (verifyWrite) {
          const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
          const expected = fingerprint(content)
          await handle[Symbol.asyncDispose]()
          handle = await ctx.sessionPersistence.open(snapshot.header.id, 'write')
          if (fingerprint(await handle.read()) !== expected) throw new Error('Write-open changed session content')
          await handle[Symbol.asyncDispose]()
          handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
          if (fingerprint(await handle.read()) !== expected) throw new Error('Reopened session content changed')
        }
        events += content.events.length
        opened++
      } catch (error) {
        failures++
        console.log(JSON.stringify({ event: 'session_upgrade_error', session_hash: createHash('sha256').update(snapshot.header.id).digest('hex').slice(0, 12), type: error.constructor.name, code: error.code }))
      } finally { await handle?.[Symbol.asyncDispose]() }
    }
    console.log(JSON.stringify({ event: verifyWrite ? 'session_upgrade_write_copy' : 'session_upgrade_read', total, opened, events, original_read_only: true }))
  } catch (error) {
    failures++
    console.log(JSON.stringify({ event: 'session_upgrade_root_error', type: error.constructor.name, code: error.code }))
  } finally {
    await ctx.fiber.dispose()
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}
process.exitCode = failures ? 1 : 0
