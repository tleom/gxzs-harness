import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const [{ Context }, { Session, SESSION_FORMAT_VERSION }, { createUserMessage }] = await Promise.all([
  native('cordis'), native('dsh-session'), native('dsh-llm'),
])
const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function record(id, cwd, text = 'needle', revision = '1') {
  const session = Session.create(id, [], { id, version: SESSION_FORMAT_VERSION, createdAt: 1, cwd, isSeeded: false })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  return { header: session.header, events: session.snapshotEvents(), revision }
}

async function boot(records, path) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  for (const name of ['llm', 'session', 'session-projection']) await ctx.plugin((await native('dsh-' + name)).default)
  const store = {
    list: async () => records.map(({ header, revision }) => ({ header, revision })),
    stat: async id => records.find(record => record.header.id === id),
    open: vi.fn(async id => {
      const entry = records.find(record => record.header.id === id)
      if (!entry) throw new Error('missing fixture session')
      return { header: entry.header, read: async () => ({ events: entry.events, eventState: 'detached' }), close: async () => {} }
    }),
  }
  await ctx.plugin({ apply: child => { child.provide('sessionPersistence', store) } })
  await ctx.plugin((await native('dsh-session-query-sqlite')).default, { path, openAt: 'first-search' })
  return { ctx, store }
}

const search = (ctx, cwd) => ctx.sessionQuery.searchSessions({ query: 'needle', sessionFilters: [{ kind: 'cwd', values: [cwd] }] })
const ids = result => result.items.map(item => item.header.id).sort()

it('reuses the official persistent index after restart and removes deleted histories during native reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gxzs-native-search-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'search.sqlite')
  const records = [record('a', '/a'), record('b', '/b')]
  const first = await boot(records, path)
  expect(ids(await search(first.ctx, '/a'))).toEqual(['a'])
  // Native reconciliation remains global; only result visibility is scoped.
  expect(first.store.open.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b'])
  await first.ctx.fiber.dispose()

  const next = await boot(records, path)
  expect(ids(await search(next.ctx, '/a'))).toEqual(['a'])
  expect(next.store.open).not.toHaveBeenCalled()
  records[0] = record('a', '/a', 'replacement text', '2')
  expect(ids(await search(next.ctx, '/a'))).toEqual([])
  expect(next.store.open.mock.calls.map(([id]) => id)).toEqual(['a'])
  records.splice(1, 1)
  expect(ids(await search(next.ctx, '/b'))).toEqual([])
  await next.ctx.fiber.dispose()

  const restarted = await boot(records, path)
  expect(ids(await search(restarted.ctx, '/b'))).toEqual([])
  expect(restarted.store.open).not.toHaveBeenCalled()
})
