import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { projectInboxClaim, projectSessionEvent } from '../src/projection.js'
import { ScheduleNotifications, scheduleOccurrences } from '../src/schedule-notifications.js'
import { WorkbenchSchedules } from '../src/schedules.js'
import { WorkbenchService } from '../src/service.js'

const databases = []
const bridges = []
afterEach(() => {
  bridges.splice(0).forEach(bridge => bridge.close())
  databases.splice(0).forEach(db => db.close())
})
function fixture() {
  const database = new WorkbenchDatabase(':memory:'); databases.push(database)
  const ownerId = 'tenant:7'
  const chat = database.createChat({ ownerId, sessionId: 'session', selection: {} })
  const sent = []
  const platformClient = { json: vi.fn(async request => {
    const body = JSON.parse(request.body)
    sent.push(body)
    return { data: ['sync', 'recover'].includes(body.action) ? body.tasks.map(task => ({ jobId: task.id, notifyEnabled: true, version: 2 })) : ['schedule-one'] }
  }) }
  const schedules = { ownedCatalog: vi.fn(async () => [{ id: 'schedule-one', sessionId: chat.sessionId,
    chat_id: chat.id, title: '提醒' }]) }
  const bridge = new ScheduleNotifications({ database, platformClient, ownerId, schedules })
  bridges.push(bridge)
  function deliver(id = 'message-one', turn = 1, occurrence = '2026-10-20T01:00:00.000Z') {
    const message = { id, source: { kind: 'schedule' }, content: [{ type: 'text',
      text: `schedule_id_json: "schedule-one"\noccurrence_at: ${occurrence}` }] }
    return projectInboxClaim(database, { agent: { id: chat.sessionId }, message, turn }, ownerId, { mcpTools: [] })
  }
  function end(turn = 1, kind = 'completed') {
    projectSessionEvent(database, chat.sessionId, { type: 'turn/end', seq: 10,
      time: '2026-10-20T01:01:00.000Z', data: { turn, reason: { kind } } })
  }
  return { database, ownerId, chat, platformClient, bridge, deliver, end, sent }
}

it('extracts individual occurrences from a native batch without sharing notification settings', () => {
  expect(scheduleOccurrences('reminders_json: [{"schedule_id":"a","occurrence_at":"2026-10-20T01:00:00Z"},{"schedule_id":"b","occurrence_at":"2026-10-20T02:00:00Z"}]'))
    .toEqual([{ jobId: 'a', occurrenceAt: 1792458000000 }, { jobId: 'b', occurrenceAt: 1792461600000 }])
  expect(scheduleOccurrences('reminders_json: invalid')).toEqual([])
})

it('waits for execution completion and acknowledges the durable receipt once', async () => {
  const h = fixture(); h.deliver()
  await h.bridge.flush()
  expect(h.sent.filter(body => body.action === 'complete')).toEqual([])
  h.end()
  await h.bridge.flush(); await h.bridge.flush()
  expect(h.sent.filter(body => body.action === 'complete')).toEqual([{
    action: 'complete', runId: 'message-one', status: 'completed', finishedAt: 1792458060000,
    occurrences: [{ jobId: 'schedule-one', occurrenceAt: 1792458000000 }],
  }])
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toEqual([])
})

it('handles a completion event arriving during an in-flight notification drain', async () => {
  vi.useFakeTimers()
  const h = fixture()
  let finish
  h.bridge.drain = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue(undefined)
  try {
    const first = h.bridge.flush()
    h.bridge.kick()
    await vi.advanceTimersByTimeAsync(25)
    expect(h.bridge.drain).toHaveBeenCalledTimes(1)
    finish()
    await first
    await vi.advanceTimersByTimeAsync(25)
    expect(h.bridge.drain).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.bridge.drain).toHaveBeenCalledTimes(2)
  } finally {
    h.bridge.close()
    vi.useRealTimers()
  }
})

it('retains failed delivery progress for a subsequent process and reuses the same occurrence', async () => {
  const h = fixture(); h.deliver(); h.end()
  h.platformClient.json.mockImplementationOnce(async request => ({ data: JSON.parse(request.body).tasks.map(task => ({ jobId: task.id })) }))
    .mockRejectedValueOnce(new Error('lost response'))
  await expect(h.bridge.flush()).rejects.toThrow('lost response')
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toHaveLength(1)
  const recovered = new ScheduleNotifications({ database: h.database, platformClient: h.platformClient,
    ownerId: h.ownerId, schedules: h.bridge.schedules })
  await recovered.flush()
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toEqual([])
})

it('follows a scheduled message merged into a user turn and notifies only after that turn ends', async () => {
  const h = fixture()
  const { run } = h.database.createRun({ ownerId: h.ownerId, chatId: h.chat.id,
    sessionId: h.chat.sessionId, selection: {}, query: 'ordinary message' })
  h.database.bindRunMessage(h.chat.sessionId, run.id, 1, 'user-message')
  h.deliver()
  expect(h.database.getRun(h.ownerId, 'message-one').status).toBe('steered')
  await h.bridge.flush()
  expect(h.sent.some(body => body.action === 'complete')).toBe(false)
  h.end()
  await h.bridge.flush()
  expect(h.sent.filter(body => body.action === 'complete')).toHaveLength(1)
})

it('reports failed executions and does not scan ordinary completed conversations', async () => {
  const h = fixture(); h.deliver(); h.end(1, 'error')
  await h.bridge.flush()
  expect(h.sent.find(body => body.action === 'complete')?.status).toBe('failed')
  const { run } = h.database.createRun({ ownerId: h.ownerId, chatId: h.chat.id,
    sessionId: h.chat.sessionId, selection: {}, query: 'ordinary' })
  h.database.transitionRun(h.ownerId, run.id, 'completed')
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toEqual([])
})

it('replays occurrences in task order when recovered receipts share a timestamp', async () => {
  const h = fixture()
  h.deliver('z-older', 1, '2026-10-20T00:58:00.000Z'); h.end(1)
  h.deliver('a-newer', 2, '2026-10-20T00:59:00.000Z'); h.end(2)
  h.database.db.prepare('UPDATE runs SET created_at=1').run()
  await h.bridge.flush()
  expect(h.sent.filter(body => body.action === 'complete').map(body => body.runId)).toEqual(['z-older', 'a-newer'])
})

it('registers creation settings and saves notification-only edits without changing native task fields', async () => {
  const h = fixture()
  const record = { id: 'schedule-one', title: '提醒', prompt: '内容', kind: 'daily' }
  const native = { create: vi.fn(async () => record),
    catalog: vi.fn(async () => [{ ...record, sessionId: h.chat.sessionId, status: 'active' }]),
    update: vi.fn(async () => ({ updated: false })) }
  const gateway = new WorkbenchSchedules({ native, database: h.database,
    service: { requireChat: () => h.chat } })
  gateway.notifications = h.bridge
  await gateway.create({ ownerId: h.ownerId }, h.chat.id, { ...record,
    daily: { time: '08:00:00', time_zone: 'Asia/Shanghai' }, notify_enabled: true })
  expect(native.create.mock.calls[0][1]).not.toHaveProperty('notify_enabled')
  expect(h.sent.find(body => body.action === 'initialize')).toMatchObject({
    task: { id: 'schedule-one', sessionId: h.chat.sessionId, chatId: h.chat.id },
    createdAt: expect.any(Number),
  })
  await gateway.update({ ownerId: h.ownerId }, 'schedule-one', {
    expected: record, notify_enabled: false, notification_version: 2,
  })
  expect(native.update).toHaveBeenCalledWith({ sessionId: h.chat.sessionId, id: 'schedule-one', expected: record }, undefined)
  expect(h.sent.filter(body => body.action === 'configure').at(-1)?.notifyEnabled).toBe(false)
})

it('retains the created native task when platform settings cannot be saved', async () => {
  const h = fixture()
  h.platformClient.json.mockRejectedValue(new Error('platform unavailable'))
  const create = vi.fn(async () => ({ id: 'schedule-one', title: '提醒' }))
  const gateway = new WorkbenchSchedules({ native: { create }, database: h.database,
    service: { requireChat: () => h.chat } })
  gateway.notifications = h.bridge
  expect(await gateway.create({ ownerId: h.ownerId }, h.chat.id, { title: '提醒', prompt: '内容', notify_enabled: true }))
    .toMatchObject({ id: 'schedule-one', notification_error: expect.stringContaining('任务已创建') })
  expect(create).toHaveBeenCalledOnce()
})

it('clears removed queue receipts after restart and allows the next occurrence to notify', async () => {
  const h = fixture()
  const message = { id: 'discarded-occurrence', source: { kind: 'schedule' }, content: [{ type: 'text',
    text: 'schedule_id_json: "schedule-one"\noccurrence_at: 2026-10-20T00:58:00Z' }] }
  projectSessionEvent(h.database, h.chat.sessionId, { type: 'agent/inbox/spliced', seq: 1,
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } })
  await WorkbenchService.prototype.removeQueuedMessage.call({
    database: h.database, sessions: { updateQueue: vi.fn(async () => {}) },
  }, { ownerId: h.ownerId }, message.id)
  expect(h.bridge.execution(h.database.getRun(h.ownerId, message.id))).toBeUndefined()
  const recovered = new ScheduleNotifications({ database: h.database, platformClient: h.platformClient,
    ownerId: h.ownerId, schedules: h.bridge.schedules })
  // Cleanup does not need either native or platform availability.
  await recovered.flush()
  expect(h.platformClient.json).not.toHaveBeenCalled()
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toEqual([])
  h.deliver(); h.end()
  await recovered.flush(); await recovered.flush()
  expect(h.sent.filter(item => item.action === 'complete').map(item => item.runId)).toEqual(['message-one'])
})

it('does not synchronize the catalog for ordinary completion events or an empty catalog read', async () => {
  const h = fixture()
  await h.bridge.flush()
  expect(await h.bridge.sync([])).toEqual([])
  expect(h.platformClient.json).not.toHaveBeenCalled()
  expect(h.bridge.schedules.ownedCatalog).not.toHaveBeenCalled()
})

it('observes a queue removal while the notification catalog request is in flight', async () => {
  const h = fixture()
  const old = h.database.createRun({ ownerId: h.ownerId, chatId: h.chat.id, sessionId: h.chat.sessionId,
    selection: { schedule_notification_pending: true, schedule_occurrences: [
      { jobId: 'schedule-one', occurrenceAt: Date.parse('2026-10-20T00:58:00Z') }] }, query: '' }).run
  h.database.transitionRun(h.ownerId, old.id, 'queued')
  h.deliver(); h.end()
  let release
  h.bridge.schedules.ownedCatalog.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = h.bridge.flush()
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  h.database.transitionRun(h.ownerId, old.id, 'discarded')
  release([{ id: 'schedule-one', sessionId: h.chat.sessionId, chat_id: h.chat.id, title: '提醒' }])
  await pending
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toEqual([])
  expect(h.sent.filter(item => item.action === 'complete').map(item => item.runId)).toEqual(['message-one'])
})

it('returns settings per batch and preserves cached registrations when recovering a deleted native task', async () => {
  const h = fixture()
  const tasks = Array.from({ length: 401 }, (_, i) => ({ id: `schedule-${i}`,
    sessionId: h.chat.sessionId, chat_id: h.chat.id, title: `任务${i}` }))
  expect(await h.bridge.sync(tasks)).toHaveLength(401)
  expect(h.sent.map(item => item.tasks.length)).toEqual([200, 200, 1])
  h.deliver(); h.end()
  h.bridge.schedules.ownedCatalog.mockResolvedValue([])
  await h.bridge.flush()
  expect(h.sent.find(item => item.action === 'recover')?.tasks[0].id).toBe('schedule-one')
  expect(h.bridge.knownJobs.has('schedule-400')).toBe(true)
})

it('rejects a stale settings version before changing native rules and exposes a later partial save', async () => {
  const h = fixture()
  let record = { id: 'schedule-one', title: '原名称', prompt: '内容', kind: 'daily' }
  const native = {
    catalog: async () => [{ ...record, sessionId: h.chat.sessionId, status: 'active' }],
    update: vi.fn(async request => { record = { ...record, title: request.title }; return { updated: true, record } }),
  }
  const gateway = new WorkbenchSchedules({ native, database: h.database, service: {} })
  gateway.notifications = {
    sync: async tasks => tasks.map(task => ({ ...task, notification_available: true, notification_version: 3 })),
    configure: vi.fn().mockRejectedValueOnce(new Error('lost settings response')).mockResolvedValue({}),
  }
  await expect(gateway.update({ ownerId: h.ownerId }, record.id, {
    title: '新名称', expected: record, notify_enabled: true, notification_version: 2,
  })).rejects.toMatchObject({ status: 409 })
  expect(native.update).not.toHaveBeenCalled()
  const result = await gateway.update({ ownerId: h.ownerId }, record.id, {
    title: '新名称', expected: record, notify_enabled: true, notification_version: 3,
  })
  expect(result).toMatchObject({ updated: true, record: { title: '新名称' }, notification_version: 3,
    notification_error: expect.stringContaining('任务规则已保存') })
  await expect(gateway.update({ ownerId: h.ownerId }, record.id, {
    title: '新名称', expected: result.record, notify_enabled: true, notification_version: result.notification_version,
  })).resolves.not.toHaveProperty('notification_error')
})
