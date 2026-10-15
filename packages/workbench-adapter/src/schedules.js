import { httpError } from './http.js'

/** Native Host Schedule owns storage, timing, delivery and receipts. */
export class WorkbenchSchedules {
  constructor({ native, database, service }) {
    this.getNative = typeof native === 'function' ? native : () => native
    this.database = database
    this.service = service
  }
  get native() {
    const value = this.getNative()
    if (!value) throw httpError(503, '定时任务服务尚未就绪')
    return value
  }
  async catalog(owner) {
    const chats = new Map(this.database.chatBindings(owner.ownerId).map(chat => [chat.sessionId, chat]))
    return (await this.native.catalog()).flatMap(task => {
      const chat = chats.get(task.sessionId)
      return chat ? [{ ...task, chat_id: chat.id, chat_title: chat.title, chat_deleted: chat.deletedAt != null }] : []
    })
  }
  async rememberRun(run) {
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
    const catalog = await this.native.catalog()
    const tasks = ids.map(id => catalog.find(task => task.id === id && task.sessionId === run.sessionId)).filter(Boolean)
    const titles = capturedTitles ? run.selection.schedule_titles : tasks.map(task => task.title)
    // A delivery's display names are a receipt, not another task catalog.
    this.database.updateRunResources(run, { ...run.selection, schedule_titles: titles, schedule_ids: tasks.map(task => task.id) }, run.mcpTools)
    if (!capturedTitles) this.database.appendEvent(run.ownerId, run.id, { event: 'workbench_schedule', titles })
  }
  async create(owner, chatId, request, signal) {
    const chat = this.service.requireChat(owner, chatId)
    // The signed owner/chat binding supplies the Session; the client cannot choose it.
    const { title, prompt, after_seconds, at, every_seconds, daily, weekly, cron } = request
    return this.native.create(chat.sessionId, { title, prompt,
      ...Object.fromEntries(Object.entries({ after_seconds, at, every_seconds, daily, weekly, cron }).filter(([, value]) => value !== undefined)) }, signal)
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
    return this.native.update({ sessionId: task.sessionId, id, expected,
      ...Object.fromEntries(Object.entries({ title, prompt, change }).filter(([, value]) => value !== undefined)) }, signal)
  }
  async delete(owner, id, signal) {
    const task = await this.task(owner, id)
    return this.native.delete({ sessionId: task.sessionId, id }, signal)
  }
}
