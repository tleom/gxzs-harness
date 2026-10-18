import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sessionSearchLiveSource } from '../../../scripts/prepare-session-search.mjs'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const [{ Context }, { createUserMessage }] = await Promise.all([native('cordis'), native('dsh-llm')])
const cleanups = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gxzs-search-live-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const sessions = await ctx.plugin((await native('dsh-session')).default)
  const projection = await ctx.plugin((await native('dsh-session-projection')).default)
  const persistence = await ctx.plugin(await native('dsh-session-persistence-jsonl'), { root: join(root, 'sessions'), compression: 'none' })
  const query = await ctx.plugin((await native('dsh-session-query-sqlite')).default, { path: join(root, 'search.sqlite'), openAt: 'first-search' })
  const owners = []
  cleanups.push(async () => {
    await query.dispose()
    for (const owner of owners) { await owner.writer.close(); owner.detach() }
    await persistence.dispose()
    await projection.dispose()
    await sessions.dispose()
  })
  async function create(id) {
    const session = ctx.sessions.prepare(id, { meta: { createdAt: 1 } })
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const writer = await ctx.sessionPersistence.create(session.header)
    let count = 0
    const owner = { session, writer, detach, async append() {
      session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: `needle ${id} event${++count}` }] }), { surfaceOp: 'append' })
      await ctx.sessionPersistence.flush()
    } }
    owners.push(owner)
    return owner
  }
  return { ctx, create }
}

it('searches a live Session through its first real JSONL flush without retrying', async () => {
  const { ctx, create } = await fixture()
  const owner = await create('first-flush')
  const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
  const revisions = []
  const list = vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async (...args) => {
    const result = await original(...args)
    revisions.push(result[0].revision)
    if (revisions.length === 1) await owner.append()
    return result
  })
  const page = await ctx.sessionQuery.searchSessions({ query: 'needle' })
  expect(page.items.map(item => item.header.id)).toEqual(['first-flush'])
  expect(revisions[0]).not.toBe(revisions[1])
  expect(list).toHaveBeenCalledTimes(2)
})

it('serializes concurrent searches while every live observation flushes real events', async () => {
  const { ctx, create } = await fixture()
  const owner = await create('active-writer')
  await owner.append()
  const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
  let lists = 0
  let active = 0
  let peak = 0
  vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async (...args) => {
    peak = Math.max(peak, ++active)
    try {
      const result = await original(...args)
      if (++lists % 2) await owner.append()
      return result
    } finally { active-- }
  })
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  const results = await Promise.all(Array.from({ length: 12 }, () => ctx.sessionQuery.searchSessions({ query: 'needle' })))
  for (const result of results) expect(result.items.map(item => item.header.id)).toEqual(['active-writer'])
  expect(lists).toBe(24)
  expect(peak).toBe(1)
  expect(open).not.toHaveBeenCalled()
})

it('still rejects repeatedly changing cold persistence revisions', async () => {
  const { ctx, create } = await fixture()
  const owner = await create('cold-writer')
  await owner.append()
  await owner.writer.close()
  owner.detach()
  const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
  let revision = 0
  const list = vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async (...args) =>
    (await original(...args)).map(snapshot => ({ ...snapshot, revision: `changed:${++revision}` })))
  await expect(ctx.sessionQuery.searchSessions({ query: 'needle' })).rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
  expect(list).toHaveBeenCalledTimes(4)
})

it('still rejects changing durable headers even when the Session is live', async () => {
  const { ctx, create } = await fixture()
  const owner = await create('header-boundary')
  await owner.append()
  const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
  let version = 0
  const list = vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async (...args) =>
    (await original(...args)).map(snapshot => ({ ...snapshot, header: { ...snapshot.header, createdAt: ++version } })))
  await expect(ctx.sessionQuery.searchSessions({ query: 'needle' })).rejects.toMatchObject({ code: 'SESSION_QUERY_PERSISTENCE_FAILED' })
  expect(list).toHaveBeenCalledTimes(4)
})

it('retries a live detach and indexes the final durable events instead of a stale live revision', async () => {
  const { ctx, create } = await fixture()
  const owner = await create('detach-boundary')
  await owner.append()
  const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
  let lists = 0
  vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (++lists === 1) {
      await owner.append()
      await owner.writer.close()
      owner.detach()
    }
    return result
  })
  const open = vi.spyOn(ctx.sessionPersistence, 'open')
  const page = await ctx.sessionQuery.searchSessions({ query: 'event2' })
  expect(page.items).toMatchObject([{ header: { id: 'detach-boundary' }, live: false, persisted: true }])
  expect(lists).toBe(4)
  expect(open).toHaveBeenCalled()
})

it('retries a newly attached live Session without dropping it from search', async () => {
  const { ctx, create } = await fixture()
  const owner = await create('existing')
  await owner.append()
  const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
  let lists = 0
  vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (++lists === 1) await (await create('newly-attached')).append()
    return result
  })
  const page = await ctx.sessionQuery.searchSessions({ query: 'needle' })
  expect(page.items.map(item => item.header.id).sort()).toEqual(['existing', 'newly-attached'])
  expect(lists).toBe(4)
})

it('rejects drifted upstream code and is idempotent on the reviewed transformation', () => {
  const original = 'samePersistenceSnapshots(persisted, after)\nfunction samePersistenceSnapshots(before, after) {\nfirst.revision !== second.revision || !sameHeader(first.header, second.header)\n}'
  const patched = sessionSearchLiveSource(original)
  expect(sessionSearchLiveSource(patched)).toBe(patched)
  expect(() => sessionSearchLiveSource(original.replace('first.revision', 'first.token'))).toThrow('Review native session search')
  expect(() => sessionSearchLiveSource(original + original)).toThrow('Review native session search')
})
