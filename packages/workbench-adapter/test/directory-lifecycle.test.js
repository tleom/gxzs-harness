import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchService } from '../src/service.js'
import { WorkbenchWorkspaces } from '../src/workspaces.js'

const cleanups = []
it('rejects unsupported entries without leaving a directory deletion lock', async () => {
  const f = fixture(), source = 'conversations/2026-10-26/link'
  f.fileManager.operate.mockResolvedValue({ kind: 'blocked', version: null })
  await expect(f.service.directories.deleteFile(f.owner, source, null)).rejects.toMatchObject({ code: 'FILE_TYPE_UNSUPPORTED' })
  expect(f.db.pendingWorkspaceDeletions(f.owner.ownerId)).toEqual([])
  expect(() => f.service.directories.assertAvailable(f.owner, 'conversations/2026-10-26')).not.toThrow()
  expect(f.fileManager.operate).toHaveBeenCalledTimes(1)
})
it('retains the caller file version across native writes and retries', async () => {
  const f = fixture(), source = 'conversations/2026-10-26/note.txt'
  let currentVersion = 'v2'
  f.fileManager.operate.mockImplementation(async request => {
    if (request.operation === 'stat') return { kind: 'file', version: currentVersion }
    expect(request).toEqual({ operation: 'delete', path: source, version: 'v1' })
    if (request.version !== currentVersion) throw Object.assign(new Error('changed'), { code: 'FILE_VERSION_CONFLICT' })
    return { deleted: true }
  })
  await expect(f.service.directories.deleteFile(f.owner, source, 'v1')).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
  currentVersion = 'v3'
  await expect(f.service.directories.deleteFile(f.owner, source, 'v1')).rejects.toMatchObject({ code: 'FILE_VERSION_CONFLICT' })
  expect(f.db.pendingWorkspaceDeletions(f.owner.ownerId)).toEqual([])
})
it('moves ordinary files but preserves registered conversation directories and their ancestors', async () => {
  const f = fixture(); f.chat('owner')
  await f.service.directories.transferFile(f.owner, 'move', 'conversations/2026-10-22/original/nested/delivery.docx', 'delivery.docx')
  expect(f.fileManager.operate).toHaveBeenLastCalledWith({operation:'move',path:'conversations/2026-10-22/original/nested/delivery.docx',destination:'delivery.docx'})
  for (const source of ['conversations/2026-10-22/original','conversations/2026-10-22'])
    await expect(f.service.directories.transferFile(f.owner,'move',source,'renamed')).rejects.toMatchObject({code:'DIRECTORY_IN_USE'})
  await f.service.directories.transferFile(f.owner,'copy','conversations/2026-10-22/original','copied')
  expect(f.fileManager.operate).toHaveBeenLastCalledWith({operation:'copy',path:'conversations/2026-10-22/original',destination:'copied'})
})
afterEach(() => cleanups.splice(0).reverse().forEach(close => close()))

it('limits an active task lock to its descendants while keeping sibling workspaces editable', async () => {
  const f = fixture(), root = 'conversations/2026-10-25/active'
  const chat = f.chat('active', root)
  f.chat('idle', `${root}-other`)
  const { run } = f.db.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: chat.sessionId, query: 'work', selection: {} })
  f.db.transitionRun('owner', run.id, 'running')
  for (const source of [`${root}-other/nested/file.txt`, `${root}-other/nested`, 'unrelated/file.txt']) {
    await f.service.directories.transferFile(f.owner, 'move', source, `${source}-renamed`)
    await f.service.directories.transferFile(f.owner, 'move', source, 'archive/moved')
    await f.service.directories.deleteFile(f.owner, source, 'v1')
  }
  expect(f.fileManager.operate.mock.calls.filter(([input]) => ['move', 'delete'].includes(input.operation))).toHaveLength(7)
  for (const source of [root, 'conversations/2026-10-25']) {
    await expect(f.service.directories.deleteFile(f.owner, source, 'v1')).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE', message: expect.stringMatching(/^文件夹包含会话：.+，请先删除会话$/) })
    await expect(f.service.directories.transferFile(f.owner, 'move', source, 'archive/moved')).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE', message: '文件已绑定会话，暂不可移动' })
  }
  await expect(f.service.directories.deleteFile(f.owner, `${root}/nested`, 'v1')).resolves.toEqual({ deleted: true })
  expect(f.db.getChat('owner', chat.id)).toBeDefined()
  expect(f.db.activeRun('owner', chat.id)?.id).toBe(run.id)
  expect(f.files.has(`${root}/nested/delivery.docx`)).toBe(false)
})

it.each(['queued', 'running', 'waiting_input', 'stopping'])('protects active conversation files for %s without blocking copy', async status => {
  const f = fixture(); const chat = f.chat('active')
  const { run } = f.db.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: chat.sessionId, query: 'work', selection: {} })
  f.db.transitionRun('owner', run.id, status)
  const source = `${chat.directory}/nested/delivery.docx`
  for (const [destination, label] of [[`${chat.directory}/nested/renamed.docx`, '重命名'], ['archive/delivery.docx', '移动']]) {
    await expect(f.service.directories.transferFile(f.owner, 'move', source, destination)).rejects.toMatchObject({ status: 409, code: 'FILE_IN_USE', message: `任务正在执行中，暂不可${label}` })
  }
  await expect(f.service.directories.deleteFile(f.owner, source, 'v1')).rejects.toMatchObject({ code: 'FILE_IN_USE', message: '任务正在执行中，暂不可删除' })
  expect(f.fileManager.operate).toHaveBeenCalledExactlyOnceWith({ operation: 'stat', path: source })
  await f.service.directories.transferFile(f.owner, 'copy', source, 'archive/copied.docx')
  expect(f.fileManager.operate).toHaveBeenLastCalledWith({ operation: 'copy', path: source, destination: 'archive/copied.docx' })
  await f.service.directories.transferFile(f.owner, 'move', 'outside.txt', `${chat.directory}/incoming.txt`)
  expect(f.fileManager.operate).toHaveBeenLastCalledWith({ operation: 'move', path: 'outside.txt', destination: `${chat.directory}/incoming.txt` })
  await f.service.directories.deleteFile(f.owner, 'unrelated/file.txt', 'v1')
  expect(f.fileManager.operate).toHaveBeenLastCalledWith({ operation: 'stat', path: 'unrelated/file.txt' })
  f.db.transitionRun('owner', run.id, 'completed')
  await f.service.directories.transferFile(f.owner, 'move', source, 'archive/delivery.docx')
})

it.each(['native-root', 'native-child'])('keeps files protected while %s is still executing', async mode => {
  const f = fixture(); const chat = f.chat('active')
  f.files.set(`${chat.directory}/a.txt`, 'contents')
  if (mode === 'native-root') f.agent.status = 'running'
  else f.service.hasOwnedWork = sessionId => sessionId === chat.sessionId
  await expect(f.service.directories.transferFile(f.owner, 'move', `${chat.directory}/a.txt`, `${chat.directory}/b.txt`)).rejects.toMatchObject({ code: 'FILE_IN_USE', message: '任务正在执行中，暂不可重命名' })
  await expect(f.service.directories.deleteFile(f.owner, `${chat.directory}/a.txt`, 'v1')).rejects.toMatchObject({ code: 'FILE_IN_USE' })
  expect(f.fileManager.operate).toHaveBeenCalledExactlyOnceWith({ operation: 'stat', path: `${chat.directory}/a.txt` })
})

it('deletes an empty registered workspace or its parent through the ordinary file action', async () => {
  for (const source of ['conversations/cases/nested', 'conversations/cases']) {
    const f = fixture(); f.workspace('nested', 'cases/nested')
    const parent = source.slice(0, source.lastIndexOf('/'))
    for (const [destination, label] of [[`${parent}/renamed`, '重命名'], ['archive/moved', '移动']])
      await expect(f.service.directories.transferFile(f.owner, 'move', source, destination)).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE', message: `文件已绑定会话，暂不可${label}` })
    await f.service.directories.deleteFile(f.owner, source, 'v1')
    expect(f.files.size).toBe(0)
    expect(f.controller.delete).toHaveBeenCalledWith({ workspaceId: 'nested' })
  }
})

it.each(['conversation', 'workspace'])('allows ordinary descendants of an inactive %s to be renamed, moved and deleted', async binding => {
  for (const child of ['nested', 'nested/file.txt']) {
    for (const operation of ['rename', 'move', 'delete']) {
      const f = fixture(), root = 'conversations/cases'
      if (binding === 'workspace') f.workspace()
      else {
        const chat = f.chat('inactive', root)
        const { run } = f.db.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: chat.sessionId, query: 'finished', selection: {} })
        f.db.transitionRun('owner', run.id, 'completed')
      }
      const source = `${root}/${child}`
      f.files.set(source, child.includes('.') ? 'contents' : 'directory')
      if (operation === 'delete') {
        await f.service.directories.deleteFile(f.owner, source, 'v1')
        expect(f.fileManager.operate).toHaveBeenLastCalledWith({ operation: 'delete', path: source, version: 'v1' })
      } else {
        const destination = operation === 'rename' ? `${source}-renamed` : `archive/${child.split('/').at(-1)}`
        await f.service.directories.transferFile(f.owner, 'move', source, destination)
        expect(f.fileManager.operate).toHaveBeenLastCalledWith({ operation: 'move', path: source, destination })
      }
      expect(f.files.has(root)).toBe(true)
      f.fileManager.operate.mockClear()
      if (binding === 'conversation') {
        await expect(f.service.directories.deleteFile(f.owner, root, 'v1')).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
        expect(f.fileManager.operate).not.toHaveBeenCalled()
      } else {
        await f.service.directories.deleteFile(f.owner, root, 'v1')
        expect(f.files.has(root)).toBe(false)
      }
    }
  }
})

function fixture(database) {
  const db = database ?? new WorkbenchDatabase(':memory:')
  if (!database) cleanups.push(() => db.close())
  const owner = { ownerId: 'owner' }, items = []
  const agent = { cancel: vi.fn(), whenIdle: vi.fn(async () => {}) }
  const files = new Map()
  const fileManager = { operate: vi.fn(async ({ operation, path }) => {
    if (operation === 'stat') return files.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`))
      ? { kind: files.has(path) && files.get(path) !== 'directory' ? 'file' : 'directory', version: 'v1' } : { kind: 'missing' }
    if (operation === 'delete') { for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key); return { deleted: true } }
    if (operation === 'mkdir') files.set(path, 'directory')
    return { entries: [] }
  }) }
  const service = new WorkbenchService({ database: db, fileManager, workspace: '/workspace', agents: { get: () => agent },
    sessionController: { create: vi.fn(async () => ({ sessionId: 'new-session' })) },
    platformClient: { json: async () => ({ data: { fenced: true } }) } })
  service.scheduler = { deletingChats: new Set(), request: vi.fn() }
  service.permanentDeletion = { prepare: async chat => [chat.sessionId], erase: vi.fn(async () => {}) }
  const controller = {
    follow: async function* () { yield { type: 'baseline', value: { items, archivedSessionIds: [], pinnedSessionIds: [] } } },
    archiveSession: vi.fn(async () => {}),
    delete: vi.fn(async ({ workspaceId }) => { const at = items.findIndex(item => item.workspaceId === workspaceId); if (at >= 0) items.splice(at, 1) }),
  }
  const workspaces = new WorkbenchWorkspaces({ controller, database: db, root: '/workspace/conversations', fileManager })
  workspaces.service = service; service.workspaces = workspaces
  const chat = (id, directory = 'conversations/2026-10-22/original') => {
    files.set(directory, 'directory'); files.set(`${directory}/nested/delivery.docx`, 'contents')
    return db.createChat({ id, ownerId: owner.ownerId, sessionId: `session-${id}`, directory, selection: {} })
  }
  const workspace = (id = 'ws', directory = 'cases') => {
    const relative = `conversations/${directory}`
    files.set(relative, 'directory'); files.set(`${relative}/nested/file.txt`, 'contents')
    items.push({ workspaceId: id, path: `/workspace/${relative}`, sessionIds: [], title: id })
  }
  return { db, owner, service, workspaces, controller, agent, fileManager, files, chat, workspace }
}

it.each([['original', 'fork', 'fork2'], ['fork2', 'fork', 'original'], ['fork', 'original', 'fork2']])('removes the shared tree only after all references in order %j are deleted', async (...order) => {
  const f = fixture()
  for (const id of order) f.chat(id)
  for (const [index, id] of order.entries()) {
    await f.service.deleteChat(f.owner, id)
    expect(f.files.has('conversations/2026-10-22/original/nested/delivery.docx')).toBe(index < order.length - 1)
  }
  expect(f.fileManager.operate.mock.calls.filter(([input]) => input.operation === 'delete')).toHaveLength(1)
})

it('serializes concurrent last-reference deletions and keeps adjacent prefixes intact', async () => {
  const f = fixture(); f.chat('original'); f.chat('fork'); f.chat('neighbor', 'conversations/2026-10-22/original-other')
  await Promise.all(['original', 'fork'].map(id => f.service.deleteChat(f.owner, id)))
  expect(f.files.has('conversations/2026-10-22/original')).toBe(false)
  expect(f.files.has('conversations/2026-10-22/original-other/nested/delivery.docx')).toBe(true)
})

it('retains the cleanup path when an original deletion fails before the last fork is deleted', async () => {
  const f = fixture(); f.chat('original'); f.chat('fork')
  f.service.permanentDeletion.erase.mockRejectedValueOnce(new Error('native storage failed'))
  await expect(f.service.deleteChat(f.owner, 'original')).rejects.toThrow('native storage failed')
  await f.service.deleteChat(f.owner, 'fork')
  expect(f.files.has('conversations/2026-10-22/original')).toBe(true)
  await f.service.deleteChat(f.owner, 'original')
  expect(f.files.has('conversations/2026-10-22/original')).toBe(false)
})

it('keeps the project on chat deletion and lets a subsequent file deletion remove it normally', async () => {
  const f = fixture(); f.workspace(); f.chat('chat', 'conversations/cases')
  await f.service.deleteChat(f.owner, 'chat')
  expect(f.files.has('conversations/cases/nested/delivery.docx')).toBe(true)
  await f.service.directories.deleteFile(f.owner, 'conversations/cases', 'v1')
  expect(f.files.size).toBe(0)
  expect(f.controller.delete).toHaveBeenCalledWith({ workspaceId: 'ws' })
})

it.each(['conversations/2026-10-22/original', '/workspace/conversations/2026-10-22/original', 'conversations/2026-10-22', 'conversations/2026-10-22/x/../original'])('protects live fork roots and ancestors: %s', async candidate => {
  const f = fixture(); f.chat('fork')
  await expect(f.service.directories.deleteFile(f.owner, candidate, 'v1')).rejects.toMatchObject({ status: 409, code: 'DIRECTORY_IN_USE', message: expect.stringMatching(/^文件夹包含会话：.+，请先删除会话$/) })
  expect(f.fileManager.operate).not.toHaveBeenCalled()
})

it('allows deleting ordinary child files and unrelated directories', async () => {
  const f = fixture(); f.chat('fork')
  await f.service.directories.deleteFile(f.owner, 'conversations/2026-10-22/original/nested', 'v1')
  expect(f.files.has('conversations/2026-10-22/original')).toBe(true)
  expect(f.files.has('conversations/2026-10-22/original/nested/delivery.docx')).toBe(false)
  await f.service.directories.deleteFile(f.owner, 'conversations/unused', 'v1')
})

it('deletes workspace conversations, forks, nested workspaces and files while retaining a sibling', async () => {
  const f = fixture(); f.workspace(); f.workspace('child', 'cases/child'); f.workspace('other', 'cases-other')
  f.chat('a', 'conversations/cases'); f.chat('fork', 'conversations/cases'); f.chat('nested', 'conversations/cases/child'); f.chat('other', 'conversations/cases-other')
  await f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })
  expect(f.db.listChats('owner').map(row => row.id)).toEqual(['other'])
  expect([...f.files.keys()].every(path => path.startsWith('conversations/cases-other'))).toBe(true)
  expect(f.controller.delete.mock.calls.map(([input]) => input.workspaceId)).toEqual(['child', 'ws'])
  expect(f.db.pendingWorkspaceDeletions('owner')).toEqual([])
  await expect(f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })).resolves.toMatchObject({ items: [expect.objectContaining({ workspaceId: 'other' })] })
})

it('keeps durable scope after restart and retries only the remaining work', async () => {
  const root = mkdtempSync(resolve('../workspace-deletion-db-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const filename = resolve(root, 'workbench.sqlite')
  let db = new WorkbenchDatabase(filename)
  cleanups.push(() => db.close())
  const f = fixture(db); f.workspace(); f.chat('a', 'conversations/cases'); f.chat('b', 'conversations/cases')
  f.service.permanentDeletion.erase.mockRejectedValueOnce(new Error('offline'))
  await expect(f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })).rejects.toThrow('offline')
  expect(f.files.has('conversations/cases/nested/delivery.docx')).toBe(true)
  const surviving = db.listChats('owner')[0]
  expect(() => f.service.requireChat(f.owner, surviving.id)).toThrow('工作区正在删除')
  db.close(); db = new WorkbenchDatabase(filename); f.service.database = db; f.workspaces.database = db
  await f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })
  expect(db.listChats('owner')).toEqual([])
  expect(f.files.size).toBe(0)
  expect(db.pendingWorkspaceDeletions('owner')).toEqual([])
})

it('does not remove the registration or acknowledge completion after a file delete failure', async () => {
  const f = fixture(); f.workspace(); f.chat('a', 'conversations/cases')
  const original = f.fileManager.operate.getMockImplementation()
  f.fileManager.operate.mockImplementation(async input => { if (input.operation === 'delete') throw new Error('disk failure'); return original(input) })
  await expect(f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })).rejects.toThrow('disk failure')
  expect(f.controller.delete).not.toHaveBeenCalled()
  expect(f.db.pendingWorkspaceDeletions('owner')).toHaveLength(1)
  f.fileManager.operate.mockImplementation(original)
  await f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })
  expect(f.files.size).toBe(0)
})

it('blocks new owners of a path while the previous workspace deletion is incomplete', async () => {
  const f = fixture(); f.workspace()
  f.db.beginWorkspaceDeletion('owner', 'ws', { path: 'conversations/cases', chatIds: [], workspaceIds: ['ws'] })
  expect(() => f.service.directories.assertAvailable(f.owner, 'conversations/cases')).toThrow('工作区正在删除')
  expect(() => f.service.directories.assertAvailable(f.owner, 'conversations/cases/child')).toThrow('工作区正在删除')
  expect(() => f.service.directories.assertAvailable(f.owner, 'conversations/cases-other')).not.toThrow()
})

it('isolates deletion receipts by owner and refuses out-of-root targets', async () => {
  const f = fixture(); f.workspace(); f.chat('a', 'conversations/cases')
  await expect(f.service.deleteChat({ ownerId: 'foreign' }, 'a')).rejects.toMatchObject({ status: 404 })
  await expect(f.service.directories.deleteFile(f.owner, '../secret', 'v1')).rejects.toMatchObject({ status: 403 })
  f.db.beginWorkspaceDeletion('owner', 'ws', { path: 'conversations/cases', chatIds: ['a'], workspaceIds: ['ws'] })
  expect(f.db.workspaceDeletion('foreign', 'ws')).toBeUndefined()
  expect(f.db.pendingWorkspaceDeletions('foreign')).toEqual([])
  expect(f.files.has('conversations/cases/nested/delivery.docx')).toBe(true)
})

it('does not delete files until a running conversation and its children have stopped', async () => {
  const f = fixture(); f.workspace(); const chat = f.chat('a', 'conversations/cases')
  const { run } = f.db.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: chat.sessionId, query: 'work', selection: {} })
  f.db.transitionRun('owner', run.id, 'running')
  let release
  f.agent.whenIdle.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const deletion = f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  expect(f.files.has('conversations/cases/nested/delivery.docx')).toBe(true)
  expect(f.fileManager.operate).not.toHaveBeenCalled()
  release(); await deletion
  expect(f.files.size).toBe(0)
})

it('queues a fork behind deletion and rejects it after its source has been erased', async () => {
  const f = fixture(); const chat = f.chat('a')
  const { run } = f.db.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: chat.sessionId, query: 'work', selection: {} })
  f.db.transitionRun('owner', run.id, 'completed')
  let release
  f.agent.whenIdle.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const deletion = f.service.deleteChat(f.owner, chat.id)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const fork = f.service.fork(f.owner, run.id, { request_key: 'late' })
  const rejected = expect(fork).rejects.toMatchObject({ status: 404 })
  release(); await deletion; await rejected
  expect(f.files.size).toBe(0)
})

it('recovers a failed workspace registry removal after its files have already gone', async () => {
  const f = fixture(); f.workspace(); f.chat('a', 'conversations/cases')
  f.controller.delete.mockRejectedValueOnce(new Error('registry unavailable'))
  await expect(f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })).rejects.toThrow('registry unavailable')
  expect(f.files.size).toBe(0)
  expect(f.db.pendingWorkspaceDeletions('owner')).toHaveLength(1)
  await f.workspaces.mutate(f.owner, { operation: 'delete', workspaceId: 'ws' })
  expect(f.db.pendingWorkspaceDeletions('owner')).toEqual([])
})
