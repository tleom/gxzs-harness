import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sessionSearchSource } from '../../../scripts/prepare-session-search.mjs'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const [{ Context }, { Session, SESSION_FORMAT_VERSION }, { createUserMessage }] = await Promise.all([
  native('cordis'), native('dsh-session'), native('dsh-llm'),
])
const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const filter = cwd => [{ kind: 'cwd', values: [cwd] }]
const query = (ctx, cwd, extra = {}) => ctx.sessionQuery.searchSessions({ query: 'needle', sessionFilters: filter(cwd), ...extra })
const ids = result => result.items.map(item => item.header.id).sort()

function record(id, cwd, text = 'needle') {
  const session = Session.create(id, [], { id, version: SESSION_FORMAT_VERSION, createdAt: 1, cwd, isSeeded: false })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  return { header: session.header, events: session.snapshotEvents(), revision: '1' }
}
function persistence(records) {
  return {
    list: vi.fn(async () => records.map(({ header, revision }) => ({ header, revision }))),
    stat: vi.fn(async id => records.find(record => record.header.id === id)),
    open: vi.fn(async id => {
      const entry = records.find(record => record.header.id === id)
      if (!entry) throw new Error('missing fixture session')
      return { header: entry.header, read: async () => ({ events: entry.events, eventState: 'detached' }), close: async () => {} }
    }),
  }
}
async function boot(records, path = ':memory:') {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  for (const name of ['llm', 'session', 'session-projection']) await ctx.plugin((await native('dsh-' + name)).default)
  const store = persistence(records)
  const mount = service => ctx.plugin({ apply: child => { child.provide('sessionPersistence', service) } })
  const provider = mount(store)
  await provider
  await ctx.plugin((await native('dsh-session-query-sqlite')).default, { path, openAt: 'first-search' })
  return { ctx, store, provider, mount }
}

it('does not open hundreds of unrelated transcripts and serializes concurrent workspace searches correctly', async () => {
  const records = [record('local', '/a'), record('second', '/b'), ...Array.from({ length: 300 }, (_, i) => record('other-' + i, '/elsewhere'))]
  const { ctx, store } = await boot(records)
  const open = store.open.getMockImplementation()
  store.open.mockImplementation(id => { if (id.startsWith('other-')) throw new Error('unrelated slow/corrupt transcript'); return open(id) })
  const [a, b, again] = await Promise.all([query(ctx, '/a'), query(ctx, '/b'), query(ctx, '/a')])
  expect(ids(a)).toEqual(['local'])
  expect(ids(b)).toEqual(['second'])
  expect(ids(again)).toEqual(['local'])
  expect(store.open.mock.calls.map(([id]) => id)).toEqual(['local', 'second'])
})

it('within-session search reads only its target and an absent target remains absent', async () => {
  const { ctx, store } = await boot([record('target', '/a'), record('other', '/a')])
  const result = await ctx.sessionQuery.searchEvents({ sessionId: 'target', query: 'needle' })
  expect(result.items).toHaveLength(1)
  expect(store.open.mock.calls.map(([id]) => id)).toEqual(['target'])
  await expect(ctx.sessionQuery.searchEvents({ sessionId: 'missing', query: 'needle' })).rejects.toThrow()
  expect(store.open).toHaveBeenCalledTimes(1)
})

it('retains cold indexes across restart and revalidates changed/deleted sessions before serving results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gxzs-search-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'search.sqlite')
  const records = [record('a', '/a'), record('b', '/b')]
  const first = await boot(records, path)
  expect(ids(await query(first.ctx, '/a'))).toEqual(['a'])
  await first.ctx.fiber.dispose()
  const next = await boot(records, path)
  expect(ids(await query(next.ctx, '/a'))).toEqual(['a'])
  expect(next.store.open).not.toHaveBeenCalled()
  expect(ids(await query(next.ctx, '/b'))).toEqual(['b'])
  records[0] = { ...record('a', '/a', 'changed content'), revision: '2' }
  expect(ids(await query(next.ctx, '/a'))).toEqual([])
  expect(next.store.open.mock.calls.map(([id]) => id)).toEqual(['b', 'a'])
  records.splice(1, 1)
  expect(ids(await query(next.ctx, '/b'))).toEqual([])
})

it('keeps live data authoritative while live and unrelated histories are being appended', async () => {
  const { ctx, store } = await boot([])
  const live = ctx.sessions.create(undefined, { meta: { cwd: '/a' } })
  live.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'needle live' }] }), { surfaceOp: 'append' })
  let revision = 0
  store.list.mockImplementation(async () => [
    { header: live.header, revision: String(++revision) },
    { header: record('foreign', '/b').header, revision: String(revision) },
  ])
  expect(ids(await query(ctx, '/a'))).toEqual([live.id])
  expect(store.open).not.toHaveBeenCalled()
})

it('retries a changing cold session instead of publishing stale content', async () => {
  const records = [record('a', '/a')]
  const { ctx, store } = await boot(records)
  const open = store.open.getMockImplementation()
  store.open.mockImplementation(async id => {
    const handle = await open(id)
    if (records[0].revision === '1') records[0] = { ...record('a', '/a', 'replacement'), revision: '2' }
    return handle
  })
  expect(ids(await query(ctx, '/a'))).toEqual([])
  expect(store.open).toHaveBeenCalledTimes(2)
})

it('invalidates every old provider index before lazily indexing the replacement', async () => {
  const first = await boot([record('a', '/a'), record('b', '/b')])
  await query(first.ctx, '/a'); await query(first.ctx, '/b')
  await first.provider.dispose()
  const replacement = persistence([record('a', '/a'), record('b', '/b', 'replacement')])
  await first.mount(replacement)
  expect(ids(await query(first.ctx, '/a'))).toEqual(['a'])
  expect(ids(await query(first.ctx, '/b'))).toEqual([])
  expect(replacement.open.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
})

it('keeps native pagination, unscoped searches and empty scopes correct', async () => {
  const { ctx } = await boot([record('a', '/a'), record('b', '/a'), record('c', '/b')])
  const first = await query(ctx, '/a', { limit: 1 })
  const second = await query(ctx, '/a', { limit: 1, cursor: first.nextCursor })
  expect([...ids(first), ...ids(second)].sort()).toEqual(['a', 'b'])
  expect(ids(await ctx.sessionQuery.searchSessions({ query: 'needle' }))).toEqual(['a', 'b', 'c'])
  expect(ids(await query(ctx, '/a', { sessionFilters: [{ kind: 'cwd', values: [] }] }))).toEqual([])
})

it('aborted searches release the queue for subsequent requests', async () => {
  const { ctx, store } = await boot([record('a', '/a')])
  const open = store.open.getMockImplementation()
  store.open.mockImplementationOnce(async (_id, _mode, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  await expect(ctx.sessionQuery.searchSessions({ query: 'needle', sessionFilters: filter('/a') }, { signal: AbortSignal.timeout(20) })).rejects.toThrow()
  store.open.mockImplementation(open)
  expect(ids(await query(ctx, '/a'))).toEqual(['a'])
})

it('does not evict unchanged live indexes when another workspace searches between pages', async () => {
  const { ctx } = await boot([])
  for (const cwd of ['/a', '/a', '/b']) {
    const session = ctx.sessions.create(undefined, { meta: { cwd } })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'needle' }] }), { surfaceOp: 'append' })
  }
  await query(ctx, '/a'); await query(ctx, '/b')
  const first = await query(ctx, '/a', { limit: 1 })
  await query(ctx, '/b')
  const second = await query(ctx, '/a', { limit: 1, cursor: first.nextCursor })
  expect(new Set([...ids(first), ...ids(second)]).size).toBe(2)
})

it('applies the version-pinned source transformation idempotently', async () => {
  const source = await readFile(require.resolve('@deepseek-ai/dsh-session-query-sqlite'), 'utf8')
  const patched = sessionSearchSource(source)
  expect(sessionSearchSource(patched)).toBe(patched)
  expect(() => sessionSearchSource('unrecognized upstream source')).toThrow('anchor changed')
})
