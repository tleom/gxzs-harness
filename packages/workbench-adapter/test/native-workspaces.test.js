import { afterEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { streamWorkspaceEvents } from '../src/workspace-events.js'

const requireNative = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(requireNative.resolve(`@deepseek-ai/${name}`)).href)
const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it('keeps workspace membership, pin/archive and order in published DSH durable state', async () => {
  const [{ Context }, { default: Storage }, { JsonStorageBackend }, { DomainFacility }, { default: Registry }] = await Promise.all([
    native('cordis'), native('dsh-storage'), native('dsh-storage-json'), native('dsh-storage-domain'), native('dsh-workspace'),
  ])
  await mkdir(resolve('../temp'), { recursive: true })
  const root = await mkdtemp(resolve('../temp/native-workspaces-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const a = join(root, 'a'), b = join(root, 'b')
  await mkdir(a); await mkdir(b)
  const headers = [{ version: 1, id: 'session-a', cwd: a, createdAt: 100, isSeeded: false }, { version: 1, id: 'session-b', cwd: a, createdAt: 200, isSeeded: false }]
  async function boot() {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(join(root, 'state'))
    ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('sessionPersistence', { list: async () => headers.map(header => ({ header, revision: `rev-${header.id}` })), stat: async id => headers.some(header => header.id === id) ? { header: headers.find(header => header.id === id), revision: 'rev' } : undefined })
    await ctx.plugin(Registry)
    const { WorkspaceCommands } = await import(pathToFileURL(join(dirname(requireNative.resolve('@deepseek-ai/dsh-api-workspace-controller')), 'types', 'commands.js')).href)
    const { WorkspaceFeed } = await import(pathToFileURL(join(dirname(requireNative.resolve('@deepseek-ai/dsh-api-workspace-controller')), 'types', 'feed.js')).href)
    return { ctx, feed: new WorkspaceFeed(ctx), commands: new WorkspaceCommands(ctx), close: async () => { await ctx.fiber.dispose(); await backend.close() } }
  }
  const first = await boot()
  cleanups.push(first.close)
  const snapshots = []
  const response = new EventEmitter()
  response.writeHead = () => {}
  response.end = () => {}
  response.write = frame => { if (frame.startsWith('data: ')) snapshots.push(JSON.parse(frame.slice(6)).value); return true }
  const stop = streamWorkspaceEvents({ owner: {}, res: response,
    workspaces: {controller: first.feed, baseline: async () => first.feed.baseline()}, subscribe: () => () => {} })
  cleanups.push(stop)
  await expect.poll(() => snapshots.length).toBeGreaterThan(0)
  const original = first.ctx.workspaceRegistry.list()[0]
  expect(original.sessionIds).toEqual(['session-b', 'session-a'])
  const created = await first.commands.create({ path: b })
  await first.commands.rename({ workspaceId: created.workspace.workspaceId, title: '证据' })
  await first.commands.insertSessionBefore({ workspaceId: original.id, sessionId: 'session-a', beforeSessionId: 'session-b' })
  await first.commands.pinSession({ sessionId: 'session-a' })
  await first.commands.archiveSession({ sessionId: 'session-a' })
  await expect.poll(() => snapshots.at(-1)?.archivedSessionIds).toEqual(['session-a'])
  expect(snapshots.at(-1).items.find(item => item.workspaceId === created.workspace.workspaceId).title).toBe('证据')
  expect(first.ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
  expect(first.ctx.workspaceRegistry.archivedSessionIds).toEqual(['session-a'])
  stop(); cleanups.pop()
  await first.close(); cleanups.pop()
  const restored = await boot()
  cleanups.push(restored.close)
  snapshots.length = 0
  let ended = false
  response.end = () => { ended = true }
  const stopRestored = streamWorkspaceEvents({ owner: {}, res: response,
    workspaces: {controller: restored.feed, baseline: async () => restored.feed.baseline()}, subscribe: () => () => {} })
  cleanups.push(stopRestored)
  await expect.poll(() => snapshots.at(-1)?.archivedSessionIds).toEqual(['session-a'])
  expect(restored.ctx.workspaceRegistry.list().find(value => value.id === original.id).sessionIds).toEqual(['session-a', 'session-b'])
  expect(restored.ctx.workspaceRegistry.archivedSessionIds).toEqual(['session-a'])
  await restored.commands.unarchiveSession({ sessionId: 'session-a' })
  await restored.commands.delete({ workspaceId: created.workspace.workspaceId })
  expect((await stat(b)).isDirectory()).toBe(true)
  expect(restored.ctx.workspaceRegistry.archivedSessionIds).toEqual([])
  await expect.poll(() => snapshots.at(-1)?.archivedSessionIds).toEqual([])
  await restored.close()
  await expect.poll(() => ended).toBe(true)
  cleanups.pop(); cleanups.pop()
})
