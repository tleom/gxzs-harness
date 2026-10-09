import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { httpError } from './http.js'
import { resolveWorkspacePath } from './paths.js'

// Host Workspace remains the authority for membership, order, archive and pin.
// This boundary only scopes paths and translates platform chat identities.
export class WorkbenchWorkspaces {
  constructor({ controller, database, root, fileManager, sessions }) {
    this.controller = controller
    this.database = database
    this.root = root
    this.fileManager = fileManager
    this.sessions = sessions
  }

  async baseline(owner, signal) {
    const abort = new AbortController()
    const cancel = () => abort.abort(signal.reason)
    signal?.throwIfAborted()
    signal?.addEventListener('abort', cancel, { once: true })
    const stream = this.controller.follow(abort.signal)[Symbol.asyncIterator]()
    try {
      const first = await stream.next()
      if (first.done || first.value.type !== 'baseline') throw httpError(503, '工作区状态尚未就绪')
      const projected = this.project(owner, first.value.value)
      if (this.sessions) {
        const { items } = await this.sessions.list({}, abort.signal)
        // Keep native list ordering, timestamps, blank flags and projection
        // watermarks. The platform boundary removes foreign sessions and cwd.
        projected.sessions = items.filter(item => projected.chatIds[item.sessionId])
          .map(({ cwd, ...item }) => item)
      }
      return projected
    } finally {
      signal?.removeEventListener('abort', cancel)
      abort.abort()
      await stream.return?.()
    }
  }

  project(owner, baseline) {
    const chats = new Map(this.database.listChats(owner.ownerId).map(chat => [chat.sessionId, chat.id]))
    const allowed = value => {
      try { return resolveWorkspacePath(this.root, value) === value }
      catch { return false }
    }
    return {
      items: baseline.items.filter(item => allowed(item.path)).map(item => ({
        ...item, path: path.posix.relative(this.root, item.path) || '.',
        sessionIds: item.sessionIds.filter(id => chats.has(id)),
      })),
      archivedSessionIds: baseline.archivedSessionIds.filter(id => chats.has(id)),
      pinnedSessionIds: baseline.pinnedSessionIds.filter(id => chats.has(id)),
      chatIds: Object.fromEntries(chats),
    }
  }

  async requireWorkspace(owner, workspaceId, validateDirectory = false) {
    if (typeof workspaceId !== 'string' || !workspaceId) throw httpError(400, '工作区标识无效')
    const item = (await this.baseline(owner)).items.find(item => item.workspaceId === workspaceId)
    if (!item) throw httpError(404, '工作区不存在')
    if (validateDirectory) await this.resolveDirectory(item.path)
    return item
  }

  async resolveDirectory(candidate) {
    const resolved = resolveWorkspacePath(this.root, candidate)
    try {
      const canonical = await realpath(resolved)
      return resolveWorkspacePath(this.root, canonical)
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw httpError(400, '请选择对话文件中的现有文件夹')
      throw error
    }
  }

  session(owner, chatId) {
    const chat = this.database.getChat(owner.ownerId, chatId)
    if (!chat) throw httpError(404, '会话不存在')
    return chat.sessionId
  }

  async mutate(owner, request) {
    const { operation } = request
    if (operation === 'browse' || operation === 'mkdir') {
      if ((request.path ?? '.') === '.') {
        // First-use users need the picker root before their first conversation.
        await this.fileManager.operate({ operation: 'mkdir', path: 'conversations' })
      }
      const canonical = await this.resolveDirectory(request.path ?? '.')
      let relative = path.posix.join('conversations', path.posix.relative(this.root, canonical))
      if (operation === 'mkdir') {
        if (typeof request.name !== 'string' || !request.name.trim() || request.name !== request.name.trim()
          || request.name === '.' || request.name === '..' || /[/\\\0:]/.test(request.name)) throw httpError(400, '文件夹名称无效')
        relative = path.posix.join(relative, request.name)
        await this.fileManager.operate({ operation: 'mkdir', path: relative })
        return { path: path.posix.relative('conversations', relative) }
      }
      const result = await this.fileManager.operate({ operation: 'list', path: relative })
      return { path: path.posix.relative('conversations', relative) || '.',
        entries: result.entries.filter(entry => entry.kind === 'directory').map(entry => ({ name: entry.name,
          path: path.posix.join(path.posix.relative('conversations', relative), entry.name) })) }
    } else if (operation === 'create') {
      // The owner's workspace volume is mounted read-only at the same absolute
      // path in Host. Validate the canonical target before native registration.
      const canonical = await this.resolveDirectory(request.path)
      await this.controller.create({ path: canonical })
    } else if (['rename', 'delete', 'insertBefore', 'insertSessionBefore'].includes(operation)) {
      await this.requireWorkspace(owner, request.workspaceId, operation === 'insertSessionBefore')
      if (operation === 'rename') {
        if (typeof request.title !== 'string') throw httpError(400, '工作区名称无效')
        await this.controller.rename({ workspaceId: request.workspaceId, title: request.title })
      } else if (operation === 'delete') {
        await this.controller.delete({ workspaceId: request.workspaceId })
      } else if (operation === 'insertBefore') {
        if (request.beforeWorkspaceId != null) await this.requireWorkspace(owner, request.beforeWorkspaceId)
        await this.controller.insertBefore({ workspaceId: request.workspaceId, beforeWorkspaceId: request.beforeWorkspaceId ?? undefined })
      } else {
        await this.controller.insertSessionBefore({ workspaceId: request.workspaceId,
          sessionId: this.session(owner, request.chatId),
          beforeSessionId: request.beforeChatId == null ? undefined : this.session(owner, request.beforeChatId) })
      }
    } else if (['archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession'].includes(operation)) {
      await this.controller[operation]({ sessionId: this.session(owner, request.chatId),
        ...(operation === 'archiveSession' ? { stopActivity: request.stopActivity === true } : {}) })
    } else throw httpError(400, '工作区操作无效')
    return this.baseline(owner)
  }
}
