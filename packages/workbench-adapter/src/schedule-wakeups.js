import { createHash } from 'node:crypto'

export const PREWARM_MS = 5 * 60_000
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function scheduleRevision(task) {
  return digest([task.id, task.sessionId, task.kind, task.status, task.scheduledAt,
    task.title, task.prompt, task.everySeconds, task.time, task.timeZone, task.weekdays, task.expression])
}

/** Native commits drive durable platform registrations; only failed/unacknowledged requests retry. */
export class ScheduleWakeups {
  constructor({ database, schedules, platformClient, ownerId, logger }) {
    Object.assign(this, { database, schedules, platformClient, ownerId, logger })
    this.lifetime = new AbortController()
    this.confirmed = new Map()
    this.dirty = true
  }
  start(ctx) {
    if (this.started) return
    this.started = true
    ctx.on('schedule/changed', () => { this.dirty = true; this.kick() }, { global: true })
    this.kick()
  }
  kick(delay = 25) {
    if (this.lifetime.signal.aborted) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush().catch(() => {
        this.dirty = true
        this.logger?.warn('预唤醒登记未确认，将重试当前计划')
        this.kick(5000)
      })
    }, delay)
    this.timer.unref?.()
  }
  flush() {
    if (this.pending) { this.again = true; return this.pending }
    this.pending = this.sync().finally(() => {
      this.pending = undefined
      if (this.again) { this.again = false; this.kick() }
    })
    return this.pending
  }
  async sync() {
    this.lifetime.signal.throwIfAborted()
    this.dirty = false
    const catalog = await this.schedules.ownedCatalog({ ownerId: this.ownerId })
    const tasks = catalog.map(task => ({ id: task.id, sessionId: task.sessionId, chatId: task.chat_id,
      title: task.title, status: task.status, scheduledAt: Date.parse(task.scheduledAt), revision: scheduleRevision(task) }))
      .sort((a, b) => a.id.localeCompare(b.id))
    const fingerprint = digest(tasks)
    const sequence = this.database.scheduleSyncSequence(this.ownerId, fingerprint)
    const response = await this.platformClient.json({ owner: { ownerId: this.ownerId }, method: 'POST', route: 'schedule-wakeups',
      body: Buffer.from(JSON.stringify({ sequence, tasks })), contentType: 'application/json', timeoutMs: 5000,
      signal: this.lifetime.signal })
    const result = response.data ?? response
    if (result.sequence !== sequence || !Array.isArray(result.tasks)) throw new Error('Invalid schedule wakeup acknowledgment')
    const acknowledged = new Map(result.tasks.map(task => [task.id, task]))
    this.confirmed = new Map(tasks.filter(task => acknowledged.get(task.id)?.revision === task.revision
      && acknowledged.get(task.id)?.registered === true).map(task => [task.id, task.revision]))
    this.complete = result.complete === true && this.confirmed.size === tasks.length
    this.catalogFingerprint = digest(catalog.map(task => [task.id, scheduleRevision(task)]).sort((a, b) => a[0].localeCompare(b[0])))
    if (!this.complete || this.dirty) this.kick(1000)
  }
  safety(tasks, now = Date.now()) {
    const active = tasks.filter(task => task.status === 'active')
    const fingerprint = digest(tasks.map(task => [task.id, scheduleRevision(task)]).sort((a, b) => a[0].localeCompare(b[0])))
    const clean = this.started && this.complete && !this.dirty && !this.pending && this.catalogFingerprint === fingerprint
    const registered = clean ? active.filter(task => this.confirmed.get(task.id) === scheduleRevision(task)
      && Date.parse(task.scheduledAt) > now + PREWARM_MS).length : 0
    return { registeredSchedules: registered, pendingScheduleReports: clean ? 0 : 1 }
  }
  close() {
    clearTimeout(this.timer)
    this.lifetime.abort()
    void this.pending?.catch(() => {})
  }
}
