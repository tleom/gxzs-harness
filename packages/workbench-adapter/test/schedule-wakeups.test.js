import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { ScheduleWakeups, PREWARM_MS, scheduleRevision } from '../src/schedule-wakeups.js'

const cleanups = []
afterEach(() => { cleanups.splice(0).forEach(clean => clean()); vi.useRealTimers() })
function fixture() {
  const database = new WorkbenchDatabase(':memory:')
  let tasks = [{ id: 'one', sessionId: 'session', chat_id: 'chat', title: '提醒', prompt: '内容', status: 'active',
    kind: 'cron', expression: '0 8 * * 1,3,5', timeZone: 'Asia/Shanghai', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }]
  const hooks = new Map()
  const platformClient = { json: vi.fn(async request => {
    const body = JSON.parse(request.body)
    return { data: { sequence: body.sequence, complete: true,
      tasks: body.tasks.map(task => ({ ...task, registered: true })) } }
  }) }
  const bridge = new ScheduleWakeups({ database, ownerId: 'tenant:7', platformClient,
    schedules: { ownedCatalog: async () => tasks } })
  const ctx = { on: (name, listener) => hooks.set(name, listener) }
  cleanups.push(() => { bridge.close(); database.close() })
  return { bridge, database, platformClient, hooks, ctx, get tasks() { return tasks }, set tasks(value) { tasks = value } }
}

it('registers concrete native UTC instants without translating cron or notification preferences', async () => {
  const h = fixture(); h.bridge.started = true
  await h.bridge.flush()
  expect(JSON.parse(h.platformClient.json.mock.calls[0][0].body)).toMatchObject({ sequence: 1,
    tasks: [{ id: 'one', scheduledAt: Date.parse(h.tasks[0].scheduledAt), revision: scheduleRevision(h.tasks[0]) }] })
  expect(h.bridge.safety(h.tasks)).toEqual({ registeredSchedules: 1, pendingScheduleReports: 0 })
})
it('holds sleep until registration is confirmed, including when a response was lost', async () => {
  const h = fixture(); h.bridge.started = true
  h.platformClient.json.mockRejectedValueOnce(new Error('lost response'))
  await expect(h.bridge.flush()).rejects.toThrow('lost response')
  expect(h.bridge.safety(h.tasks).registeredSchedules).toBe(0)
  await h.bridge.flush()
  expect(JSON.parse(h.platformClient.json.mock.calls[1][0].body).sequence).toBe(1)
  expect(h.bridge.safety(h.tasks).registeredSchedules).toBe(1)
})
it('invalidates a deleted or edited catalog even if a change event was missed', async () => {
  const h = fixture(); h.bridge.started = true; await h.bridge.flush()
  h.tasks = [{ ...h.tasks[0], prompt: '新的任务' }]
  expect(h.bridge.safety(h.tasks)).toEqual({ registeredSchedules: 0, pendingScheduleReports: 1 })
  await h.bridge.flush()
  expect(JSON.parse(h.platformClient.json.mock.calls[1][0].body).sequence).toBe(2)
  h.tasks = []
  expect(h.bridge.safety(h.tasks).pendingScheduleReports).toBe(1)
  await h.bridge.flush()
  expect(JSON.parse(h.platformClient.json.mock.calls[2][0].body)).toMatchObject({ sequence: 3, tasks: [] })
})
it('keeps the environment resident throughout the five minute prewarm window', async () => {
  const h = fixture(); h.bridge.started = true; await h.bridge.flush()
  expect(PREWARM_MS).toBe(300_000)
  expect(h.bridge.safety(h.tasks, Date.parse(h.tasks[0].scheduledAt) - PREWARM_MS).registeredSchedules).toBe(0)
})
it('does not poll a successfully registered catalog', async () => {
  vi.useFakeTimers(); const h = fixture(); h.bridge.start(h.ctx)
  await vi.advanceTimersByTimeAsync(30)
  expect(h.platformClient.json).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(h.platformClient.json).toHaveBeenCalledTimes(1)
  h.tasks = []; h.hooks.get('schedule/changed')()
  await vi.advanceTimersByTimeAsync(30)
  expect(h.platformClient.json).toHaveBeenCalledTimes(2)
})
it('persists snapshot sequences independently of display and notification settings', () => {
  const h = fixture()
  expect(h.database.scheduleSyncSequence('tenant:7', 'a')).toBe(1)
  expect(h.database.scheduleSyncSequence('tenant:7', 'a')).toBe(1)
  expect(h.database.scheduleSyncSequence('tenant:7', 'b')).toBe(2)
  expect(h.database.scheduleSyncSequence('tenant:8', 'a')).toBe(1)
})
