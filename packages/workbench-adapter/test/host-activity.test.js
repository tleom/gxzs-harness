import { expect, it, vi } from 'vitest'
import { nativeHostActivity } from '../src/host-activity.js'

function fixture() {
  const agents = [{ id: 'root', status: 'idle', inbox: { nextTurn: [], nextStep: [] } },
    { id: 'grandchild', status: 'running', inbox: { nextTurn: [], nextStep: [{ id: 'queued' }] } }]
  const unowned = { id: 'unowned', status: 'running' }
  const read = vi.fn()
  const jobs = { list: vi.fn(id => id === 'grandchild' ? [unowned, { id: 'owned', status: 'stopping' }]
    : [unowned, { id: 'finished', status: 'completed' }]), read }
  const schedule = { catalog: vi.fn(async () => [{ status: 'active', scheduledAt: '2099-01-01T00:00:00Z' }, { status: 'inactive' }]) }
  return { agents, jobs, schedule, ctx: { get: () => schedule, agents: { list: () => agents }, jobs } }
}

it('keeps native descendant work, pending inbox, owned/unowned Jobs and future reminders visible without consuming them', async () => {
  const test = fixture()
  expect(await nativeHostActivity(test.ctx)).toEqual({ protocol: 1, status: 'ready',
    runningAgents: 1, pendingMessages: 1, runningJobs: 2, activeSchedules: 1, activeSidebarResources: 0, activeSettingsWrites: 0 })
  expect(test.jobs.read).not.toHaveBeenCalled()
  expect(test.jobs.list).toHaveBeenCalledWith('grandchild')
})

it('samples live work after a catalog await and allows a fully idle Host', async () => {
  const test = fixture()
  test.agents.length = 0
  test.jobs.list.mockReturnValue([])
  test.schedule.catalog.mockImplementation(async () => {
    test.agents.push({ id: 'new', status: 'running', inbox: { nextTurn: [], nextStep: [] } })
    return []
  })
  expect((await nativeHostActivity(test.ctx)).runningAgents).toBe(1)
  test.agents.length = 0
  test.schedule.catalog.mockResolvedValue([{ status: 'inactive' }])
  expect(await nativeHostActivity(test.ctx)).toEqual({ protocol: 1, status: 'ready',
    runningAgents: 0, pendingMessages: 0, runningJobs: 0, activeSchedules: 0, activeSidebarResources: 0, activeSettingsWrites: 0 })
})

it('does not turn missing services or failed native reads into an idle Host', async () => {
  const test = fixture()
  test.schedule.catalog.mockRejectedValue(new Error('unavailable'))
  expect(await nativeHostActivity(test.ctx)).toEqual({ protocol: 1, status: 'unknown' })
  expect(await nativeHostActivity({ get: () => undefined })).toEqual({ protocol: 1, status: 'unknown' })
})

it('honors live sidebar resources and rejects an incomplete hold read', async () => {
  const test = fixture()
  expect((await nativeHostActivity(test.ctx, () => ({ browser: 1, terminal: 2 }))).activeSidebarResources).toBe(3)
  expect(await nativeHostActivity(test.ctx, () => ({ browser: 0 }))).toEqual({ protocol: 1, status: 'unknown' })
})
it('samples pending native settings writes after the async catalog read and never treats an invalid counter as idle', async () => {
  const test=fixture();let writes=0
  test.schedule.catalog.mockImplementation(async()=>{writes=1;return []})
  expect((await nativeHostActivity(test.ctx,undefined,()=>writes)).activeSettingsWrites).toBe(1)
  expect(await nativeHostActivity(test.ctx,undefined,()=>undefined)).toEqual({protocol:1,status:'unknown'})
})
