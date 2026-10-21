import { errorResponse, httpError } from './http.js'

/** Native Host Schedule owns storage, timing, delivery and receipts. */
export class WorkbenchSchedules {
  constructor({ native, database, service }) {
    this.getNative = typeof native === 'function' ? native : () => native
    this.database = database
    this.service = service
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
    const chats = new Map(this.database.chatBindings(owner.ownerId).map(chat => [chat.sessionId, chat]))
    return (await this.native.catalog()).flatMap(task => {
      const chat = chats.get(task.sessionId)
      return chat ? [{ ...task, chat_id: chat.id, chat_title: chat.title, chat_deleted: chat.deletedAt != null }] : []
    })
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
        return !task || task.sessionId === run.sessionId
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
    const chat = this.service.requireChat(owner, chatId)
    if (request.request_key === undefined) return this.createNative(chat, request, signal)
    if (typeof request.request_key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.request_key))
      throw httpError(400, '创建请求标识无效')
    const key = `schedule-create:${request.request_key}`
    const fingerprint = JSON.stringify(Object.fromEntries(['title', 'prompt', 'after_seconds', 'at',
      'every_seconds', 'daily', 'weekly', 'cron', 'notify_enabled'].map(name => [name, request[name]])))
    const receipt = this.database.getCommandReceipt(owner.ownerId, chat.id, key)
    if (receipt && receipt.fingerprint !== fingerprint)
      throw httpError(409, '本次创建已提交，请先确认结果后再修改任务')
    const pendingKey = JSON.stringify([owner.ownerId, chat.id, key])
    if (this.pendingCreates.has(pendingKey)) return this.pendingCreates.get(pendingKey)
    const resultKey = `${key}:result`
    const saved = this.database.getCommandReceipt(owner.ownerId, chat.id, resultKey)
    if (saved) return saved
    if (receipt)
      throw httpError(409, '创建结果尚未确认，请刷新任务列表核对，避免重复创建')
    signal?.throwIfAborted()
    // Check readiness before committing intent. After intent, connection loss
    // must not cancel the write or its receipt. Native storage and SQLite cannot
    // commit atomically; an interrupted intent must never blindly create again.
    const native = this.native
    this.database.saveCommandReceipt(owner.ownerId, chat.id, key, { fingerprint })
    const operation = (async () => {
      let result
      try { result = await this.createNative(chat, request, undefined, native) }
      catch (error) {
        if (error?.name !== 'ScheduleInputError') throw error
        // Native input refusals occur before persistence and can be corrected.
        result = { ...errorResponse(error).body, creation_failed: true }
      }
      return this.database.saveCommandReceipt(owner.ownerId, chat.id, resultKey, result)
    })()
    this.pendingCreates.set(pendingKey, operation)
    try { return await operation }
    finally { this.pendingCreates.delete(pendingKey) }
  }
  async createNative(chat, request, signal, native = this.native) {
    // The signed owner/chat binding supplies the Session; the client cannot choose it.
    const { title, prompt, after_seconds, at, every_seconds, daily, weekly, cron } = request
    if (request.notify_enabled !== undefined && typeof request.notify_enabled !== 'boolean')
      throw httpError(400, '通知设置参数无效')
    const createdAt = Date.now()
    this.nativeCreations++
    try {
      const record = await native.create(chat.sessionId, { title, prompt,
        ...Object.fromEntries(Object.entries({ after_seconds, at, every_seconds, daily, weekly, cron }).filter(([, value]) => value !== undefined)) }, signal)
      if (!this.notifications) return record
      const task = { ...record, sessionId: chat.sessionId, chat_id: chat.id }
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
    const task = await this.task(owner, id)
    return this.native.history({ sessionId: task.sessionId, id, limit: 50,
      ...(before ? { before } : {}) })
  }
  async update(owner, id, request, signal) {
    const task = await this.task(owner, id)
    const { expected, title, prompt, change } = request
    if (request.notify_enabled !== undefined && (!task.notification_available || typeof request.notify_enabled !== 'boolean'))
      throw httpError(503, '通知设置暂不可用，请刷新后重试')
    if (request.notify_enabled !== undefined && request.notification_version !== task.notification_version)
      throw httpError(409, '通知设置已更新，请刷新后重试')
    const result = await this.native.update({ sessionId: task.sessionId, id, expected,
      ...Object.fromEntries(Object.entries({ title, prompt, change }).filter(([, value]) => value !== undefined)) }, signal)
    if (!result?.code && request.notify_enabled !== undefined) {
      try {
        await this.notifications.configure({ ...task, title: title ?? task.title }, request.notify_enabled, request.notification_version, signal)
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
    const result = await this.native.delete({ sessionId: task.sessionId, id }, signal)
    if (result.deleted && this.notifications) {
      try { await this.notifications.remove(task, signal) }
      catch { /* Native deletion is committed; retained records cannot rearm it. */ }
    }
    return result
  }
}
