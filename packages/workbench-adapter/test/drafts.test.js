import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchService } from '../src/service.js'
import { directoryName } from '../src/drafts.js'

const databases = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.useRealTimers() })
function fixture() {
  const database = new WorkbenchDatabase(':memory:'); databases.push(database)
  const owner = { ownerId: 'owner' }, id = `draft:${randomUUID()}`, files = new Map(), allocations = new Map(), agents = new Map()
  const fileManager = { operate: vi.fn(async ({ operation, path, allocation_id, unique }) => {
    if (operation === 'stat') return files.has(path) ? { kind: 'directory', version: 'v1' } : { kind: 'missing' }
    if (operation === 'list') { if (!files.has(path)) throw new Error('missing directory'); return { entries: [] } }
    if (operation === 'mkdir') {
      if (allocations.has(allocation_id)) return { path: allocations.get(allocation_id) }
      const base = path; let suffix = 1
      while (unique && files.has(path)) path = `${base}-${++suffix}`
      files.set(path, 'directory')
      if (allocation_id) allocations.set(allocation_id, path)
      return { path }
    }
    if (operation === 'delete') {
      for (const entry of files.keys()) if (entry === path || entry.startsWith(`${path}/`)) files.delete(entry)
      return { deleted: true }
    }
  }) }
  const sessions = { create: vi.fn(async ({ sessionId, cwd }) => {
    if (!agents.has(sessionId)) agents.set(sessionId, { id: sessionId, session: { header: { id: sessionId, cwd } }, cwd,
      cancel: vi.fn(), whenIdle: async () => {} })
    return { sessionId }
  }), resolveAgent: vi.fn(async sessionId => ({ agent: agents.get(sessionId) })) }
  const workingDirectory = { set: vi.fn(async (agent, cwd) => { agent.cwd = cwd }), get: session => agents.get(session.header.id)?.cwd }
  const service = new WorkbenchService({ database, agents, sessionController: sessions, fileManager, workingDirectory, workspace: '/workspace',
    platformClient: { json: async () => ({ data: { fenced: true } }) } })
  service.adoptDraftResources = vi.fn(async () => {})
  service.closeDraftResources = vi.fn(async () => {})
  service.closeBrowsers = vi.fn(async () => {})
  service.permanentDeletion = { prepare: async chat => [chat.sessionId], erase: vi.fn(async ({ sessionIds }) => sessionIds.forEach(value => agents.delete(value))) }
  const submit = (prompt = '融资租赁合同纠纷', target = id, workspaceId) =>
    service.createChat(owner, '/workspace', {}, workspaceId, undefined, target, { kind: 'message', prompt })
  return { database, owner, id, files, agents, fileManager, sessions, service, workingDirectory, submit }
}

it.each([
  ['你好', 'new-chat'], ['融资租赁合同纠纷', 'new-chat'], ['Review The 2026 Report please now more', 'review-the-2026-report-please-now'],
])('names %s without an asynchronous naming request', (prompt, expected) => expect(directoryName(prompt)).toBe(expected))

it.each(['hyphenated', 'compact'])('opens %s draft tools in the date directory without a business chat or child directory', async format => {
  const f = fixture()
  if (format === 'compact') f.id = f.id.replaceAll('-', '')
  const first = await f.service.drafts.resources(f.owner, f.id)
  expect(first.directory).toMatch(/^conversations\/\d{4}-\d{2}-\d{2}$/)
  expect([...f.files.keys()]).toEqual([first.directory])
  expect(f.database.listChats('owner')).toEqual([])
  expect(await f.service.drafts.resources(f.owner, f.id)).toEqual(first)
  expect(f.sessions.create).toHaveBeenCalledOnce()
  expect(() => f.service.resourceContext({ ownerId: 'other' }, f.id)).toThrow('草稿资源不存在')
})

it('adopts the same native session and preserves its original directory through refresh', async () => {
  const f = fixture(), resource = await f.service.drafts.resources(f.owner, f.id)
  f.files.set(`${resource.directory}/manual.txt`, 'manual')
  const chat = await f.submit(), agent = f.agents.get(chat.sessionId)
  expect(chat.sessionId).toBe(resource.sessionId)
  expect(chat.directory).toBe(`${resource.directory}/new-chat`)
  expect(agent.session.header.cwd).toBe(`/workspace/${resource.directory}`)
  expect(agent.cwd).toBe(`/workspace/${chat.directory}`)
  expect(f.service.resourceContext(f.owner, f.id).id).toBe(chat.id)
  await f.service.ensureChatSession(f.owner, chat)
  expect(f.sessions.create).toHaveBeenCalledOnce()
  expect(f.files.get(`${resource.directory}/manual.txt`)).toBe('manual')
  expect(f.service.adoptDraftResources).toHaveBeenCalledWith(f.owner, f.id, chat)
})

it('serializes simultaneous submissions and replays a lost creation response without reallocating', async () => {
  const f = fixture()
  const [first, second] = await Promise.all([f.submit(), f.submit()])
  expect(first.id).toBe(second.id)
  expect(await f.submit()).toEqual(first)
  expect(f.database.listChats('owner')).toHaveLength(1)
  expect(f.fileManager.operate.mock.calls.filter(([value]) => value.unique)).toHaveLength(1)
  expect(f.sessions.create).toHaveBeenCalledOnce()
})

it('resumes a failed native creation from the reserved path and original submission name', async () => {
  const f = fixture()
  f.sessions.create.mockRejectedValueOnce(new Error('native unavailable'))
  await expect(f.submit('Review report')).rejects.toThrow('native unavailable')
  const reserved = f.database.draft('owner', f.id).directory
  const chat = await f.submit('Changed prompt')
  expect(chat.directory).toBe(reserved)
  expect(reserved.endsWith('/review-report')).toBe(true)
  expect(f.fileManager.operate.mock.calls.filter(([value]) => value.unique)).toHaveLength(1)
})

it('replays resource adoption after publishing a chat and never duplicates the accepted submission', async () => {
  const f = fixture()
  f.service.adoptDraftResources.mockRejectedValueOnce(new Error('interrupted'))
  await expect(f.submit()).rejects.toThrow('interrupted')
  const chat = await f.submit()
  expect(f.database.listChats('owner').map(value => value.id)).toEqual([chat.id])
  expect(f.service.adoptDraftResources).toHaveBeenCalledTimes(2)
})

it('anchors an opened tool to its date across midnight', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-26T15:59:00Z'))
  const f = fixture(), resource = await f.service.drafts.resources(f.owner, f.id)
  vi.setSystemTime(new Date('2026-10-26T16:01:00Z'))
  expect((await f.submit()).directory).toBe(`${resource.directory}/new-chat`)
  expect(resource.directory).toBe('conversations/2026-10-26')
})

it('keeps an existing project directory and attaches the native session only on submission', async () => {
  const f = fixture()
  f.files.set('conversations/cases', 'directory')
  f.service.workspaces = { requireWorkspace: async () => ({ workspaceId: 'cases', path: 'cases' }),
    controller: { insertSessionBefore: vi.fn(async () => {}) } }
  const resource = await f.service.drafts.resources(f.owner, f.id, 'cases')
  expect(f.service.workspaces.controller.insertSessionBefore).not.toHaveBeenCalled()
  const chat = await f.submit('a task', f.id, 'cases')
  expect(chat.directory).toBe('conversations/cases')
  expect(chat.sessionId).toBe(resource.sessionId)
  expect([...f.files.keys()]).toEqual(['conversations/cases'])
  expect(f.service.workspaces.controller.insertSessionBefore).toHaveBeenCalledWith({ workspaceId: 'cases', sessionId: chat.sessionId })
})

it('rejects empty submissions before any native session or directory is created', async () => {
  const f = fixture()
  await expect(f.submit('')).rejects.toMatchObject({ status: 400 })
  expect(f.files.size).toBe(0)
  expect(f.sessions.create).not.toHaveBeenCalled()
  expect(f.database.listChats('owner')).toEqual([])
  expect(f.database.drafts('owner')).toEqual([])
})

it('retries an interrupted project attachment on the same published chat', async () => {
  const f = fixture(), insertSessionBefore = vi.fn().mockRejectedValueOnce(new Error('interrupted')).mockResolvedValue(undefined)
  f.service.workspaces = { requireWorkspace: async () => ({ workspaceId: 'cases', path: 'cases' }), controller: { insertSessionBefore } }
  await expect(f.submit('task', f.id, 'cases')).rejects.toThrow('interrupted')
  const chat = await f.submit('task', f.id, 'cases')
  await f.submit('task', f.id, 'cases')
  expect(insertSessionBefore).toHaveBeenCalledTimes(2)
  expect(f.database.listChats('owner').map(value => value.id)).toEqual([chat.id])
  expect(f.sessions.create).toHaveBeenCalledOnce()
})

it('deletes a folder with draft resources using the ordinary file action and fences late requests', async () => {
  const f = fixture(), resource = await f.service.drafts.resources(f.owner, f.id)
  f.files.set(`${resource.directory}/manual.txt`, 'manual')
  await f.service.directories.deleteFile(f.owner, resource.directory, 'v1')
  expect(f.service.closeDraftResources).toHaveBeenCalledOnce()
  expect(f.service.permanentDeletion.erase).toHaveBeenCalledWith({ sessionIds: [resource.sessionId] })
  expect(f.files.size).toBe(0)
  expect(f.database.listChats('owner')).toEqual([])
  await expect(f.submit()).rejects.toMatchObject({ status: 410 })
  await expect(f.service.drafts.resources(f.owner, f.id)).rejects.toMatchObject({ status: 410 })
})

it('retains files and a retryable deletion when native cleanup fails', async () => {
  const f = fixture(), resource = await f.service.drafts.resources(f.owner, f.id)
  f.service.permanentDeletion.erase.mockRejectedValueOnce(new Error('cleanup failed'))
  await expect(f.service.directories.deleteFile(f.owner, resource.directory, 'v1')).rejects.toThrow('cleanup failed')
  expect(f.files.has(resource.directory)).toBe(true)
  await expect(f.service.drafts.resources(f.owner, f.id)).rejects.toMatchObject({ status: 409 })
  await f.service.directories.deleteFile(f.owner, resource.directory, 'v1')
  expect(f.files.size).toBe(0)
  expect(f.database.pendingWorkspaceDeletions('owner')).toEqual([])
})

it('keeps a draft usable after deleting a file or child folder below its tool directory', async () => {
  const f = fixture(), resource = await f.service.drafts.resources(f.owner, f.id)
  for (const name of ['manual.txt', 'unbound-child']) {
    f.files.set(`${resource.directory}/${name}`, 'fixture')
    await f.service.directories.deleteFile(f.owner, `${resource.directory}/${name}`, 'v1')
  }
  expect(f.service.closeDraftResources).not.toHaveBeenCalled()
  expect(f.service.permanentDeletion.erase).not.toHaveBeenCalled()
  expect((await f.submit()).sessionId).toBe(resource.sessionId)
})

it('closes project drafts during workspace deletion and rejects stale project drafts before publishing a chat', async () => {
  const f = fixture(), items = [{ workspaceId: 'cases', path: 'cases', sessionIds: [] }]
  f.service.workspaces = { baseline: async () => ({ items }), requireWorkspace: vi.fn(async () => {
    if (!items.length) throw Object.assign(new Error('工作区不存在'), { status: 404 })
    return items[0]
  }), controller: { delete: async () => { items.length = 0 }, insertSessionBefore: vi.fn() } }
  const resource = await f.service.drafts.resources(f.owner, f.id, 'cases')
  await f.service.directories.deleteWorkspace(f.owner, 'cases')
  expect(f.service.permanentDeletion.erase).toHaveBeenCalledWith({ sessionIds: [resource.sessionId] })
  await expect(f.submit('task', f.id, 'cases')).rejects.toMatchObject({ status: 410 })
  expect(f.database.listChats('owner')).toEqual([])
  const stale = `draft:${randomUUID()}`
  f.database.saveDraft('owner', { id: stale, workspaceId: 'cases', base: 'conversations/cases' })
  await expect(f.submit('task', stale, 'cases')).rejects.toMatchObject({ status: 404 })
  expect(f.database.listChats('owner')).toEqual([])
  expect(f.files.has('conversations/cases')).toBe(false)
})

it('protects a date containing a valid chat before stopping any other draft resources', async () => {
  const f = fixture(), resource = await f.service.drafts.resources(f.owner, f.id)
  await f.submit('Task', `draft:${randomUUID()}`)
  await expect(f.service.directories.deleteFile(f.owner, resource.directory, 'v1')).rejects.toMatchObject({ code: 'DIRECTORY_IN_USE' })
  expect(f.service.closeDraftResources).not.toHaveBeenCalled()
  expect(f.files.has(resource.directory)).toBe(true)
})

it('removes legacy soft-deleted bindings and closes their browsers before ordinary folder deletion', async () => {
  const f = fixture(), chat = await f.submit()
  f.database.db.prepare('UPDATE chats SET deleted_at=1 WHERE id=?').run(chat.id)
  await f.service.directories.deleteFile(f.owner, chat.directory, 'v1')
  expect(f.database.directoryChats('owner')).toEqual([])
  expect(f.files.has(chat.directory)).toBe(false)
  expect(f.service.closeBrowsers).toHaveBeenCalledWith(f.owner, chat.id)
})

it('does not close or erase a submitted chat on a late draft disposal', async () => {
  const f = fixture(), chat = await f.submit()
  await f.service.drafts.close(f.owner, f.id)
  expect(f.database.getChat('owner', chat.id)).toBeDefined()
  expect(f.service.permanentDeletion.erase).not.toHaveBeenCalled()
})

it('rolls back chat publication when saving its draft binding fails and retries the same session', async () => {
  const f = fixture(), resource = await f.service.drafts.resources(f.owner, f.id)
  const save = f.database.saveDraft.bind(f.database)
  const interrupted = vi.spyOn(f.database, 'saveDraft').mockImplementation((ownerId, draft) => {
    if (draft.bound) throw new Error('binding save interrupted')
    return save(ownerId, draft)
  })
  await expect(f.submit()).rejects.toThrow('binding save interrupted')
  const reserved = f.database.draft('owner', f.id)
  expect(f.database.listChats('owner')).toEqual([])
  expect(reserved.bound).toBeUndefined()
  interrupted.mockRestore()
  const chat = await f.submit()
  expect(chat.sessionId).toBe(resource.sessionId)
  expect(chat.directory).toBe(reserved.directory)
  expect(f.database.listChats('owner')).toHaveLength(1)
  expect(f.database.draft('owner', f.id).bound).toBe(true)
})

it('preserves a live chat session when an older draft binding was interrupted', async () => {
  const f = fixture(), resource = await f.service.drafts.resources(f.owner, f.id)
  const draft = f.database.draft('owner', f.id)
  const chat = f.database.createChat({ id: draft.chatId, ownerId: 'owner', sessionId: draft.sessionId,
    selection: {}, directory: `${draft.base}/new-chat` })
  await f.service.drafts.close(f.owner, f.id)
  expect(f.database.getChat('owner', chat.id)).toBeDefined()
  expect(f.agents.has(resource.sessionId)).toBe(true)
  expect(f.service.closeDraftResources).not.toHaveBeenCalled()
  expect(f.service.permanentDeletion.erase).not.toHaveBeenCalled()
})
