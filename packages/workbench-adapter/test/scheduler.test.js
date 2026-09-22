import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { TaskScheduler } from '../src/scheduler.js'

const databases = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function setup() {
  const db = new WorkbenchDatabase(':memory:')
  databases.push(db)
  const sessions = { prompt: vi.fn(async () => {}), cancel: vi.fn(), selectModel: vi.fn(async () => {}) }
  let permitted = false
  const platform = { json: vi.fn(async ({ body }) => ({ data: { state: JSON.parse(body).action === 'release' ? 'done' : permitted ? 'running' : 'waiting' } })) }
  const scheduler = new TaskScheduler({ database: db, sessions, platformClient: platform, ownerId: 't:1' })
  const chat = db.createChat({ ownerId: 't:1', sessionId: 's', selection: {} })
  const create = (query) => db.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's', query, selection: {} }).run
  return { db, sessions, scheduler, platform, create, permit: () => { permitted = true } }
}

it('waits for capacity, dispatches one turn and releases before the next', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const first = create('first'), second = create('second')
  db.saveSubmission('t:1', first.id, [{ type: 'text', text: 'first' }])
  db.saveSubmission('t:1', second.id, [{ type: 'text', text: 'second' }])
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  permit()
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(1)
  expect(sessions.prompt.mock.calls[0][0]).toMatchObject({ requestId: first.id, mode: 'queue' })
  db.transitionRun('t:1', first.id, 'completed')
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(sessions.prompt.mock.calls[1][0].requestId).toBe(second.id)
  expect(platform.json.mock.calls.map(([r]) => JSON.parse(r.body).action)).toContain('release')
})

it('preserves undispatched work across recovery and never executes cancelled work', async () => {
  const { db, sessions, scheduler, create, permit } = setup()
  const run = create('waiting')
  db.saveSubmission('t:1', run.id, [])
  db.recoverInterrupted()
  expect(db.getRun('t:1', run.id).status).toBe('queued')
  db.transitionRun('t:1', run.id, 'cancelled')
  permit()
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  expect(db.submissions('t:1')).toEqual([])
})

it('does not run on admission outage and cancels dispatched execution on renewal loss', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('work')
  db.saveSubmission('t:1', run.id, [])
  platform.json.mockRejectedValueOnce(new Error('offline'))
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  permit()
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'running')
  platform.json.mockRejectedValueOnce(new Error('offline'))
  await scheduler.tick()
  expect(sessions.cancel).toHaveBeenCalledWith({ sessionId: 's' })
  expect(db.submission('t:1', run.id).dispatched).toBe(true)
})

it('uses a new durable ticket for an explicit failed-run retry', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('retry')
  db.saveSubmission('t:1', run.id, [{ type: 'text', text: 'retry' }])
  const previous = db.submission('t:1', run.id).ticketId
  permit()
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'failed')
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'queued')
  await scheduler.enqueue(db.getRun('t:1', run.id), [{ type: 'text', text: 'retry' }], true)
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(db.submission('t:1', run.id).ticketId).not.toBe(previous)
  expect(platform.json.mock.calls.map(([request]) => JSON.parse(request.body)).some((request) => request.action === 'release' && request.ticket_id === previous)).toBe(true)
})

it('rechecks cancellation after waiting for a global ticket', async () => {
  const { db, sessions, scheduler, create, platform } = setup()
  const run = create('cancel during acquire')
  db.saveSubmission('t:1', run.id, [])
  let resolve
  platform.json.mockImplementationOnce(() => new Promise((accept) => { resolve = accept }))
  const dispatch = scheduler.tick()
  db.transitionRun('t:1', run.id, 'cancelled')
  resolve({ data: { state: 'running' } })
  await dispatch
  expect(sessions.prompt).not.toHaveBeenCalled()
  await scheduler.tick()
  expect(db.submissions('t:1')).toEqual([])
})

it.each(['revoked', 'offline'])('stops continuing goals when terminal-turn renewal is %s', async (failure) => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('goal')
  db.saveSubmission('t:1', run.id, [])
  permit()
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'completed')
  scheduler.agents = new Map([['s', { status: 'running' }]])
  if (failure === 'offline') platform.json.mockRejectedValueOnce(new Error('offline'))
  else platform.json.mockResolvedValueOnce({ data: { state: 'done' } })
  await scheduler.tick()
  expect(sessions.cancel).toHaveBeenCalledWith({ sessionId: 's' })
  expect(db.submission('t:1', run.id)).toBeDefined()
  expect(db.getRun('t:1', run.id).status).toBe('completed')
})

it('finalizes an idle dispatched task after its ticket is revoked', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('revoked')
  db.saveSubmission('t:1', run.id, [])
  permit()
  await scheduler.tick()
  scheduler.agents = new Map([['s', { status: 'idle' }]])
  platform.json.mockResolvedValueOnce({ data: { state: 'done' } })
  await scheduler.tick()
  expect(sessions.cancel).toHaveBeenCalledWith({ sessionId: 's' })
  expect(db.getRun('t:1', run.id).status).toBe('failed')
  await scheduler.tick()
  expect(db.submissions('t:1')).toEqual([])
})
