import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { TaskScheduler } from '../src/scheduler.js'

const databases = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function setup() {
  const db = new WorkbenchDatabase(':memory:')
  databases.push(db)
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
  const sessions = { prompt: vi.fn(async () => { agent.status = 'running' }), cancel: vi.fn(), selectModel: vi.fn(async () => {}) }
  let permitted = false
  const platform = { json: vi.fn(async ({ body, route }) => route === 'mcp/cancel' ? ({ data: { fenced: true } }) : ({ data: { state: JSON.parse(body).action === 'release' ? 'done' : permitted ? 'running' : 'waiting' } })) }
  const scheduler = new TaskScheduler({ database: db, sessions, platformClient: platform, ownerId: 't:1', agents: new Map([['s', agent]]) })
  const chat = db.createChat({ ownerId: 't:1', sessionId: 's', selection: {} })
  const create = (query) => db.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's', query, selection: {} }).run
  return { db, sessions, scheduler, platform, create, agent, permit: () => { permitted = true } }
}

it('waits for capacity then hands both prompts to one admitted native Session', async () => {
  const { db, sessions, scheduler, create, permit, platform, agent } = setup()
  const first = create('first'), second = create('second')
  db.saveSubmission('t:1', first.id, [{ type: 'text', text: 'first' }])
  db.saveSubmission('t:1', second.id, [{ type: 'text', text: 'second' }])
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  permit()
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(sessions.prompt.mock.calls[0][0]).toMatchObject({ requestId: first.id, mode: 'queue' })
  db.transitionRun('t:1', first.id, 'completed')
  agent.status = 'idle'
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
  const { db, sessions, scheduler, create, permit, platform, agent } = setup()
  const run = create('retry')
  db.saveSubmission('t:1', run.id, [{ type: 'text', text: 'retry' }])
  const previous = db.submission('t:1', run.id).ticketId
  permit()
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'failed')
  agent.status = 'idle'
  await scheduler.tick()
  await expect(scheduler.enqueue(db.getRun('t:1', run.id), [], true)).rejects.toThrow('new run identity')
  const retried = create('retry')
  await scheduler.enqueue(retried, [{ type: 'text', text: 'retry' }])
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(db.submission('t:1', retried.id).ticketId).not.toBe(previous)
  expect(sessions.prompt.mock.calls[1][0].requestId).not.toBe(run.id)
  expect(platform.json.mock.calls.map(([request]) => JSON.parse(request.body)).some((request) => request.action === 'release' && request.ticket_id === previous)).toBe(true)
})

it.each([400, 401, 403, 404, 405, 501])('ends waiting on a permanent admission error (%s)', async (status) => {
  const { db, sessions, scheduler, create, platform } = setup()
  const run = create('work')
  db.saveSubmission('t:1', run.id, [])
  platform.json.mockRejectedValue(Object.assign(new Error('invalid scheduling configuration'), { status }))
  await scheduler.tick()
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  expect(db.getRun('t:1', run.id)).toMatchObject({ status: 'failed' })
  expect(db.allEvents('t:1', run.id).filter(event => event.event === 'workbench_end')).toEqual([
    expect.objectContaining({ status: 'failed', error: expect.stringContaining('任务调度配置异常') }),
  ])
})

it('rechecks cancellation after waiting for a global ticket', async () => {
  const { db, sessions, scheduler, create, platform } = setup()
  const run = create('cancel during acquire')
  db.saveSubmission('t:1', run.id, [])
  let resolve
  platform.json.mockImplementationOnce(() => new Promise((accept) => { resolve = accept }))
  const dispatch = scheduler.tick()
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
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

it('releases admission when the native Session is idle without rewriting its turn cache', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('revoked')
  db.saveSubmission('t:1', run.id, [])
  permit()
  await scheduler.tick()
  scheduler.agents = new Map([['s', { status: 'idle' }]])
  platform.json.mockResolvedValueOnce({ data: { state: 'done' } })
  await scheduler.tick()
  expect(sessions.cancel).not.toHaveBeenCalled()
  expect(db.getRun('t:1', run.id).status).toBe('queued')
  await scheduler.tick()
  expect(db.submissions('t:1')).toEqual([])
})

it('hands follow-ups to the admitted native inbox without another lease', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const agent = { status: 'running', inbox: { nextTurn: [], nextStep: [] } }
  scheduler.agents = { get: () => agent }
  const first = create('first')
  db.saveSubmission('t:1', first.id, [])
  permit()
  await scheduler.tick()
  for (let n = 0; n < 5; n++) {
    const run = create(`next-${n}`)
    db.saveSubmission('t:1', run.id, [{ type: 'text', text: run.query }])
  }
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(6)
  expect(db.submissions('t:1').map((item) => item.runId)).toEqual([first.id])
  expect(platform.json.mock.calls.filter(([request]) => JSON.parse(request.body).action === 'acquire')).toHaveLength(1)
  db.transitionRun('t:1', first.id, 'completed')
  agent.inbox.nextTurn.push({ id: 'native-message' })
  await scheduler.tick()
  expect(db.submission('t:1', first.id)).toBeDefined()
})

it('rotates only admission tickets across generations and retains the native request identity', async () => {
  const { db, scheduler, create, permit, sessions } = setup()
  const run = create('generation')
  db.saveSubmission('t:1', run.id, [{ type: 'text', text: 'generation' }])
  scheduler.generation = '1'
  await scheduler.request(run, 'acquire')
  const first = db.submission('t:1', run.id).ticketId
  await scheduler.request(run, 'acquire')
  expect(db.submission('t:1', run.id).ticketId).toBe(first)
  scheduler.generation = '2'
  permit()
  await scheduler.tick()
  expect(db.submission('t:1', run.id).ticketId).not.toBe(first)
  expect(sessions.prompt.mock.calls[0][0].requestId).toBe(run.id)
})

it('replaces a legacy ticket only after the manager confirms the old generation is fenced', async () => {
  const { db, scheduler, create, platform } = setup()
  const run = create('legacy')
  db.saveSubmission('t:1', run.id, [])
  const first = db.submission('t:1', run.id).ticketId
  platform.json.mockResolvedValueOnce({ data: { state: 'fenced', code: 'ADMISSION_TICKET_FENCED' } })
    .mockResolvedValueOnce({ data: { state: 'running' } })
  await expect(scheduler.request(run, 'acquire')).resolves.toMatchObject({ state: 'running' })
  expect(db.submission('t:1', run.id).ticketId).not.toBe(first)
})

it('fences remote MCP execution when a running lease is revoked', async () => {
  const { db, scheduler, create, permit, platform, sessions } = setup()
  const run = create('revocation')
  permit()
  await scheduler.enqueue(run, [{ type: 'text', text: 'revocation' }])
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'running')
  platform.json.mockResolvedValueOnce({ data: { state: 'done' } })
  await scheduler.tick()
  expect(sessions.cancel).toHaveBeenCalledWith({ sessionId: 's' })
  expect(platform.json.mock.calls.some(([request]) => request.route === 'mcp/cancel' && JSON.parse(request.body).run_id === run.id)).toBe(true)
  expect(scheduler.hasAdmission('s')).toBe(false)
})

it('retains a recovered execution fence and its ticket while the remote cleanup is unavailable', async () => {
  const { db, scheduler, create, platform } = setup()
  const run = create('interrupted')
  db.saveSubmission('t:1', run.id, [])
  db.dispatchSubmission('t:1', run.id)
  db.transitionRun('t:1', run.id, 'running')
  db.recoverInterrupted()
  scheduler.agents = new Map()
  platform.json.mockRejectedValue(new Error('offline'))
  await scheduler.tick()
  expect(db.pendingRunFences('t:1').map(value => value.id)).toContain(run.id)
  expect(db.submission('t:1', run.id)).toBeDefined()
  expect(platform.json.mock.calls.every(([request]) => request.route === 'mcp/cancel')).toBe(true)
  platform.json.mockImplementation(async request => request.route === 'mcp/cancel'
    ? ({ data: { fenced: true } }) : ({ data: { state: 'done' } }))
  await scheduler.tick()
  expect(db.pendingRunFences('t:1')).toEqual([])
  expect(db.submission('t:1', run.id)).toBeUndefined()
})
