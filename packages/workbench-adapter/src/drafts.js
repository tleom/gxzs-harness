import { randomUUID } from 'node:crypto'
import { containsWorkspacePath } from './paths.js'
import { httpError } from './http.js'

const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
export const isDraftId = id => typeof id === 'string' && id.startsWith('draft:') && uuid.test(id.slice(6))
export const dateDirectory = () => `conversations/${new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())}`
export const directoryName = prompt => (String(prompt ?? '').toLowerCase().match(/[a-z0-9]+/g)?.slice(0, 6).join('-').slice(0, 80)) || 'new-chat'

/** A tool context becomes a business chat only after an explicit submission. */
export class WorkbenchDrafts {
  constructor(service) { this.service = service }
  get db() { return this.service.database }
  get(owner, id) {
    if (!isDraftId(id)) throw httpError(400, '草稿标识无效')
    return this.db.draft(owner.ownerId, id)
  }
  save(owner, draft) { return this.db.saveDraft(owner.ownerId, draft) }
  async prepare(owner, id, workspaceId) {
    let draft = this.get(owner, id)
    if (draft?.closed) throw httpError(410, '草稿资源已经关闭，请重新打开')
    if (draft?.closing) throw httpError(409, '草稿资源正在关闭，请稍后重试')
    if (draft) {
      if (draft.workspaceId !== workspaceId) throw httpError(409, '草稿所属项目已改变，请重新打开会话')
      return draft
    }
    const workspace = workspaceId === undefined ? undefined : await this.service.workspaces?.requireWorkspace(owner, workspaceId, true)
    if (workspaceId !== undefined && !workspace) throw httpError(404, '工作区不存在')
    const base = workspace ? this.service.directories.workspacePath(workspace) : dateDirectory()
    this.service.directories.assertAvailable(owner, base)
    draft = { id, workspaceId, base, sessionId: randomUUID(), chatId: randomUUID() }
    return this.save(owner, draft)
  }
  async native(owner, draft, directory) {
    const { service } = this
    if (service.agents?.get(draft.sessionId)) {
      if (!draft.sessionReady) {
        draft.originalDirectory ??= directory
        draft.sessionReady = true
        this.save(owner, draft)
      }
      return
    }
    if (draft.sessionReady) {
      const resolved = await service.sessions.resolveAgent(draft.sessionId)
      if ('error' in resolved) throw resolved.error
      return
    }
    draft.originalDirectory = directory
    this.save(owner, draft)
    const created = await service.sessions.create({ sessionId: draft.sessionId, cwd: service.chatDirectory(draft.chatId, directory) })
    draft.sessionId = created.sessionId
    draft.sessionReady = true
    this.save(owner, draft)
  }
  resources(owner, id, workspaceId) {
    return this.service.directories.run(owner, async () => {
      const draft = await this.prepare(owner, id, workspaceId)
      if (draft.bound) return this.context(owner, id)
      this.service.directories.assertAvailable(owner, draft.base)
      await this.service.fileManager.operate({ operation: 'mkdir', path: draft.base })
      await this.native(owner, draft, draft.base)
      return this.context(owner, id)
    })
  }
  context(owner, id) {
    if (!isDraftId(id)) return this.service.requireChat(owner, id)
    const draft = this.get(owner, id)
    if (!draft || draft.closed || draft.closing) throw httpError(404, '草稿资源不存在或已经关闭')
    if (draft.bound) return this.service.requireChat(owner, draft.chatId)
    this.service.directories.assertAvailable(owner, draft.base)
    if (!draft.sessionReady) throw httpError(409, '草稿资源尚未就绪')
    return { id, sessionId: draft.sessionId, directory: draft.base }
  }
  async materialize(owner, id, workspaceId, submission, selection) {
    if (!submission || !['message', 'command', 'schedule'].includes(submission.kind)
      || typeof submission.prompt !== 'string' || (!submission.prompt.trim() && submission.has_attachments !== true))
      throw httpError(400, '请先提交任务')
    const draft = await this.prepare(owner, id, workspaceId)
    if (draft.bound) {
      const chat = this.service.requireChat(owner, draft.chatId)
      await this.attachProject(owner, draft)
      await this.service.adoptDraftResources?.(owner, id, chat)
      return chat
    }
    // Persist the accepted intent before any directory allocation. Replayed
    // creation requests use this immutable name and identity, even after restart.
    if (!draft.submission) {
      draft.submission = { kind: submission.kind, prompt: submission.prompt }
      this.save(owner, draft)
    }
    if (!draft.directory) {
      if (workspaceId !== undefined) draft.directory = draft.base
      else {
        this.service.directories.assertAvailable(owner, draft.base)
        await this.service.fileManager.operate({ operation: 'mkdir', path: draft.base })
        const result = await this.service.fileManager.operate({ operation: 'mkdir',
          path: `${draft.base}/${directoryName(draft.submission.prompt)}`, unique: true, allocation_id: draft.chatId })
        draft.directory = result.path
      }
      this.save(owner, draft)
    }
    this.service.directories.assertAvailable(owner, draft.directory)
    await this.native(owner, draft, draft.directory)
    if (draft.originalDirectory !== draft.directory) {
      const agent = this.service.agents.get(draft.sessionId)
      if (!agent || !this.service.workingDirectory) throw httpError(503, '会话目录服务尚未就绪')
      await this.service.workingDirectory.set(agent, this.service.chatDirectory(draft.chatId, draft.directory))
    }
    let chat = this.db.getChat(owner.ownerId, draft.chatId)
    if (!chat) chat = this.db.createChat({ id: draft.chatId, ownerId: owner.ownerId, sessionId: draft.sessionId,
      selection, directory: draft.directory })
    // Publishing the binding precedes resource handoff: a retry recovers the
    // same business chat if the browser acknowledgement was lost.
    draft.bound = true
    this.save(owner, draft)
    await this.attachProject(owner, draft)
    await this.service.adoptDraftResources?.(owner, id, chat)
    return chat
  }
  async attachProject(owner, draft) {
    if (draft.workspaceId === undefined || draft.projectAttached) return
    await this.service.workspaces.controller.insertSessionBefore({ workspaceId: draft.workspaceId, sessionId: draft.sessionId })
    draft.projectAttached = true
    this.save(owner, draft)
  }
  originalDirectory(owner, chat) {
    const draft = this.db.draftForChat(owner.ownerId, chat.id)
    return draft?.bound ? draft.originalDirectory : undefined
  }
  async close(owner, id) {
    const draft = this.get(owner, id)
    if (!draft || draft.closed) return
    if (draft.bound) return // A late draft release must never close a submitted chat.
    draft.closing = true
    this.save(owner, draft)
    await this.service.closeDraftResources?.(owner, draft)
    if (draft.sessionReady) {
      if (!this.service.permanentDeletion) throw httpError(503, '资源清理服务尚未就绪')
      await this.service.permanentDeletion.erase({ sessionIds: [draft.sessionId] })
    }
    draft.closed = true
    draft.closing = false
    this.save(owner, draft)
  }
  async closeForPath(owner, directory) {
    for (const draft of this.db.drafts(owner.ownerId)) {
      if (draft.closed || draft.bound) continue
      if ([draft.base, draft.directory].filter(Boolean).some(root => containsWorkspacePath(directory, root) || containsWorkspacePath(root, directory)))
        await this.close(owner, draft.id)
    }
  }
}
