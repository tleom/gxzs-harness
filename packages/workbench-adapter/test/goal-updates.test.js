import { expect, it, vi } from 'vitest'
import { withGoalUpdates } from '../src/goal-updates.js'

it('delivers activation while a native read is pending without duplicating or dropping that read', async () => {
  const abort = new AbortController()
  let push, changed
  const dispose = vi.fn()
  const next = vi.fn(() => new Promise(resolve => { push = resolve }))
  const source = { [Symbol.asyncIterator]() { return this }, next, return: vi.fn(async () => ({ done: true })) }
  const stream = withGoalUpdates(source, listener => { changed = listener; return dispose }, abort.signal)
  const first = stream.next()
  changed()
  expect((await first).value.type).toBe('goal-state')
  const second = stream.next()
  push({ value: { type: 'event', event: { type: 'goal/change' } }, done: false })
  expect((await second).value.event.type).toBe('goal/change')
  expect(next).toHaveBeenCalledTimes(1)
  const third = stream.next()
  abort.abort()
  expect((await third).done).toBe(true)
  expect(dispose).toHaveBeenCalledOnce()
  expect(source.return).toHaveBeenCalledOnce()
})

it('propagates native read failures and unsubscribes activation', async () => {
  const dispose = vi.fn()
  async function* failed() { throw new Error('native failure') }
  const stream = withGoalUpdates(failed(), () => dispose, new AbortController().signal)
  await expect(stream.next()).rejects.toThrow('native failure')
  expect(dispose).toHaveBeenCalledOnce()
})
