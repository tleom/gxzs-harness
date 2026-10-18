import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { ChatDeletion } from '../src/chat-deletion.js'
import { WorkbenchDatabase } from '../src/persistence.js'
import { agentDeletionSource, persistenceDeletionSource, queryDeletionSource, projectionDeletionSource, domainDeletionSource, jsonStorageDeletionSource } from '../../../scripts/prepare-session-deletion.mjs'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const [{ Context }, { createUserMessage }] = await Promise.all([native('cordis'), native('dsh-llm')])
const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

async function fixture(root) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('workingDirectory', { defaultDirectory: root, get: () => root, ensure: async () => root })
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent'])
    await ctx.plugin((await native('dsh-' + name)).default)
  await ctx.plugin(await native('dsh-session-persistence-jsonl'), { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin((await native('dsh-storage')).default)
  await ctx.plugin(await native('dsh-storage-json'), { root: join(root, 'storages') })
  await ctx.plugin(await native('dsh-storage-domain'), { backend: 'json' })
  await ctx.plugin((await native('dsh-session-projection-cache')).default, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  await ctx.plugin((await native('dsh-agent-loop')).default)
  await ctx.plugin((await native('dsh-session-query-sqlite')).default, { path: join(root, 'search.sqlite'), openAt: 'first-search' })
  return ctx
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'gxzs-permanent-delete-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
const options = (id, root) => ({ sessionId: id, meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'unused' } })
const append = (agent, text) => agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })

it('removes live parent and owned child histories/indexes and preserves an independent fork across restart', async () => {
  const root = await directory()
  const ctx = await fixture(root)
  const parent = (await ctx.agents.create(options('parent', root))).agent
  append(parent, 'needle original history')
  const child = (await ctx.agents.create({ ...options('child', root), parentAgent: parent,
    meta: { cwd: root, parentSession: parent.id, origin: 'subagent' } })).agent
  append(child, 'needle child history')
  const fork = (await ctx.agents.create({ ...options('fork', root), meta: { cwd: root, parentSession: parent.id, isSeeded: true },
    seed: parent.session.snapshotEvents(), inheritedEventCount: parent.session.seq })).agent
  const other = (await ctx.agents.create(options('other', root))).agent
  append(other, 'needle retained history')
  await ctx.sessionPersistence.flush()
  expect((await ctx.sessionQuery.searchSessions({ query: 'needle' })).items).toHaveLength(4)
  const db = new WorkbenchDatabase(':memory:')
  cleanups.push(() => db.close())
  const chat = db.createChat({ ownerId: 'owner', sessionId: parent.id, selection: {} })
  db.createChat({ ownerId: 'owner', sessionId: fork.id, selection: {} })
  const deletion = new ChatDeletion(ctx, db, 'owner')
  const ids = await deletion.prepare(chat)
  expect(ids.sort()).toEqual(['child', 'parent'])
  await deletion.erase({ sessionIds: ids })
  for (const id of ids) {
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    expect(await ctx.sessionPersistence.stat(id)).toBeUndefined()
    await expect(ctx.sessionQuery.observeSession(id)).rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    await expect(ctx.agents.resume({ resumeSessionId: id })).rejects.toMatchObject({ code: 'SESSION_DELETED' })
  }
  expect((await ctx.sessionQuery.searchSessions({ query: 'needle' })).items.map(row => row.header.id).sort()).toEqual(['fork', 'other'])
  expect(ctx.agents.get('other')).toBe(other)
  for (const project of await readdir(join(root, 'sessions'))) for (const id of ids) {
    const files = await readdir(join(root, 'sessions', project, id)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
    expect(files.filter(name => name !== 'session.lock')).toEqual([])
  }
  await ctx.fiber.dispose()
  const restarted = await fixture(root)
  expect((await restarted.sessionPersistence.list()).map(row => row.header.id).sort()).toEqual(['fork', 'other'])
  expect((await restarted.sessionQuery.searchSessions({ query: 'needle' })).items.map(row => row.header.id).sort()).toEqual(['fork', 'other'])
})

it('does not remove stored history while its native writer is still live', async () => {
  const root = await directory(), ctx = await fixture(root)
  const { agent } = await ctx.agents.create(options('live', root))
  append(agent, 'retained')
  await ctx.sessionPersistence.flush()
  await expect(ctx.sessionPersistence.deleteSessionPermanently(agent.id)).rejects.toThrow()
  expect(await ctx.sessionPersistence.stat(agent.id)).toBeDefined()
})

it('revokes old-generation readers and observations and clears derived data, backup records and WAL', async () => {
  const root = await directory(), ctx = await fixture(root)
  const handle = await ctx.agents.create(options('deleted', root))
  const marker = 'uniquedeletedbodymarker'
  append(handle.agent, marker)
  await ctx.sessionPersistence.flush()
  const path = ctx.sessionPersistence.locate(handle.agent.session.header).path
  await ctx.sessionProjectionCache.write(handle.agent.session)
  await handle.dispose()
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
  const header = JSON.parse(lines[0]); header.version = 3; lines[0] = JSON.stringify(header)
  await writeFile(path.replace('v4', 'v3'), lines.join('\n') + '\n')
  await rm(path)
  const reader = await ctx.sessionPersistence.open('deleted', 'read')
  expect((await reader.read()).events).toHaveLength(1)
  const observation = await ctx.sessionQuery.observeSession('deleted')
  const retained = observation.retain()
  expect((await ctx.sessionQuery.searchSessions({ query: marker })).items).toHaveLength(1)
  const recordPath = join(root, 'storages/session_projcache/sessions/deleted.json')
  await writeFile(recordPath + '.bak.202610182100', marker)
  const stagingPath = join(root, 'storages/session_projcache/sessions/.12345678-1234-1234-1234-123456789abc.tmp')
  await writeFile(stagingPath, marker)
  const legacy = join(root, 'storages/session_projcache.json')
  await writeFile(legacy, JSON.stringify({ unit: { name: 'session_projcache', version: 7 }, tables: { sessions: {
    deleted: { marker }, retained: { marker: 'retained value' },
  } } }))
  await new ChatDeletion(ctx, {}, 'owner').erase({ sessionIds: ['deleted'] })
  await expect(reader.read()).rejects.toThrow()
  expect(reader.state.primed).toBeUndefined()
  expect(() => observation.events).toThrow()
  expect(() => retained.retain()).toThrow()
  observation[Symbol.dispose](); retained[Symbol.dispose]()
  expect(ctx.sessionQuery._observations.cache.has('deleted')).toBe(false)
  expect(ctx.sessionPersistence.coldLogMemo.has('deleted')).toBe(false)
  expect(ctx.sessionProjectionCache.requireTable().get('deleted')).toBeUndefined()
  expect(await readdir(join(root, 'storages/session_projcache/sessions'))).not.toContain('deleted.json')
  await expect(readFile(recordPath + '.bak.202610182100')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.parse(await readFile(legacy, 'utf8')).tables.sessions).toEqual({ retained: { marker: 'retained value' } })
  for (const name of ['search.sqlite', 'search.sqlite-wal']) {
    const bytes = await readFile(join(root, name)).catch(error => error.code === 'ENOENT' ? Buffer.alloc(0) : Promise.reject(error))
    expect(bytes.includes(Buffer.from(marker))).toBe(false)
  }
  const blocks = ctx.sessionQuery._db.prepare('SELECT block FROM persisted_docs_data').all()
  expect(blocks.some(row => Buffer.from(row.block).includes(Buffer.from(marker)))).toBe(false)
})

it('retries removal of staging artifacts after the canonical log was already removed', async () => {
  const root = await directory(), ctx = await fixture(root)
  const handle = await ctx.agents.create(options('partial', root))
  append(handle.agent, 'private staging content')
  await ctx.sessionPersistence.flush()
  const path = ctx.sessionPersistence.locate(handle.agent.session.header).path
  await handle.dispose()
  await writeFile(path + '.retry.tmp', 'private staging content')
  await rm(path)
  await new ChatDeletion(ctx, {}, 'owner').erase({ sessionIds: ['partial'] })
  await expect(readFile(path + '.retry.tmp')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes private full tool output but preserves output referenced by a surviving fork', async () => {
  const root = await directory(), ctx = await fixture(root)
  const path = id => `.agent-output/${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
  const files = { operate: vi.fn(async () => ({ kind: 'directory', version: 'version' })) }
  ctx.provide('workbenchFileManager', files)
  const parent = await ctx.agents.create(options('parent', root))
  append(parent.agent, '/workspace/' + path('parent') + '/result.txt')
  await ctx.agents.create({ ...options('fork', root), meta: { cwd: root, parentSession: 'parent', isSeeded: true },
    seed: parent.agent.session.snapshotEvents(), inheritedEventCount: parent.agent.session.seq })
  const child = await ctx.agents.create(options('child', root))
  append(child.agent, '/workspace/' + path('child') + '/result.txt')
  const queuedSource = await ctx.agents.create(options('queued-source', root))
  append(queuedSource.agent, 'output creator')
  const db = new WorkbenchDatabase(':memory:')
  cleanups.push(() => db.close())
  const queuedChat = db.createChat({ ownerId: 'owner', sessionId: 'queued', selection: {} })
  db.createRun({ ownerId: 'owner', chatId: queuedChat.id, sessionId: 'queued', query: '/workspace/' + path('queued-source') + '/result.txt', selection: {} })
  await ctx.sessionPersistence.flush()
  await new ChatDeletion(ctx, db, 'owner').erase({ sessionIds: ['parent', 'child', 'queued-source'] })
  expect(files.operate.mock.calls.filter(([value]) => value.operation === 'delete').map(([value]) => value.path)).toEqual([path('child')])
})

it('clears both the platform and isolated tool-search indexes sharing the same native persistence', async () => {
  const root = await directory(), ctx = await fixture(root)
  const isolated = new Context()
  cleanups.push(() => isolated.fiber.dispose())
  isolated.provide('sessions', ctx.sessions)
  isolated.provide('sessionPersistence', ctx.sessionPersistence)
  await isolated.plugin((await native('dsh-session-query-sqlite')).default, { path: join(root, 'tool-search.sqlite'), openAt: 'first-search' })
  const handle = await ctx.agents.create(options('indexed', root))
  append(handle.agent, 'isolatedindexmarker')
  await ctx.sessionPersistence.flush()
  for (const query of [ctx.sessionQuery, isolated.sessionQuery])
    expect((await query.searchSessions({ query: 'isolatedindexmarker' })).items).toHaveLength(1)
  expect(ctx.sessionPersistence.deletionQueries.size).toBe(2)
  await new ChatDeletion(ctx, {}, 'owner').erase({ sessionIds: ['indexed'] })
  for (const query of [ctx.sessionQuery, isolated.sessionQuery]) {
    expect(query._db.prepare('SELECT id FROM persisted_sessions').all()).toEqual([])
    await expect(query.observeSession('indexed')).rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    expect((await query.searchSessions({ query: 'isolatedindexmarker' })).items).toEqual([])
  }
})

it('drains a creation already in progress and prevents future recreation of its deleted identity', async () => {
  const root = await directory(), ctx = await fixture(root)
  const entered = Promise.withResolvers(), unblock = Promise.withResolvers()
  const creating = ctx.agents.create({ ...options('racing', root), setup: async () => { entered.resolve(); await unblock.promise } })
  const rejected = expect(creating).rejects.toMatchObject({ code: 'SESSION_DELETED' })
  await entered.promise
  const deleting = ctx.agents.disposeSessionForDeletion('racing')
  unblock.resolve()
  await Promise.all([rejected, deleting])
  expect(ctx.agents.get('racing')).toBeUndefined()
  expect(ctx.sessions.get('racing')).toBeUndefined()
  await expect(ctx.agents.create(options('racing', root))).rejects.toMatchObject({ code: 'SESSION_DELETED' })
})

it('physically removes platform rows with cascade and retains only an idempotency receipt', () => {
  const db = new WorkbenchDatabase(':memory:')
  cleanups.push(() => db.close())
  const chat = db.createChat({ ownerId: 'owner', sessionId: 'parent', selection: {} })
  const retained = db.createChat({ ownerId: 'owner', sessionId: 'fork', selection: {} })
  const { run } = db.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: 'parent', query: 'private text', selection: {} })
  db.transitionRun('owner', run.id, 'completed')
  db.appendEvent('owner', run.id, { event: 'test', text: 'private text' })
  db.db.prepare('INSERT INTO pending_turns VALUES (?,?,?)').run('child', 1, 0)
  db.db.prepare('INSERT INTO projected_native_events VALUES (?,?)').run('child', 0)
  expect(() => db.beginChatDeletion('owner', chat.id, ['fork'])).toThrow('another conversation')
  const receipt = db.beginChatDeletion('owner', chat.id, ['parent', 'child'])
  expect(receipt.completedAt).toBeNull()
  db.finishChatDeletion('owner', chat.id)
  expect(db.db.prepare('SELECT * FROM runs').all()).toEqual([])
  expect(db.db.prepare('SELECT * FROM run_events').all()).toEqual([])
  expect(db.db.prepare('SELECT * FROM pending_turns').all()).toEqual([])
  expect(db.db.prepare('SELECT * FROM projected_native_events').all()).toEqual([])
  expect(db.getChat('owner', retained.id)).toBeDefined()
  expect(db.pendingChatDeletions('owner')).toEqual([])
  db.finishChatDeletion('owner', chat.id)
})

it.each([
  ['dsh-agent', agentDeletionSource], ['dsh-session-persistence-jsonl', persistenceDeletionSource], ['dsh-session-query-sqlite', queryDeletionSource],
  ['dsh-session-projection-cache', projectionDeletionSource], ['dsh-storage-domain', domainDeletionSource], ['dsh-storage-json', jsonStorageDeletionSource],
])('pins the permanent deletion extension to reviewed %s source', async (name, transform) => {
  const source = await readFile(require.resolve('@deepseek-ai/' + name), 'utf8')
  expect(transform(source)).toBe(source)
  expect(() => transform('unrecognized source')).toThrow('anchor changed')
})
