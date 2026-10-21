import { expect, it } from 'vitest'
import { ScheduleWakeups } from '../packages/workbench-adapter/src/schedule-wakeups.js'
import { ScheduleNotifications } from '../packages/workbench-adapter/src/schedule-notifications.js'
import { WorkbenchDatabase } from '../packages/workbench-adapter/src/persistence.js'
import { createSchedulePlatformFixture } from './smoke-schedule-platform.mjs'

it('accepts actual wakeup and notification bridge requests through bootstrap registration and deletion', async () => {
  const fixture = createSchedulePlatformFixture()
  const database = new WorkbenchDatabase(':memory:')
  let tasks = []
  const ownerId = 'fixture:1'
  const chat = database.createChat({ ownerId, sessionId: 'session-one', selection: {} })
  const platformClient = { json: async request => {
    expect(request.owner.ownerId).toBe(ownerId)
    const data = fixture(request.method, `/internal/workbench/${request.route}`, JSON.parse(request.body))
    expect(data).not.toBeUndefined()
    return { data }
  } }
  const schedules = { ownedCatalog: async () => tasks }
  const wakeups = new ScheduleWakeups({ database, ownerId, platformClient, schedules })
  const notifications = new ScheduleNotifications({ database, ownerId, platformClient, schedules })
  try {
    wakeups.started = true
    await wakeups.flush()
    expect(wakeups.safety(tasks)).toEqual({ registeredSchedules: 0, pendingScheduleReports: 0 })
    tasks = [{ id: 'job-one', sessionId: chat.sessionId, chat_id: chat.id, title: 'Fixture reminder',
      status: 'active', kind: 'once', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }]
    await wakeups.flush()
    expect(wakeups.safety(tasks)).toEqual({ registeredSchedules: 1, pendingScheduleReports: 0 })
    const [before] = await notifications.read(tasks)
    expect(before).toMatchObject({ notify_enabled: false, notification_available: true, notification_version: 1 })
    await notifications.initialize(tasks[0], Date.now())
    expect(database.pendingScheduleInitializations(ownerId)).toEqual([])
    const [enabled] = await notifications.read(tasks)
    expect(enabled).toMatchObject({ notify_enabled: true, notification_version: 2 })
    await notifications.configure(tasks[0], false, enabled.notification_version)
    expect((await notifications.read(tasks))[0]).toMatchObject({ notify_enabled: false, notification_version: 3 })
    await expect(notifications.configure(tasks[0], true, enabled.notification_version)).rejects.toThrow()
    await notifications.remove(tasks[0])
    tasks = []
    await wakeups.flush()
    expect(wakeups.safety(tasks)).toEqual({ registeredSchedules: 0, pendingScheduleReports: 0 })
  } finally {
    notifications.close()
    wakeups.close()
    database.close()
  }
})

it('keeps catalog reads from registering jobs or overwriting titles', () => {
  const fixture = createSchedulePlatformFixture()
  const route = '/internal/workbench/jobs'
  const task = { id: 'job', sessionId: 'session', chatId: 'chat', title: 'Original' }
  expect(fixture('POST', route, { action: 'lookup', tasks: [task] })).toEqual([])
  fixture('POST', route, { action: 'sync', tasks: [task] })
  expect(fixture('POST', route, { action: 'lookup', tasks: [{ ...task, title: 'Stale' }] }))
    .toMatchObject([{ title: 'Original', version: 1, notifyEnabled: false }])
})

it('rejects malformed snapshots, changed bindings and unsupported fixture requests', () => {
  const fixture = createSchedulePlatformFixture()
  const route = '/internal/workbench/schedule-wakeups'
  const task = { id: 'job', sessionId: 'session', chatId: 'chat', title: 'Fixture',
    status: 'active', scheduledAt: Date.now() + 3600_000, revision: 'a'.repeat(64) }
  expect(() => fixture('POST', route, { sequence: 0, tasks: [] })).toThrow()
  expect(() => fixture('POST', route, { sequence: 1, tasks: [{ ...task, revision: 'bad' }] })).toThrow()
  expect(fixture('POST', route, { sequence: 1, tasks: [task] })).toMatchObject({ sequence: 1, complete: true })
  expect(() => fixture('POST', route, { sequence: 1, tasks: [] })).toThrow('Same sequence changed its snapshot')
  expect(() => fixture('POST', '/internal/workbench/jobs', { action: 'sync', tasks: [{ ...task, chatId: 'other' }] })).toThrow('Job chat binding changed')
  expect(() => fixture('POST', '/internal/workbench/jobs', { action: 'unknown' })).toThrow('Unexpected smoke job action')
  expect(fixture('GET', route, {})).toBeUndefined()
  expect(fixture('POST', '/internal/workbench/unexpected', {})).toBeUndefined()
})
