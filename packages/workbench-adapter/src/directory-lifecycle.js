import path from 'node:path'
import { createHash } from 'node:crypto'
import { containsWorkspacePath, resolveWorkspacePath } from './paths.js'
import { httpError } from './http.js'

const protectedDirectory = (operation = '删除') => httpError(409, `文件已绑定会话，暂不可${operation}`, 'DIRECTORY_IN_USE')
const overlaps = (a, b) => containsWorkspacePath(a, b) || containsWorkspacePath(b, a)

/** Serialize ownership changes, so the final fork cannot race directory cleanup. */
export class DirectoryLifecycle {
  constructor(service) { this.service = service; this.tails = new Map() }

  async run(owner, operation) {
    const prior = this.tails.get(owner.ownerId) ?? Promise.resolve()
    const current = prior.catch(() => {}).then(operation)
    this.tails.set(owner.ownerId, current)
    try { return await current }
    finally { if (this.tails.get(owner.ownerId) === current) this.tails.delete(owner.ownerId) }
  }

  relative(candidate) {
    return path.posix.relative(this.service.workspace, resolveWorkspacePath(this.service.workspace, candidate)) || '.'
  }

  chatPath(chat) { return this.relative(chat.directory ?? `conversations/${chat.id}`) }
  workspacePath(item) { return this.relative(path.posix.join('conversations', item.path)) }

  async workspaces(owner) {
    return (await this.service.workspaces?.baseline(owner, undefined, { includeSchedules: false }))?.items ?? []
  }

  assertAvailable(owner, directory) {
    if (this.service.database.pendingWorkspaceDeletions(owner.ownerId).some(item => overlaps(item.path, this.relative(directory))))
      throw httpError(409, '工作区正在删除，请稍后重试', 'WORKSPACE_DELETING')
  }

  assertInactive(owner, paths, chats, operation) {
    if (chats.some(chat => {
      const directory = this.chatPath(chat)
      return paths.some(candidate => candidate !== directory && containsWorkspacePath(directory, candidate))
        && (this.service.database.activeRun(owner.ownerId, chat.id)
        || this.service.agents?.get(chat.sessionId)?.status === 'running'
        || this.service.hasOwnedWork?.(chat.sessionId))
    }))
      throw httpError(409, `任务正在执行中，暂不可${operation}`, 'FILE_IN_USE')
  }

  async canCleanChat(owner, chat, directory = this.chatPath(chat)) {
    // The shared volume and its conversation root are never deletion targets.
    if (!directory.startsWith('conversations/')) return false
    if (this.service.database.directoryChats(owner.ownerId).some(other => other.id !== chat.id && overlaps(directory, this.chatPath(other)))) return false
    if ((await this.workspaces(owner)).some(item => overlaps(directory, this.workspacePath(item)))) return false
    return !this.service.database.pendingWorkspaceDeletions(owner.ownerId).some(item => overlaps(directory, item.path))
  }

  writeFile(owner, requested, operation) {
    return this.run(owner, async () => {
      const directory = this.relative(requested)
      this.assertAvailable(owner, directory)
      const date = /^(conversations\/\d{4}-\d{2}-\d{2})\//.exec(directory)?.[1]
      // Explicit file writes may create their date container; reads never do.
      if (date && (await this.service.fileManager.operate({ operation: 'stat', path: date })).kind === 'missing')
        await this.service.fileManager.operate({ operation: 'mkdir', path: date })
      return operation()
    })
  }

  async deleteFile(owner, requested, version) {
    return this.run(owner, async () => {
      const directory = this.relative(requested)
      const { service } = this, db = service.database
      // Read the complete binding set, including hidden deletion remnants, but
      // only surviving chats prevent an ordinary folder delete.
      const chats = db.directoryChats(owner.ownerId)
      const deleting = new Set(db.pendingWorkspaceDeletions(owner.ownerId).flatMap(plan => plan.chatIds))
      const live = chats.filter(chat => db.getChat(owner.ownerId, chat.id) && !db.chatDeletion(owner.ownerId, chat.id) && !deleting.has(chat.id))
      this.assertInactive(owner, [directory], live, '删除')
      const bound = live.filter(chat => containsWorkspacePath(directory, this.chatPath(chat)))
      if (bound.length) throw httpError(409, `文件夹包含会话：${bound.slice(0, 5).map(chat => chat.title).join('、')}，请先删除会话`, 'DIRECTORY_IN_USE')
      // Keep system roots under the file manager's existing boundary. Never
      // stop resources before discovering that such a target is forbidden.
      if (['.', 'conversations', 'mcp', 'skills'].includes(directory)) throw httpError(400, '系统目录不能删除')
      const requestedEntry = await service.fileManager.operate({ operation: 'stat', path: directory })
      // Ordinary files do not own resources or registrations. Keep the caller's
      // CAS version even if a native process writes between this read and delete.
      if (requestedEntry.kind === 'file')
        return service.fileManager.operate({ operation: 'delete', path: directory, version })
      const key = `file:${createHash('sha256').update(`${owner.ownerId}\0${directory}`).digest('hex')}`
      let plan = db.workspaceDeletion(owner.ownerId, key)
      if (plan?.completedAt) {
        const entry = await service.fileManager.operate({ operation: 'stat', path: directory })
        if (entry.kind === 'missing') return { deleted: true }
        // A newly created directory at the same path is a separate operation.
        db.db.prepare('DELETE FROM workspace_deletions WHERE owner_id=? AND workspace_id=?').run(owner.ownerId, key)
        plan = undefined
      }
      if (!plan) {
        const entry = await service.fileManager.operate({ operation: 'stat', path: directory })
        if (entry.kind !== 'missing' && entry.version !== version) throw httpError(409, '文件已改变，请刷新后重试', 'FILE_VERSION_CONFLICT')
        const workspaces = (await this.workspaces(owner)).filter(item => containsWorkspacePath(directory, this.workspacePath(item)))
        const stale = chats.filter(chat => !live.some(item => item.id === chat.id) && containsWorkspacePath(directory, this.chatPath(chat)))
        plan = db.beginWorkspaceDeletion(owner.ownerId, key, { path: directory, chatIds: stale.map(chat => chat.id),
          workspaceIds: workspaces.sort((a, b) => b.path.length - a.path.length).map(item => item.workspaceId), fileOnly: true })
      }
      await service.drafts?.closeForPath(owner, directory)
      await service.closeUnboundPathResources?.(owner, directory)
      for (const id of plan.chatIds) await service.deleteChatLocked(owner, id)
      // A registered project can retain native members after a failed platform
      // import/deletion. Drain those members before removing its registration.
      await service.closeUnboundWorkspaceSessions?.(owner, plan.workspaceIds)
      if (db.listChats(owner.ownerId).some(chat => containsWorkspacePath(directory, this.chatPath(chat)))) throw protectedDirectory()
      const currentWorkspaces = await this.workspaces(owner)
      if (currentWorkspaces.some(item => containsWorkspacePath(directory, this.workspacePath(item)) && !plan.workspaceIds.includes(item.workspaceId))) throw protectedDirectory()
      const entry = await service.fileManager.operate({ operation: 'stat', path: directory })
      if (entry.kind !== 'missing') await service.fileManager.operate({ operation: 'delete', path: directory, version: entry.version })
      for (const workspaceId of plan.workspaceIds) {
        try { await service.workspaces.controller.delete({ workspaceId }) }
        catch (error) { if (error?.code !== 'workspace/not-found') throw error }
      }
      for (const pending of db.pendingWorkspaceDeletions(owner.ownerId))
        if (containsWorkspacePath(directory, pending.path)
          && !db.directoryChats(owner.ownerId).some(chat => containsWorkspacePath(pending.path, this.chatPath(chat))))
          db.finishWorkspaceDeletion(owner.ownerId, pending.workspaceId)
      db.finishWorkspaceDeletion(owner.ownerId, key)
      return { deleted: true }
    })
  }

  async transferFile(owner, operation, requested, destination) {
    return this.run(owner, async () => {
      const source = this.relative(requested), target = this.relative(destination)
      this.assertAvailable(owner, source)
      this.assertAvailable(owner, target)
      if (operation === 'move') {
        const chats = this.service.database.directoryChats(owner.ownerId)
        const label = path.posix.dirname(source) === path.posix.dirname(target) ? '重命名' : '移动'
        this.assertInactive(owner, [source], chats, label)
        if (chats.some(chat => containsWorkspacePath(source, this.chatPath(chat)))
          || (await this.workspaces(owner)).some(item => containsWorkspacePath(source, this.workspacePath(item))))
          throw protectedDirectory(label)
      }
      return this.service.fileManager.operate({ operation, path: source, destination: target })
    })
  }

  async deleteWorkspace(owner, workspaceId) {
    const db = this.service.database
    let plan = db.workspaceDeletion(owner.ownerId, workspaceId)
    if (!plan) {
      const items = await this.workspaces(owner)
      const item = items.find(value => value.workspaceId === workspaceId)
      if (!item) throw httpError(404, '工作区不存在')
      const directory = this.workspacePath(item)
      if (!directory.startsWith('conversations/')) throw httpError(400, '对话文件根目录不能删除')
      this.assertAvailable(owner, directory)
      const children = items.filter(value => containsWorkspacePath(directory, this.workspacePath(value)))
      const members = new Set(children.flatMap(value => value.sessionIds))
      const ownedChats = db.directoryChats(owner.ownerId)
      if (ownedChats.some(chat => members.has(chat.sessionId) && !containsWorkspacePath(directory, this.chatPath(chat))))
        throw httpError(409, '工作区会话目录不一致，请刷新后重试')
      const chats = ownedChats.filter(chat => containsWorkspacePath(directory, this.chatPath(chat)))
      // Persist the complete scope before the first irreversible operation.
      plan = db.beginWorkspaceDeletion(owner.ownerId, workspaceId, {
        path: directory, chatIds: chats.map(chat => chat.id),
        workspaceIds: children.sort((a, b) => b.path.length - a.path.length).map(value => value.workspaceId),
      })
    }
    if (plan.completedAt) return
    await this.service.drafts?.closeForPath(owner, plan.path)
    await this.service.closeUnboundPathResources?.(owner, plan.path)
    for (const id of plan.chatIds) this.service.scheduler?.deletingChats.add(id)
    for (const id of plan.chatIds) await this.service.deleteChatLocked(owner, id)
    await this.service.closeUnboundWorkspaceSessions?.(owner, plan.workspaceIds)
    // Recheck before recursive removal; stale/corrupt plans must fail closed.
    if (db.directoryChats(owner.ownerId).some(chat => containsWorkspacePath(plan.path, this.chatPath(chat)))) throw protectedDirectory()
    if ((await this.workspaces(owner)).some(item => containsWorkspacePath(plan.path, this.workspacePath(item)) && !plan.workspaceIds.includes(item.workspaceId))) throw protectedDirectory()
    const entry = await this.service.fileManager.operate({ operation: 'stat', path: plan.path })
    if (entry.kind !== 'missing') await this.service.fileManager.operate({ operation: 'delete', path: plan.path, version: entry.version })
    for (const id of plan.workspaceIds) {
      try { await this.service.workspaces.controller.delete({ workspaceId: id }) }
      catch (error) { if (error?.code !== 'workspace/not-found') throw error }
    }
    db.finishWorkspaceDeletion(owner.ownerId, workspaceId)
    for (const id of plan.chatIds) this.service.scheduler?.deletingChats.delete(id)
  }
}
