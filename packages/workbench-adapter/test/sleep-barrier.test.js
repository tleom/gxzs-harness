import { afterEach, expect, it, vi } from 'vitest'
import { SleepBarrier } from '../src/sleep-barrier.js'

afterEach(() => vi.unstubAllEnvs())
function fixture() {
  vi.stubEnv('GXZS_SANDBOX_MANAGER_TOKEN', 'manager-secret')
  return { barrier: new SleepBarrier(), activity: { protocol: 2, status: 'ready', runningAgents: 0, pendingMessages: 0,
    runningJobs: 0, activeSidebarResources: 0, activeSettingsWrites: 0, pendingScheduleReports: 0,
    activeSchedules: 2, registeredSchedules: 2 } }
}
it('authenticates the manager before freezing writes or reading private activity', async () => {
  const h = fixture(); const read = vi.fn(async () => h.activity)
  await expect(h.barrier.prepare('Bearer wrong', read, {})).rejects.toMatchObject({ status: 401 })
  expect(read).not.toHaveBeenCalled(); expect(h.barrier.until).toBe(0)
})
it('blocks new requests throughout a bounded shutdown handoff', async () => {
  const h = fixture()
  await h.barrier.prepare('Bearer manager-secret', async () => h.activity, { generation: 3 })
  expect(() => h.barrier.enter()).toThrow()
  expect(h.barrier.until).toBeGreaterThan(Date.now() + 55_000)
  h.barrier.until = Date.now() - 1
  expect(() => h.barrier.assertAwake()).not.toThrow()
})
it.each(['runningAgents', 'pendingMessages', 'runningJobs', 'activeSidebarResources', 'activeSettingsWrites', 'pendingScheduleReports'])(
  'refuses shutdown while %s is present and releases the temporary barrier', async key => {
    const h = fixture(); h.activity[key] = 1
    await expect(h.barrier.prepare('Bearer manager-secret', async () => h.activity, {})).rejects.toMatchObject({ status: 409 })
    expect(h.barrier.until).toBe(0)
  })
it('refuses an unregistered or approaching native reminder', async () => {
  const h = fixture(); h.activity.registeredSchedules = 1
  await expect(h.barrier.prepare('Bearer manager-secret', async () => h.activity, {})).rejects.toMatchObject({ status: 409 })
})
it('refuses writes already accepted before preparation', async () => {
  const h = fixture(); const release = h.barrier.enter()
  await expect(h.barrier.prepare('Bearer manager-secret', async () => h.activity, {})).rejects.toMatchObject({ status: 409 })
  release(); release()
  expect(h.barrier.requests).toBe(0)
})
