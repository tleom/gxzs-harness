import { expect, it } from 'vitest'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { WorkbenchDatabase } from '../src/persistence.js'
import { projectSessionEvent, reconcileNativeSessions } from '../src/projection.js'

const title = (seq, value) => ({ seq, type: 'session/title', data: { title: value } })
const goal = (seq, objective) => ({ seq, type: 'goal/change', data: {
  operation: 'edit', goal: { id: 'goal', revision: seq, phase: 'paused', objective },
} })

it('applies live title and goal changes after the older snapshot across replay yields', async () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
    const events = Array.from({ length: 96 }, (_, i) => i === 94 ? goal(i, 'old goal') : title(i, 'old title'))
    const live = [title(96, 'new title'), goal(97, 'new goal')]
    let observed = false, disposed = false
    const query = { observeSession: async () => { observed = true; return { events, [Symbol.dispose]() { disposed = true } } } }
    const recovery = reconcileNativeSessions(db, query, 'owner')
    await yieldToEventLoop()
    expect(observed).toBe(true)
    expect(disposed).toBe(false)
    for (const event of live) projectSessionEvent(db, 'session', event, 'owner')
    expect(db.hasProjectedEvent('session', 96)).toBe(false)
    await recovery
    expect(disposed).toBe(true)
    expect(db.getChat('owner', 'chat').title).toBe('new title')
    expect(db.getControl('owner', 'chat').goal.objective).toBe('new goal')
    expect(db.hasProjectedEvent('session', 97)).toBe(true)
    await reconcileNativeSessions(db, { observeSession: async () => ({ events: [...events, ...live] }) }, 'owner')
    expect(db.getChat('owner', 'chat').title).toBe('new title')
    expect(db.getControl('owner', 'chat').goal.objective).toBe('new goal')
    projectSessionEvent(db, 'session', title(98, 'after recovery'), 'owner')
    expect(db.getChat('owner', 'chat').title).toBe('after recovery')
  } finally { db.close() }
})

it('leaves buffered facts replayable on failure and releases the observation and barrier', async () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
    const events = Array.from({ length: 96 }, (_, i) => title(i, 'old title'))
    let disposed = false
    const projected = db.hasProjectedEvent.bind(db)
    db.hasProjectedEvent = (session, seq) => { if (seq === 40) throw new Error('projection failure'); return projected(session, seq) }
    const recovery = reconcileNativeSessions(db, { observeSession: async () => ({ events, [Symbol.dispose]() { disposed = true } }) }, 'owner')
    const failed = expect(recovery).rejects.toThrow('projection failure')
    await yieldToEventLoop()
    const live = title(96, 'live title')
    projectSessionEvent(db, 'session', live, 'owner')
    await failed
    expect(disposed).toBe(true)
    expect(projected('session', live.seq)).toBe(false)
    db.hasProjectedEvent = projected
    await reconcileNativeSessions(db, { observeSession: async () => ({ events: [...events, live] }) }, 'owner')
    expect(db.getChat('owner', 'chat').title).toBe('live title')
    expect(projected('session', live.seq)).toBe(true)
  } finally { db.close() }
})
