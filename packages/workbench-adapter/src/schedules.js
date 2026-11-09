import { errorResponse, httpError } from './http.js'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveWorkspacePath } from './paths.js'

/** Native Host Schedule owns storage, timing, delivery and receipts. */
export class WorkbenchSchedules {
  constructor({ native, database, service, ownerId, sessionHeader }) {
    this.getNative = typeof native === 'function' ? native : () => native
    this.database = database
    this.service = service
    this.ownerId = ownerId
    this.sessionHeader = sessionHeader
    this.pendingNames = new Map()
    this.pendingCreates = new Map()
    this.nativeCreations = 0
  }
  get native() {
    const value = this.getNative()
    if (!value) throw httpError(503, '定时任务服务尚未就绪')
    return value
  }
  async catalog(owner) {
    const tasks = await this.ownedCatalog(owner)
    if (!this.notifications) return tasks
    return this.notifications.read(tasks)
  }
  async ownedCatalog(owner) {
    this.assertOwner(owner)
    const chats = new Map(this.database.chatBindings(owner.ownerId).map(chat => [chat.sessionId, chat]))
    const workspaces = (await this.service.workspaces?.baseline?.(owner, undefined, { includeSchedules: false }))?.items ?? []
    return (await this.native.catalog()).filter(task => {
      const sessionId = task.target.kind === 'new' ? task.lastDelivery?.targetSessionId : task.target.sessionId
      const binding = sessionId && this.database.getChatBySession(sessionId)
      return !binding || binding.ownerId === owner.ownerId
    }).map(task => {
      const chat = chats.get(task.target.kind === 'new' ? task.lastDelivery?.targetSessionId : task.target.sessionId)
      const directory = task.target.kind === 'session' ? chat?.directory
        : task.target.create.cwd ? path.posix.relative(this.service.workspace, task.target.create.cwd) : undefined
      const workspace = workspaces.find(item => path.posix.join('conversations', item.path) === directory)
      return { ...task, ...(chat ? { chat_id: chat.id, chat_title: chat.title, chat_deleted: chat.deletedAt != null,
      } : {}), execution_directory: directory,
      ...(workspace ? { workspace_id: workspace.workspaceId, workspace_title: workspace.title } : {}) }
    })
  }
  assertOwner(owner) {
    if (!this.ownerId || owner.ownerId !== this.ownerId) throw httpError(403, '无法访问其他用户的定时任务')
  }
  async target(owner, target, workspaceId) {
    this.assertOwner(owner)
    if (target != null && (typeof target !== 'object' || Array.isArray(target))) throw httpError(400, '执行位置无效')
    if (workspaceId != null && typeof workspaceId !== 'string') throw httpError(400, '工作区标识无效')
    if (target?.create != null && (typeof target.create !== 'object' || Array.isArray(target.create))) throw httpError(400, '执行位置无效')
    if (target?.create?.agentPreset !== undefined && (typeof target.create.agentPreset !== 'string' || !target.create.agentPreset.trim()))
      throw httpError(400, '智能体预设无效')
    const kind = target?.kind ?? 'new_once'
    if (kind === 'session') {
      const chat = target.chat_id ? this.service.requireChat(owner, target.chat_id)
        : this.database.chatBindings(owner.ownerId).find(chat => chat.sessionId === target.sessionId && !chat.deletedAt)
      if (!chat) throw httpError(404, '执行会话不存在')
      return { kind, sessionId: chat.sessionId }
    }
    if (!['new', 'new_once'].includes(kind)) throw httpError(400, '执行位置无效')
    let cwd
    if (workspaceId) {
      const workspace = await this.service.workspaces.requireWorkspace(owner, workspaceId, true)
      cwd = resolveWorkspacePath(this.service.workspaces.root, workspace.path)
    } else if (target?.create?.cwd) {
      // Existing task edits may retain their directory, but cannot escape the owner volume.
      cwd = await this.service.workspaces.resolveDirectory(target.create.cwd)
    } else {
      const directory = `conversations/scheduled/${randomUUID()}`
      await this.service.fileManager.operate({ operation: 'mkdir', path: 'conversations/scheduled' })
      await this.service.fileManager.operate({ operation: 'mkdir', path: directory })
      cwd = resolveWorkspacePath(this.service.workspace, directory)
    }
    this.service.directories?.assertAvailable(owner, cwd)
    return { kind, create: { cwd, ...(target?.create?.agentPreset ? { agentPreset: target.create.agentPreset } : {}) } }
  }
  /** Native Schedule creates and retries Sessions; the platform only admits its owner mapping. */
  async activate(owner, sessionId, next) {
    this.assertOwner(owner)
    const existing = this.database.getChatBySession(sessionId)
      ?? this.database.chatBindings(owner.ownerId).find(chat => chat.sessionId === sessionId)
    if (existing) {
      if (existing.ownerId !== owner.ownerId || existing.deletedAt) throw httpError(404, '执行会话不存在')
    }
    const bind = header => {
      if (header.origin === 'subagent' || header.delegationDepth > 0)
        throw httpError(403, '子智能体不能作为定时任务执行位置')
      const cwd = resolveWorkspacePath(this.service.workspace, header.cwd)
      this.service.directories?.assertAvailable(owner, cwd)
      const directory = path.posix.relative(this.service.workspace, cwd) || '.'
      this.database.createChat({ ownerId: owner.ownerId, sessionId, directory, selection: {} })
    }
    // A restored inbox can start during native activation; establish the platform
    // mapping from the saved header before the native driver can claim it.
    const header = !existing && await this.sessionHeader?.(sessionId)
    if (header) bind(header)
    const agent = await next()
    if (!existing && !header) bind(agent.session.header)
    return agent
  }
  displayCatalog() {
    if (this.pendingCatalog) return this.pendingCatalog.wait
    const request = this.native.catalog()
    let timer
    const wait = Promise.race([
      request,
      new Promise(resolve => { timer = setTimeout(resolve, 250) }),
    ]).finally(() => clearTimeout(timer))
    const pending = { wait }
    this.pendingCatalog = pending
    // A timed-out native read stays shared across steps and runs until it
    // actually settles. Only the display wait has a budget, not another read.
    const settled = () => {
      if (this.pendingCatalog === pending) this.pendingCatalog = undefined
    }
    void Promise.resolve(request).then(settled, settled)
    return wait
  }
  async rememberRun(run) {
    if (this.pendingNames.has(run.id)) return this.pendingNames.get(run.id)
    run = this.database.getRun(run.ownerId, run.id) ?? run
    const capturedTitles = Array.isArray(run.selection?.schedule_titles)
    if (capturedTitles && Array.isArray(run.selection?.schedule_ids)) return
    const ids = []
    try {
      const single = /^schedule_id_json: (.+)$/m.exec(run.query)?.[1]
      const batch = /^reminders_json: (.+)$/m.exec(run.query)?.[1]
      if (single) { const id = JSON.parse(single); if (typeof id === 'string') ids.push(id) }
      if (batch) { const rows = JSON.parse(batch); if (Array.isArray(rows)) for (const row of rows)
        if (typeof row?.schedule_id === 'string') ids.push(row.schedule_id) }
    } catch { /* Older framing may not contain recoverable task identities. */ }
    const deliveredIds = [...new Set(ids.filter(Boolean))]
    // Native delivery framing remains authoritative after a task is deleted.
    // Save its identity before any best-effort display lookup can suspend.
    if (!Array.isArray(run.selection?.schedule_ids))
      this.database.updateRunResources(run, { ...run.selection, schedule_ids: deliveredIds }, run.mcpTools)
    const lookup = (async () => {
      const catalog = await this.displayCatalog()
      // Ignore late display results instead of appending after the terminal
      // event has closed the run stream. The delivery identity is already saved.
      if (!catalog) return
      const retainedIds = deliveredIds.filter(id => {
        const task = catalog.find(task => task.id === id)
        return !task || task.target?.kind === 'new' || task.target?.sessionId === run.sessionId
          || task.lastDelivery?.targetSessionId === run.sessionId || task.involvedSessionIds?.includes(run.sessionId)
      })
      const titles = capturedTitles ? run.selection.schedule_titles
        : retainedIds.map(id => catalog.find(task => task.id === id)?.title || '定时任务')
      const current = this.database.getRun(run.ownerId, run.id)
      if (!current) return
      // Preserve any scope changes made while the display lookup was pending.
      this.database.updateRunResources(current, { ...current.selection, schedule_titles: titles, schedule_ids: retainedIds }, current.mcpTools)
      if (!capturedTitles) this.database.appendEvent(run.ownerId, run.id, { event: 'workbench_schedule', titles })
    })()
    this.pendingNames.set(run.id, lookup)
    try { await lookup }
    finally { this.pendingNames.delete(run.id) }
  }
  async create(owner, chatId, request, signal) {
    this.assertOwner(owner)
    const chat = chatId ? this.service.requireChat(owner, chatId) : undefined
    if (request.request_key === undefined) return this.createNative(owner, chat, request, signal)
    if (typeof request.request_key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.request_key))
      throw httpError(400, '创建请求标识无效')
    const key = `schedule-create:${request.request_key}`
    const fingerprint = JSON.stringify([chatId, ...['title', 'prompt', 'timing', 'target', 'workspace_id', 'notify_enabled'].map(name => request[name])])
    const receipt = this.database.getHostReceipt(owner.ownerId, key)
    if (receipt && receipt.fingerprint !== fingerprint)
      throw httpError(409, '本次创建已提交，请先确认结果后再修改任务')
    const pendingKey = JSON.stringify([owner.ownerId, key])
    if (this.pendingCreates.has(pendingKey)) return this.pendingCreates.get(pendingKey)
    const resultKey = `${key}:result`
    const saved = this.database.getHostReceipt(owner.ownerId, resultKey)
    if (saved) return saved
    if (receipt)
      throw httpError(409, '创建结果尚未确认，请刷新任务列表核对，避免重复创建')
    signal?.throwIfAborted()
    // Check readiness before committing intent. After intent, connection loss
    // must not cancel the write or its receipt. Native storage and SQLite cannot
    // commit atomically; an interrupted intent must never blindly create again.
    const native = this.native
    this.database.saveHostReceipt(owner.ownerId, key, { fingerprint })
    const operation = (async () => {
      let result
      try { result = await this.createNative(owner, chat, request, undefined, native) }
      catch (error) {
        if (error?.name !== 'ScheduleInputError' && error?.code !== 'schedule/input-invalid' && ![400, 403, 404].includes(error?.status)) throw error
        // Native input refusals occur before persistence and can be corrected.
        result = { ...errorResponse(error).body, creation_failed: true }
      }
      return this.database.saveHostReceipt(owner.ownerId, resultKey, result)
    })()
    this.pendingCreates.set(pendingKey, operation)
    try { return await operation }
    finally { this.pendingCreates.delete(pendingKey) }
  }
  async createNative(owner, chat, request, signal, native = this.native) {
    const { title, prompt, timing } = request
    if (request.notify_enabled !== undefined && typeof request.notify_enabled !== 'boolean')
      throw httpError(400, '通知设置参数无效')
    const createdAt = Date.now()
    this.nativeCreations++
    try {
      const target = await this.target(owner, request.target, request.workspace_id)
      const record = await native.create({ title, prompt, timing, target }, chat?.sessionId, signal)
      if (!this.notifications) return record
      const task = { ...record, chat_id: record.target.kind === 'session'
        ? this.database.getChatBySession(record.target.sessionId)?.id : undefined }
      try {
        if (request.notify_enabled === true) await this.notifications.initialize(task, createdAt)
        else await this.notifications.sync([task])
        return record
      } catch {
        return { ...record, notification_error: '任务已创建，通知设置暂未确认，请稍后刷新或重新设置' }
      }
    } finally {
      this.nativeCreations--
      this.notifications?.kick()
    }
  }
  async task(owner, id) {
    if (typeof id !== 'string' || !id) throw httpError(400, '定时任务标识无效')
    const task = (await this.catalog(owner)).find(task => task.id === id)
    if (!task) throw httpError(404, '定时任务不存在')
    return task
  }
  async history(owner, id, before) {
    await this.task(owner, id)
    const page = await this.native.history({ id, limit: 50,
      ...(before ? { before } : {}) })
    if (!page.records) return page
    const chats = new Map(this.database.chatBindings(owner.ownerId).filter(chat => !chat.deletedAt).map(chat => [chat.sessionId, chat.id]))
    return { ...page, records: page.records.map(record => ({ ...record, ...(chats.has(record.targetSessionId)
      ? { chat_id: chats.get(record.targetSessionId) } : {}) })) }
  }
  async update(owner, id, request, signal) {
    const task = await this.task(owner, id)
    const { expectedUpdatedAt } = request
    if (request.notify_enabled !== undefined && (!task.notification_available || typeof request.notify_enabled !== 'boolean'))
      throw httpError(503, '通知设置暂不可用，请刷新后重试')
    if (request.notify_enabled !== undefined && request.notification_version !== task.notification_version)
      throw httpError(409, '通知设置已更新，请刷新后重试')
    const patch = { ...request.patch }
    if (patch.target) patch.target = await this.target(owner, patch.target, request.workspace_id)
    const result = Object.keys(patch).length
      ? await this.native.edit({ id, action: 'update', patch, expectedUpdatedAt }, undefined, signal)
      : task
    if (!result?.code && request.notify_enabled !== undefined) {
      try {
        const updated = (await this.ownedCatalog(owner)).find(item => item.id === id) ?? task
        await this.notifications.configure(updated, request.notify_enabled, request.notification_version, signal)
      } catch {
        // Native rules have already committed. Return their new expected record
        // so the editor can retry settings without replaying an obsolete rule.
        let latest
        try { latest = await this.task(owner, id) } catch { /* Retry can refresh settings later. */ }
        return { ...result, notification_version: latest?.notification_version,
          notification_error: '任务规则已保存，通知设置未确认，请重试保存通知设置' }
      }
    }
    return result
  }
  async delete(owner, id, signal) {
    const task = await this.task(owner, id)
    const result = await this.native.edit({ id, action: 'delete' }, undefined, signal)
    if (result.deleted && this.notifications) {
      try { await this.notifications.remove(task, signal) }
      catch { /* Native deletion is committed; retained records cannot rearm it. */ }
    }
    return result
  }
  async run(owner, id, signal) {
    await this.task(owner, id)
    return this.native.run({ id }, signal)
  }
  async deleteEnded(owner, signal) {
    this.assertOwner(owner)
    signal?.throwIfAborted()
    const ended = (await this.ownedCatalog(owner)).filter(task => task.status === 'ended')
    const result = await this.native.deleteInactive()
    for (const task of ended) {
      try { await this.notifications?.remove(task, signal) } catch { this.notifications?.kick() }
    }
    return result
  }
}
