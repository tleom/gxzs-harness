import { describe, expect, it, vi } from 'vitest'
import { RunEventBus } from '../src/events.js'

describe('live run event bus', () => {
  it('publishes committed events and disposes listeners idempotently', () => {
    const bus = new RunEventBus()
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = bus.subscribe('run-1', first)
    bus.subscribe('run-1', second)
    bus.publish('run-1', { event: 'one' })
    disposeFirst()
    disposeFirst()
    bus.publish('run-1', { event: 'two' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('isolates a throwing listener from the event producer and other listeners', () => {
    const bus = new RunEventBus()
    const healthy = vi.fn()
    bus.subscribe('run-1', () => { throw new Error('disconnected') })
    bus.subscribe('run-1', healthy)
    expect(() => bus.publish('run-1', { event: 'one' })).not.toThrow()
    expect(healthy).toHaveBeenCalledOnce()
  })

  it('does not cross run boundaries', () => {
    const bus = new RunEventBus()
    const listener = vi.fn()
    bus.subscribe('run-1', listener)
    bus.publish('run-2', { event: 'other' })
    expect(listener).not.toHaveBeenCalled()
  })
})
