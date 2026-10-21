import { defineTool } from '@deepseek-ai/dsh-tools'
import { httpError } from './http.js'

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'discarded'])

/** Occurrence identities come from DSH's scheduled-message framing. */
export function scheduleOccurrences(query) {
  try {
    const single = /^schedule_id_json: (.+)$/m.exec(query)?.[1]
    const at = /^occurrence_at: (.+)$/m.exec(query)?.[1]
    const batch = /^reminders_json: (.+)$/m.exec(query)?.[1]
    const rows = batch ? JSON.parse(batch) : single ? [{ schedule_id: JSON.parse(single), occurrence_at: at }] : []
    if (!Array.isArray(rows)) return []
    const seen = new Set()
    return rows.flatMap(row => {
      const time = Date.parse(row?.occurrence_at)
      if (typeof row?.schedule_id !== 'string' || !Number.isFinite(time) || seen.has(row.schedule_id)) return []
      seen.add(row.schedule_id)
      return [{ jobId: row.schedule_id, occurrenceAt: time }]
    })
  } catch { return [] }
}

/** Settings live in the platform job table; existing run receipts retain delivery progress. */
export class ScheduleNotifications {
  constructor({ database, platformClient, ownerId, schedules, logger }) {
    Object.assign(this, { database, platformClient, ownerId, schedules, logger })
    this.lifetime = new AbortController()
  }
  async request(body, signal = this.lifetime.signal) {
    const value = await this.platformClient.json({ owner: { ownerId: this.ownerId }, method: 'POST', route: 'jobs',
      body: Buffer.from(JSON.stringify(body)), contentType: 'application/json', timeoutMs: 5000, signal })
    return value.data ?? value
  }
  task(task) {
    return { id: task.id, sessionId: task.sessionId, chatId: task.chat_id, title: task.title }
  }
  async read(tasks) {
    const values = new Map()
    const initializing = new Set(this.database.pendingScheduleInitializations(this.ownerId).map(intent => intent.task.id))
    try {
      for (let offset = 0; offset < tasks.length; offset += 200) {
        const records = await this.request({ action: 'lookup', tasks: tasks.slice(offset, offset + 200).map(task => this.task(task)) })
        if (!Array.isArray(records)) throw httpError(502, '平台任务记录无效')
        for (const record of records) values.set(record.jobId, record)
      }
      this.knownJobs ??= new Map()
      for (const [id, job] of values) {
        if (initializing.has(id)) continue
        if (!this.knownJobs.has(id) || job.version >= this.knownJobs.get(id).version) this.knownJobs.set(id, job)
      }
      if (tasks.every(task => values.has(task.id) && !initializing.has(task.id))) {
        clearTimeout(this.catalogRetry)
        this.catalogRetry = undefined
        this.catalogFailures = 0
      } else this.retryCatalog()
      return tasks.map(task => this.notificationState(task, !values.has(task.id) || initializing.has(task.id), initializing.has(task.id)))
    } catch {
      this.retryCatalog()
      return tasks.map(task => this.notificationState(task, true, initializing.has(task.id)))
    }
  }
  notificationState(task, stale = false, initializing = false) {
    const job = initializing ? undefined : this.knownJobs?.get(task.id)
    return { ...task, ...(job ? { notify_enabled: job.notifyEnabled === true, notification_version: job.version } : {}),
      notification_available: Boolean(job) && !stale, notification_stale: stale }
  }
  retryCatalog() {
    if (this.lifetime.signal.aborted || this.catalogRetry || (this.catalogFailures ?? 0) >= 4) return
    const delay = 500 * 2 ** (this.catalogFailures ?? 0)
    this.catalogFailures = (this.catalogFailures ?? 0) + 1
    this.catalogRetry = setTimeout(() => {
      this.catalogRetry = undefined
      if (!this.lifetime.signal.aborted) this.changed?.()
    }, delay)
    this.catalogRetry.unref?.()
  }
  async sync(tasks, action = 'sync') {
    await this.initializePending(new Set(tasks.map(task => task.id)))
    const values = new Map()
    for (let offset = 0; offset < tasks.length; offset += 200) {
      const records = await this.request({ action, tasks: tasks.slice(offset, offset + 200).map(task => this.task(task)) })
      if (!Array.isArray(records)) throw httpError(502, '平台任务记录无效')
      for (const record of records) values.set(record.jobId, record)
    }
    this.knownJobs ??= new Map()
    for (const [id, job] of values)
      if (!this.knownJobs.has(id) || job.version >= this.knownJobs.get(id).version) this.knownJobs.set(id, job)
    return tasks.map(task => {
      const job = this.knownJobs.get(task.id)
      return { ...task, notify_enabled: job?.notifyEnabled === true, notification_version: job?.version,
        notification_available: Boolean(job) }
    })
  }
  async configure(task, enabled, expectedVersion, signal) {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw httpError(400, '通知设置参数无效')
    const result = await this.request({ action: 'configure', task: this.task(task), notifyEnabled: enabled, expectedVersion }, signal)
    if (result?.jobId) {
      this.knownJobs ??= new Map()
      if (!this.knownJobs.has(result.jobId) || result.version >= this.knownJobs.get(result.jobId).version)
        this.knownJobs.set(result.jobId, result)
    }
    this.changed?.()
    return result
  }
  async initialize(task, createdAt) {
    this.database.rememberScheduleInitialization(this.ownerId, task.chat_id, this.task(task), createdAt)
    await this.initializePending()
  }
  async initializePending(ids) {
    for (const intent of this.database.pendingScheduleInitializations(this.ownerId)) {
      if (ids && !ids.has(intent.task.id)) continue
      await this.request({ action: 'initialize', task: intent.task, createdAt: intent.createdAt })
      this.database.acknowledgeScheduleInitialization(this.ownerId, intent.chatId, intent.task.id)
      this.changed?.()
    }
  }
  async remove(task, signal) {
    this.database.acknowledgeScheduleInitialization(this.ownerId, task.chat_id, task.id)
    return this.request({ action: 'delete', task: this.task(task) }, signal)
  }
  start(ctx) {
    if (this.started) return
    this.started = true
    // Display refreshes must not publish another native schedule snapshot.
    this.changed = () => ctx.emit('workbench/schedule-notifications-changed')
    ctx.on('schedule/changed', () => this.kick(), { global: true })
    ctx.on('workbench/completion', () => this.kick())
    this.kick()
  }
  kick() {
    if (this.lifetime.signal.aborted || this.scheduled) return
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined
      void this.flush().then(() => {
        clearTimeout(this.retry)
        this.retry = undefined
      }, () => {
        this.logger?.warn('定时任务通知暂未送达，将重试未确认回传')
        if (!this.lifetime.signal.aborted && !this.retry) {
          this.retry = setTimeout(() => { this.retry = undefined; this.kick() }, 15_000)
          this.retry.unref?.()
        }
      })
    }, 25)
    this.scheduled.unref?.()
  }
  flush() {
    if (this.pending) { this.again = true; return this.pending }
    this.pending = this.drain().finally(() => {
      this.pending = undefined
      if (this.again) { this.again = false; this.kick() }
    })
    return this.pending
  }
  execution(run, includeDiscarded = false) {
    const seen = new Set()
    while (run?.status === 'steered' && !seen.has(run.id)) {
      seen.add(run.id)
      const target = this.database.steeringEvents(this.ownerId, run.id)
        .findLast(event => event.event === 'workbench_steered')?.steer_target_run_id
      run = target ? this.database.getRun(this.ownerId, target) : undefined
    }
    return run && terminal.has(run.status) && (includeDiscarded || run.status !== 'discarded') ? run : undefined
  }
  async drain() {
    this.lifetime.signal.throwIfAborted()
    // Native creation and its local notification intent cannot share a storage
    // transaction. Do not acknowledge completions while creation is in flight.
    if (this.schedules.nativeCreations) return
    await this.initializePending()
    const pending = this.database.pendingScheduleNotifications(this.ownerId)
    // A removed queue item never executed. Consume its durable receipt even
    // when the platform is unavailable, so it cannot fence later occurrences.
    for (const run of [...pending]) {
      if (this.execution(run, true)?.status !== 'discarded') continue
      this.database.acknowledgeScheduleNotification(this.ownerId, run.id)
      pending.splice(pending.indexOf(run), 1)
    }
    if (!pending.some(run => this.execution(run))) return
    const ids = new Set(pending.flatMap(run =>
      (run.selection.schedule_occurrences ?? scheduleOccurrences(run.query)).map(item => item.jobId)))
    await this.sync((await this.schedules.ownedCatalog({ ownerId: this.ownerId })).filter(task => ids.has(task.id)))
    this.lifetime.signal.throwIfAborted()
    while (pending.length) {
      let progressed = false
      for (const run of [...pending]) {
        this.lifetime.signal.throwIfAborted()
        const occurrences = run.selection.schedule_occurrences ?? scheduleOccurrences(run.query)
        const execution = this.execution(this.database.getRun(this.ownerId, run.id) ?? run, true)
        if (execution?.status === 'discarded') {
          this.database.acknowledgeScheduleNotification(this.ownerId, run.id)
          pending.splice(pending.indexOf(run), 1)
          progressed = true
          continue
        }
        const earlier = pending.some(other => other.id !== run.id &&
          (other.selection.schedule_occurrences ?? scheduleOccurrences(other.query)).some(previous =>
            occurrences.some(item => item.jobId === previous.jobId && item.occurrenceAt > previous.occurrenceAt)))
        if (!execution || earlier) continue
        if (this.schedules.nativeCreations) return
        await this.initializePending()
        const end = this.database.scheduleNotificationEnd(this.ownerId, execution.id)
        const at = end && Date.parse(JSON.parse(end.payload_json).occurred_at)
        const finishedAt = Number.isFinite(at) ? at : end?.created_at ?? execution.updatedAt
        const missing = occurrences.filter(item => !this.knownJobs?.has(item.jobId))
        if (missing.length) await this.sync(missing.map(item => ({ id: item.jobId, sessionId: run.sessionId,
          chat_id: run.chatId, title: run.selection.schedule_titles?.[occurrences.indexOf(item)] || '定时任务' })), 'recover')
        for (let offset = 0; offset < occurrences.length; offset += 200) {
          await this.request({ action: 'complete', runId: run.id, occurrences: occurrences.slice(offset, offset + 200),
            status: execution.status, finishedAt })
        }
        this.lifetime.signal.throwIfAborted()
        // The backend commits its last-notified marker with the notification.
        // A lost acknowledgment therefore retries the same occurrence safely.
        this.database.acknowledgeScheduleNotification(this.ownerId, run.id)
        pending.splice(pending.indexOf(run), 1)
        progressed = true
      }
      if (!progressed) break
    }
  }
  close() {
    clearTimeout(this.catalogRetry)
    clearTimeout(this.retry)
    clearTimeout(this.scheduled)
    this.lifetime.abort()
    void this.pending?.catch(() => {})
  }
}

export function registerScheduleNotificationTool(ctx, { schedules, database, runtime, ownerId }) {
  ctx.tools.register(defineTool({
    name: 'schedule_notification_set',
    description: 'Enable or disable system notifications after each execution of a scheduled task in this conversation. After schedule_create, call this with enabled=true when the user asks to be notified. Notifications default to disabled.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id returned by schedule_create or schedule_list.' },
      enabled: { type: 'boolean', required: true, description: 'Notify the task creator after future scheduled executions.' },
    },
    isConcurrencySafe: () => false,
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, enabled: { type: 'boolean', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.id ?? exec.agent?.id
      const chat = database.getChatBySession(sessionId)
      const run = runtime.executionRun(sessionId)
      if (!chat || chat.ownerId !== ownerId || run?.ownerId !== ownerId || run.status !== 'running'
        || run.stopConfirmation?.fenced || !runtime.scheduler.hasAdmission(sessionId))
        throw httpError(403, '当前智能体没有此任务的设置权限')
      let task = await schedules.task({ ownerId }, args.id)
      if (task.sessionId !== sessionId) throw httpError(404, '定时任务不存在')
      // A native schedule_create can finish before its background wakeup snapshot.
      // This explicit mutation may register the missing row; catalog reads remain read-only.
      if (!task.notification_available && task.notification_version === undefined)
        [task] = await schedules.notifications.sync([task], 'recover')
      if (!task.notification_available) throw httpError(503, '通知设置暂不可用，请稍后重试')
      await schedules.notifications.configure(task, args.enabled, task.notification_version, exec.signal)
      return { id: args.id, enabled: args.enabled }
    },
  }))
}
