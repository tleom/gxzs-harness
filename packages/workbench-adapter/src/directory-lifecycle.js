import path from 'node:path'
import { containsWorkspacePath, resolveWorkspacePath } from './paths.js'
import { httpError } from './http.js'

const protectedDirectory = () => httpError(409, '请先删除对应对话或工作区', 'DIRECTORY_IN_USE')
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

  async canCleanChat(owner, chat, directory = this.chatPath(chat)) {
    // The shared volume and its conversation root are never deletion targets.
    if (!directory.startsWith('conversations/')) return false
    if (this.service.database.directoryChats(owner.ownerId).some(other => other.id !== chat.id && overlaps(directory, this.chatPath(other)))) return false
    if ((await this.workspaces(owner)).some(item => overlaps(directory, this.workspacePath(item)))) return false
    return !this.service.database.pendingWorkspaceDeletions(owner.ownerId).some(item => overlaps(directory, item.path))
  }

  async deleteFile(owner, requested, version) {
    return this.run(owner, async () => {
      const directory = this.relative(requested)
      const chats = this.service.database.directoryChats(owner.ownerId)
      // Check ancestors too: deleting a date folder must not bypass protection.
      if (chats.some(chat => containsWorkspacePath(directory, this.chatPath(chat)))
        || (await this.workspaces(owner)).some(item => containsWorkspacePath(directory, this.workspacePath(item)))
        || this.service.database.pendingWorkspaceDeletions(owner.ownerId).some(item => overlaps(directory, item.path)))
        throw protectedDirectory()
      if (this.service.database.hasActiveRuns(owner.ownerId) || chats.some(chat => this.service.hasOwnedWork?.(chat.sessionId)))
        throw httpError(409, '工作台正在执行任务，请停止后再删除文件')
      return this.service.fileManager.operate({ operation: 'delete', path: directory, version })
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
    for (const id of plan.chatIds) this.service.scheduler?.deletingChats.add(id)
    for (const id of plan.chatIds) await this.service.deleteChatLocked(owner, id)
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
