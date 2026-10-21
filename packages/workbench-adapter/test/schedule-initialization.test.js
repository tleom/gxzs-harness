import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { ScheduleNotifications } from '../src/schedule-notifications.js'
import { WorkbenchSchedules } from '../src/schedules.js'

const cleanup = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))

function fixture(path = ':memory:') {
  const database = new WorkbenchDatabase(path)
  cleanup.push(() => database.close())
  const ownerId = 'tenant:7'
  const chat = database.chatBindings(ownerId)[0]
    ?? database.createChat({ ownerId, sessionId: 'session', selection: {} })
  const task = { id: 'schedule-one', sessionId: chat.sessionId, chat_id: chat.id, title: '提醒' }
  const native = { create: vi.fn(async () => task), catalog: vi.fn(async () => [task]) }
  const schedules = new WorkbenchSchedules({ native, database, service: { requireChat: () => chat } })
  const reports = []
  const platformClient = { json: vi.fn(async ({ body }) => {
    const request = JSON.parse(body)
    reports.push(request)
    return { data: request.tasks ? request.tasks.map(item => ({ jobId: item.id, notifyEnabled: true, version: 2 })) : {} }
  }) }
  const bridge = new ScheduleNotifications({ database, platformClient, ownerId, schedules })
  schedules.notifications = bridge
  cleanup.push(() => bridge.close())
  function complete() {
    const { run } = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: '',
      selection: { schedule_notification_pending: true, schedule_occurrences: [{ jobId: task.id, occurrenceAt: Date.now() }] } })
    database.transitionRun(ownerId, run.id, 'completed')
  }
  return { database, ownerId, chat, task, native, schedules, bridge, platformClient, reports, complete }
}

it('does not acknowledge a completion while the native create or initialization is still pending', async () => {
  const h = fixture()
  let releaseNative, releaseInitialization
  h.native.create.mockImplementationOnce(() => new Promise(resolve => { releaseNative = resolve }))
  h.platformClient.json.mockImplementationOnce(() => new Promise(resolve => { releaseInitialization = resolve }))
  const creating = h.schedules.create({ ownerId: h.ownerId }, h.chat.id, {
    request_key: 'logical', title: '提醒', prompt: '内容', after_seconds: 1, notify_enabled: true,
  })
  h.complete()
  await h.bridge.flush()
  expect(h.platformClient.json).not.toHaveBeenCalled()
  releaseNative(h.task)
  await vi.waitFor(() => expect(releaseInitialization).toBeTypeOf('function'))
  await h.bridge.flush()
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toHaveLength(1)
  releaseInitialization({ data: {} })
  await creating
  await h.bridge.flush()
  expect(h.reports.filter(item => item.action === 'complete')).toHaveLength(1)
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toHaveLength(0)
})

it('retains completion until a failed creation initialization can be retried', async () => {
  const h = fixture()
  h.platformClient.json.mockRejectedValueOnce(new Error('unavailable'))
  expect(await h.schedules.create({ ownerId: h.ownerId }, h.chat.id, {
    title: '提醒', prompt: '内容', notify_enabled: true,
  })).toHaveProperty('notification_error')
  h.complete()
  h.platformClient.json.mockRejectedValueOnce(new Error('still unavailable'))
  await expect(h.bridge.flush()).rejects.toThrow('still unavailable')
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toHaveLength(1)
  expect(h.reports.some(item => item.action === 'complete')).toBe(false)
  await h.bridge.flush()
  expect(h.reports.findIndex(item => item.action === 'initialize'))
    .toBeLessThan(h.reports.findIndex(item => item.action === 'complete'))
  expect(h.database.pendingScheduleNotifications(h.ownerId)).toHaveLength(0)
})

it('recovers initialization from the same SQLite database after a process restart', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.schedule-initialization-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.sqlite')
  const first = fixture(path)
  const createdAt = Date.now() - 2000
  first.database.rememberScheduleInitialization(first.ownerId, first.chat.id, first.bridge.task(first.task), createdAt)
  first.complete()
  cleanup.pop()()
  cleanup.pop()()
  const recovered = fixture(path)
  await recovered.bridge.flush()
  expect(recovered.reports[0]).toMatchObject({ action: 'initialize', createdAt })
  expect(recovered.reports.at(-1)).toMatchObject({ action: 'complete' })
  expect(recovered.database.pendingScheduleInitializations(recovered.ownerId)).toHaveLength(0)
  await recovered.bridge.flush()
  expect(recovered.reports.filter(item => item.action === 'initialize')).toHaveLength(1)
})

it('does not retry a creation intent cancelled by explicit deletion', async () => {
  const h = fixture()
  h.database.rememberScheduleInitialization(h.ownerId, h.chat.id, h.bridge.task(h.task), Date.now())
  await h.bridge.remove(h.task)
  await h.bridge.flush()
  expect(h.reports.map(item => item.action)).toEqual(['delete'])
})

it('does not display the default disabled value while creation initialization is unresolved', async () => {
  const h = fixture()
  h.database.rememberScheduleInitialization(h.ownerId, h.chat.id, h.bridge.task(h.task), Date.now())
  h.platformClient.json.mockRejectedValueOnce(new Error('unavailable'))
  expect(await h.schedules.catalog({ ownerId: h.ownerId }))
    .toEqual([expect.objectContaining({ notification_available: false })])
  expect(h.reports).toEqual([])
  await h.bridge.flush()
  const tasks = await h.schedules.catalog({ ownerId: h.ownerId })
  expect(tasks[0]).toMatchObject({ notification_available: true, notify_enabled: true })
  expect(h.reports.map(item => item.action)).toEqual(['initialize', 'lookup'])
})
