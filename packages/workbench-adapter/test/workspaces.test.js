import { describe, expect, it, vi } from 'vitest'
import { WorkbenchWorkspaces } from '../src/workspaces.js'
import { realpath } from 'node:fs/promises'

vi.mock('node:fs/promises', () => ({ realpath: vi.fn(async value => value) }))

function fixture() {
  const chats = [{ id: 'chat-a', sessionId: 'session-a' }, { id: 'chat-b', sessionId: 'session-b' }]
  const baseline = { items: [{ workspaceId: 'workspace-a', path: '/workspace/conversations/cases', title: '案件', sessionIds: ['session-a', 'session-b', 'foreign-session'], createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' },
    { workspaceId: 'outside', path: '/srv/dsh', title: 'host', sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: ['foreign-session'], pinnedSessionIds: ['session-a', 'foreign-session'] }
  const closed = vi.fn()
  const controller = Object.fromEntries(['create', 'rename', 'delete', 'insertBefore', 'insertSessionBefore', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'].map(name => [name, vi.fn()]))
  controller.follow = vi.fn(async function* (signal) { try { yield { type: 'baseline', value: baseline } } finally { closed(signal.aborted) } })
  const database = { listChats: vi.fn(() => chats), getChat: vi.fn((owner, id) => owner === 'owner-a' ? chats.find(chat => chat.id === id) : undefined) }
  const fileManager = { operate: vi.fn(async ({ operation, path }) => {
    if (path === 'conversations' && operation !== 'list') throw new Error('The workspace root can only be listed')
    return { entries: [{ name: 'case-a', kind: 'directory' }, { name: 'file.txt', kind: 'file' }] }
  }) }
  const bridge = new WorkbenchWorkspaces({ controller, database, root: '/workspace/conversations', fileManager })
  return { bridge, controller, closed, fileManager, owner: { ownerId: 'owner-a' } }
}

describe('native workspace boundary', () => {
  it('preserves native session timestamps and projection watermarks while filtering owners and host cwd', async () => {
    const { bridge, owner } = fixture()
    const record = { sessionId: 'session-a', updatedAt: 12345, blank: true, running: false, agentAvailable: false,
      projections: { kind: 'cached', asOfSeq: 7, values: { title: '原生标题' } } }
    bridge.sessions = { list: vi.fn(async () => ({ items: [{ ...record, cwd: '/workspace/conversations/cases' }, { sessionId: 'foreign-session' }] })) }
    expect((await bridge.baseline(owner)).sessions).toEqual([record])
    expect(bridge.sessions.list).toHaveBeenCalledWith({}, expect.any(AbortSignal))
  })
  it('revalidates registered workspace paths before dispatch', async () => {
    const { bridge, owner, controller } = fixture()
    realpath.mockResolvedValueOnce('/workspace/private')
    await expect(bridge.mutate(owner, { operation: 'insertSessionBefore', workspaceId: 'workspace-a', chatId: 'chat-a' })).rejects.toMatchObject({ status: 403 })
    expect(controller.insertSessionBefore).not.toHaveBeenCalled()
  })
  it('reports missing directories without registering them', async () => {
    const { bridge, owner, controller } = fixture()
    realpath.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(bridge.mutate(owner, { operation: 'create', path: 'missing' })).rejects.toMatchObject({ status: 400 })
    expect(controller.create).not.toHaveBeenCalled()
  })
  it('browses and creates only below conversation files', async () => {
    const { bridge, owner, fileManager } = fixture()
    expect(await bridge.mutate(owner, { operation: 'browse', path: '.' })).toEqual({ path: '.', entries: [{ name: 'case-a', path: 'case-a' }] })
    expect(fileManager.operate).toHaveBeenCalledWith({ operation: 'list', path: 'conversations' })
    await bridge.mutate(owner, { operation: 'mkdir', path: '.', name: 'first-folder' })
    expect(fileManager.operate).toHaveBeenCalledWith({ operation: 'mkdir', path: 'conversations/first-folder' })
    await bridge.mutate(owner, { operation: 'mkdir', path: 'case-a', name: '证据' })
    expect(fileManager.operate).toHaveBeenCalledWith({ operation: 'mkdir', path: 'conversations/case-a/证据' })
    await expect(bridge.mutate(owner, { operation: 'mkdir', path: 'case-a', name: '../outside' })).rejects.toMatchObject({ status: 400 })
  })
  it('rejects a canonical target outside conversation files before native registration or directory access', async () => {
    const { bridge, owner, controller, fileManager } = fixture()
    for (const operation of ['browse', 'mkdir', 'create']) {
      realpath.mockResolvedValueOnce('/workspace/private')
      await expect(bridge.mutate(owner, { operation, path: 'link', name: 'new' })).rejects.toMatchObject({ status: 403 })
    }
    expect(controller.create).not.toHaveBeenCalled()
    expect(fileManager.operate).not.toHaveBeenCalled()
  })
  it('projects native membership without exposing Host directories or foreign sessions and disposes the feed', async () => {
    const { bridge, owner, closed } = fixture()
    const result = await bridge.baseline(owner)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ workspaceId: 'workspace-a', path: 'cases', sessionIds: ['session-a', 'session-b'] })
    expect(result.pinnedSessionIds).toEqual(['session-a'])
    expect(result.archivedSessionIds).toEqual([])
    expect(result.chatIds).toEqual({ 'session-a': 'chat-a', 'session-b': 'chat-b' })
    expect(closed).toHaveBeenCalledWith(true)
  })
  it.each(['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'])('delegates %s to the native owner', async operation => {
    const { bridge, controller, owner } = fixture()
    await bridge.mutate(owner, { operation, chatId: 'chat-a', stopActivity: true })
    expect(controller[operation]).toHaveBeenCalledWith({ sessionId: 'session-a', ...(operation === 'archiveSession' ? { stopActivity: true } : {}) })
  })
  it('passes native order identities and omits the optional append anchor', async () => {
    const { bridge, controller, owner } = fixture()
    await bridge.mutate(owner, { operation: 'insertSessionBefore', workspaceId: 'workspace-a', chatId: 'chat-b', beforeChatId: 'chat-a' })
    expect(controller.insertSessionBefore).toHaveBeenCalledWith({ workspaceId: 'workspace-a', sessionId: 'session-b', beforeSessionId: 'session-a' })
    await bridge.mutate(owner, { operation: 'insertBefore', workspaceId: 'workspace-a' })
    expect(controller.insertBefore).toHaveBeenCalledWith({ workspaceId: 'workspace-a', beforeWorkspaceId: undefined })
  })
  it('rejects foreign chat and out-of-root workspace mutations before dispatch', async () => {
    const { bridge, controller, owner } = fixture()
    await expect(bridge.mutate(owner, { operation: 'pinSession', chatId: 'foreign-chat' })).rejects.toMatchObject({ status: 404 })
    await expect(bridge.mutate(owner, { operation: 'delete', workspaceId: 'outside' })).rejects.toMatchObject({ status: 404 })
    await expect(bridge.mutate(owner, { operation: 'create', path: '../srv' })).rejects.toMatchObject({ status: 403 })
    await expect(bridge.mutate(owner, { operation: 'create', path: '/workspace' })).rejects.toMatchObject({ status: 403 })
    await expect(bridge.mutate(owner, { operation: 'create', path: '/workspace/conversations-other' })).rejects.toMatchObject({ status: 403 })
    expect(controller.pinSession).not.toHaveBeenCalled()
    expect(controller.delete).not.toHaveBeenCalled()
    expect(controller.create).not.toHaveBeenCalled()
  })
  it('keeps native errors authoritative instead of reporting a successful mutation', async () => {
    const { bridge, controller, owner } = fixture()
    const error = { isDSHRemoteError: true, code: 'workspace/session-active' }
    controller.archiveSession.mockRejectedValue(error)
    await expect(bridge.mutate(owner, { operation: 'archiveSession', chatId: 'chat-a' })).rejects.toBe(error)
  })
})
