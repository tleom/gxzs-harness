import { expect, it, vi } from 'vitest'
import { nativeHostActivity } from '../packages/workbench-adapter/src/host-activity.js'
import { WorkbenchSubagentSettings } from '../packages/workbench-adapter/src/settings.js'
import { SleepBarrier } from '../packages/workbench-adapter/src/sleep-barrier.js'

it.each([true, false])('retains both protocol 2 settings holds until Manager acceptance=%s settles', async accepted => {
  let admit, refuse
  const gate = new Promise((resolve, reject) => { admit = resolve; refuse = reject })
  const controller = { mutate: vi.fn(async () => ({ revision: 2 })) }
  const settings = new WorkbenchSubagentSettings({ controller: () => controller, assertWritable: () => gate })
  const barrier = new SleepBarrier()
  const ctx = {
    get: name => name === 'schedule' ? { catalog: async () => [] } : undefined,
    agents: { list: () => [] }, jobs: { list: () => [] },
  }
  // Match the composed Host's independent native-write and HTTP-request holds.
  const activity = () => nativeHostActivity(ctx, undefined, () => settings.activeWrites + barrier.requests,
    () => ({ registeredSchedules: 0, pendingScheduleReports: 0 }))
  const leave = barrier.enter()
  const result = settings.mutate({ ownerId: 'fixture:1' }, {
    ns: 'subagent', expectedRevision: 1, ops: [{ op: 'set', path: ['maxDepth'], value: 3 }],
  }).finally(leave).then(value => ({ value }), error => ({ error }))
  expect(await activity()).toMatchObject({ protocol: 2, status: 'ready', activeSettingsWrites: 2 })
  expect(controller.mutate).not.toHaveBeenCalled()
  if (accepted) admit()
  else refuse(Object.assign(new Error('Host draining'), { status: 503 }))
  const outcome = await result
  if (accepted) expect(outcome.value).toEqual({ revision: 2 })
  else expect(outcome.error).toMatchObject({ status: 503 })
  expect(controller.mutate).toHaveBeenCalledTimes(accepted ? 1 : 0)
  expect(await activity()).toMatchObject({ protocol: 2, status: 'ready', activeSettingsWrites: 0 })
})
