import { expect, it } from 'vitest'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { WorkbenchDatabase } from '../src/persistence.js'
import { createAssistantStreamProjector, projectInboxClaim, projectSessionEvent, reconcileNativeSessions } from '../src/projection.js'

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

function runningChat(db) {
  db.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
  db.createRun({ id: 'run', ownerId: 'owner', chatId: 'chat', sessionId: 'session', query: 'work', selection: {} })
  db.bindRunMessage('session', 'run', 1, 'message')
  db.transitionRun('owner', 'run', 'running')
}
const answer = (seq, text, step = 1) => ({ seq, type: 'assistant/message', data: {
  turn: 1, step, message: { content: [{ type: 'text', text }] },
} })
const narrative = db => db.allEvents('owner', 'run').filter(event => event.data?.kind === 'text').map(event => event.data.text)
function streamAnswer(project, text, step, seq) {
  const agent = { id: 'session' }
  project({ agent, frame: { type: 'start', attemptId: 'attempt', turn: 1, step } })
  project({ agent, frame: { type: 'chunk', attemptId: 'attempt', chunk: { type: 'text-delta', index: 0, text } } })
  project({ agent, frame: { type: 'end', attemptId: 'attempt', outcome: { kind: 'committed', eventType: 'assistant/message', seq } } })
}

it('projects an identical unsequenced snapshot/live occurrence once', async () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    runningChat(db)
    const event = answer(undefined, 'one answer')
    await reconcileNativeSessions(db, { observeSession: async () => {
      projectSessionEvent(db, 'session', event, 'owner')
      return { events: [event] }
    } }, 'owner')
    expect(narrative(db)).toEqual(['one answer'])
  } finally { db.close() }
})

it('preserves a live inbox claim instead of requeueing or interrupting it', async () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
    db.createRun({ id: 'run', ownerId: 'owner', chatId: 'chat', sessionId: 'session', query: 'work', selection: {} })
    const message = { id: 'message', source: { kind: 'user', rpcId: 'run' }, content: [] }
    const events = Array.from({ length: 96 }, (_, i) => title(i, 'title'))
    events[0] = { seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } }
    const recovery = reconcileNativeSessions(db, { observeSession: async () => ({ events }) }, 'owner')
    await yieldToEventLoop()
    projectInboxClaim(db, { agent: { id: 'session' }, message, turn: 1 }, 'owner')
    expect(await recovery).toEqual([])
    expect(db.getRun('owner', 'run').status).toBe('running')
    expect(db.pendingRunFences('owner')).toEqual([])
  } finally { db.close() }
})

it('keeps live stream deltas behind older snapshot messages', async () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    runningChat(db)
    const events = Array.from({ length: 96 }, (_, i) => title(i, 'title'))
    events[95] = answer(95, 'older answer')
    const project = createAssistantStreamProjector(db, 'owner')
    const recovery = reconcileNativeSessions(db, { observeSession: async () => ({ events }) }, 'owner')
    await yieldToEventLoop()
    streamAnswer(project, 'live answer', 2, 97)
    projectSessionEvent(db, 'session', answer(97, 'live answer', 2), 'owner')
    await recovery
    expect(narrative(db)).toEqual(['older answer', 'live answer'])
  } finally { db.close() }
})

it('does not repeat buffered deltas represented by a snapshot final message', async () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    runningChat(db)
    const project = createAssistantStreamProjector(db, 'owner')
    const event = answer(1, 'one answer')
    await reconcileNativeSessions(db, { observeSession: async () => {
      streamAnswer(project, 'one answer', 1, 1)
      projectSessionEvent(db, 'session', event, 'owner')
      return { events: [event] }
    } }, 'owner')
    expect(narrative(db)).toEqual(['one answer'])
  } finally { db.close() }
})

it('keeps live facts ordered across a failed recovery and the interval before retry', async () => {
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
    const later = title(97, 'later title')
    projectSessionEvent(db, 'session', later, 'owner')
    expect(projected('session', later.seq)).toBe(false)
    db.hasProjectedEvent = projected
    await reconcileNativeSessions(db, { observeSession: async () => ({ events: [...events, live, later] }) }, 'owner')
    expect(db.getChat('owner', 'chat').title).toBe('later title')
    expect(projected('session', live.seq)).toBe(true)
    projectSessionEvent(db, 'session', title(98, 'after retry'), 'owner')
    expect(db.getChat('owner', 'chat').title).toBe('after retry')
  } finally { db.close() }
})

it.each([false, true])('applies a live completion before interrupting startup runs (pending inbox=%s)', async pending => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
    db.createRun({ id: 'run', ownerId: 'owner', chatId: 'chat', sessionId: 'session', query: 'work', selection: {} })
    db.bindRunMessage('session', 'run', 1, 'message')
    db.transitionRun('owner', 'run', 'running')
    const events = Array.from({ length: 96 }, (_, i) => title(i, 'title'))
    if (pending) events[0] = { seq: 0, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0,
      inserted: [{ id: 'message', source: { kind: 'user', rpcId: 'run' }, content: [] }] } }
    const recovery = reconcileNativeSessions(db, { observeSession: async () => ({ events }) }, 'owner')
    await yieldToEventLoop()
    projectSessionEvent(db, 'session', { seq: 96, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, 'owner')
    expect(await recovery).toEqual([])
    expect(db.getRun('owner', 'run').status).toBe('completed')
    expect(db.allEvents('owner', 'run').filter(event => event.event === 'workbench_end').map(event => event.status)).toEqual(['completed'])
    expect(db.pendingRunFences('owner')).toEqual([])
  } finally { db.close() }
})

it('uses the live context for an event also included in the observed snapshot', async () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
    const event = { seq: 1, type: 'plan/mode', data: { active: true } }
    const plan = { active: true, pending: false }
    await reconcileNativeSessions(db, { observeSession: async () => {
      projectSessionEvent(db, 'session', event, 'owner', { plan })
      return { events: [event] }
    } }, 'owner')
    expect(db.getControl('owner', 'chat').plan).toMatchObject(plan)
    expect(db.hasProjectedEvent('session', 1)).toBe(true)
  } finally { db.close() }
})

it('preserves separate unsequenced live events in arrival order', async () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
    const events = Array.from({ length: 96 }, (_, i) => title(i, 'old title'))
    const recovery = reconcileNativeSessions(db, { observeSession: async () => ({ events }) }, 'owner')
    await yieldToEventLoop()
    projectSessionEvent(db, 'session', title(undefined, 'live title'), 'owner')
    projectSessionEvent(db, 'session', goal(undefined, 'live goal'), 'owner')
    await recovery
    expect(db.getChat('owner', 'chat').title).toBe('live title')
    expect(db.getControl('owner', 'chat').goal.objective).toBe('live goal')
  } finally { db.close() }
})
