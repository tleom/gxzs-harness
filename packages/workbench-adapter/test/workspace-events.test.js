import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { streamWorkspaceEvents } from '../src/workspace-events.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function setup(baseline = vi.fn(async () => ({ items: [] }))) {
  const res = new EventEmitter()
  res.writeHead = vi.fn(); res.write = vi.fn(() => true); res.end = vi.fn()
  let notify, followSignal
  const unsubscribe = vi.fn()
  const workspaces = { baseline, controller: { async *follow(signal) {
    followSignal = signal
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
  } } }
  const close = streamWorkspaceEvents({ workspaces, owner: {}, res, subscribe: fn => { notify = fn; return unsubscribe } })
  return { res, baseline, close, notify: () => notify(), unsubscribe, signal: () => followSignal }
}
describe('native workspace event transport', () => {
  it('coalesces changes while a snapshot is pending and cancels on disconnect', async () => {
    let complete
    const baseline = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve })).mockResolvedValue({ items: [] })
    const s = setup(baseline)
    await tick()
    for (let i=0; i<100; i++) s.notify()
    expect(baseline).toHaveBeenCalledTimes(1)
    complete({ items: [] }); await tick(); await tick()
    expect(baseline).toHaveBeenCalledTimes(2)
    s.res.emit('close')
    expect(s.signal().aborted).toBe(true)
    expect(baseline.mock.calls[0][1].aborted).toBe(true)
    expect(s.unsubscribe).toHaveBeenCalledTimes(1)
    s.notify(); await tick()
    expect(baseline).toHaveBeenCalledTimes(2)
  })
  it('retains one pending update for a slow reader until drain', async () => {
    const s = setup(); s.res.write.mockReturnValueOnce(false)
    await tick()
    for (let i=0; i<100; i++) s.notify()
    await tick(); expect(s.baseline).toHaveBeenCalledTimes(1)
    s.res.emit('drain'); await tick()
    expect(s.baseline).toHaveBeenCalledTimes(2)
    s.close()
  })
  it('closes on projection failure so the client can reconnect', async () => {
    const s = setup(vi.fn().mockRejectedValue(new Error('offline')))
    await tick()
    expect(s.res.end).toHaveBeenCalledTimes(1)
    expect(s.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
