import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchRuntime } from '../src/runtime.js'
import { TaskScheduler } from '../src/scheduler.js'

const cleanups = []
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })
function setup() {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const database = new WorkbenchDatabase(':memory:')
  const chat = database.createChat({ ownerId: 't:1', sessionId: 's', selection: {} })
  const run = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's', query: 'work', selection: {}, mcpTools: [{ id: 'search', version: 'v1' }] }).run
  database.bindRunMessage('s', run.id, 1, 'first')
  database.transitionRun('t:1', run.id, 'running')
  database.saveSubmission('t:1', run.id, [])
  database.dispatchSubmission('t:1', run.id)
  let turn = 1
  const agent = { id: 's', status: 'running', ctx: { sessionProjections: { stateOf: () => ({ lastTurn: turn }) } } }
  const agents = new Map([['s', agent]])
  const sessions = { prompt: vi.fn(), cancel: vi.fn() }
  const platform = { json: vi.fn(async () => ({ data: { state: 'running' } })) }
  const scheduler = new TaskScheduler({ database, sessions, agents, platformClient: platform, ownerId: 't:1' })
  const runtime = new WorkbenchRuntime(new Context(), database, 't:1')
  runtime.agents = agents; runtime.scheduler = scheduler
  scheduler.leases.set('s', { runId: run.id, checkedAt: Date.now() - 11000 })
  cleanups.push(() => { scheduler.close(); database.close() })
  return { database, chat, run, sessions, platform, scheduler, runtime, nextTurn: () => { turn++ } }
}

it('recovers expired MCP admission across a transient outage without replaying the native prompt', async () => {
  const { runtime, platform, sessions, database, run } = setup()
  platform.json.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503 }))
  expect(runtime.authorizeMcp('s', 'search', 'v1')).toBeUndefined()
  const before = database.submission('t:1', run.id).ticketId
  await expect(runtime.authorizeMcpCall('s', 'search', 'v1')).resolves.toMatchObject({ runId: run.id })
  expect(platform.json).toHaveBeenCalledTimes(2)
  expect(platform.json.mock.calls.every(([request]) => JSON.parse(request.body).action === 'acquire')).toBe(true)
  expect(database.submission('t:1', run.id).ticketId).toBe(before)
  expect(sessions.prompt).not.toHaveBeenCalled()
})

it.each(['resource', 'version', 'queued-undispatched', 'fenced', 'owner'])('does not acquire capacity for an unauthorized %s call', async reason => {
  const { runtime, platform, database, run } = setup()
  if (reason === 'fenced') {
    database.requireRunFence('t:1', run.id)
    database.confirmRunFence('t:1', run.id)
  }
  if (reason === 'owner') runtime.ownerId = 't:2'
  if (reason === 'queued-undispatched') {
    database.removeSubmission(run.id)
    database.transitionRun('t:1', run.id, 'queued')
  }
  await expect(runtime.authorizeMcpCall('s', reason === 'resource' ? 'other' : 'search', reason === 'version' ? 'v2' : 'v1')).resolves.toBeUndefined()
  expect(platform.json).not.toHaveBeenCalled()
})

it.each(['completed', 'waiting_input'])('renews a live child\'s frozen authority after the parent is %s', async status => {
  const { runtime, platform, database, run, scheduler, sessions } = setup()
  const root = runtime.agents.get('s')
  const child = { id: 'child', status: 'running' }
  runtime.agents.set('child', child)
  runtime.agents.list = () => [root, child]
  runtime.agents.isOwnedBy = (id, parent) => id === child.id && parent === root
  scheduler.hasOwnedWork = (...args) => runtime.hasOwnedWork(...args)
  runtime.bindChild(child)
  database.transitionRun('t:1', run.id, status)
  root.status = 'idle'
  await expect(runtime.authorizeMcpCall('child', 'search', 'v1')).resolves.toMatchObject({ runId: run.id })
  expect(platform.json).toHaveBeenCalledOnce()
  expect(database.getRun('t:1', run.id).status).toBe(status)
  expect(sessions.prompt).not.toHaveBeenCalled()
  child.status = 'idle'
  await expect(runtime.authorizeMcpCall('child', 'search', 'v1')).resolves.toBeUndefined()
})

it.each(['cancelled', 'next-turn', 'abort'])('does not lend an old MCP call authority after %s while admission waits', async state => {
  const { runtime, platform, database, run, chat, nextTurn } = setup()
  let release
  platform.json.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const controller = new AbortController()
  const pending = runtime.authorizeMcpCall('s', 'search', 'v1', controller.signal)
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  if (state === 'cancelled') database.transitionRun('t:1', run.id, 'cancelled')
  if (state === 'next-turn') {
    database.transitionRun('t:1', run.id, 'completed')
    const next = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's', query: 'next', selection: {}, mcpTools: run.mcpTools }).run
    database.bindRunMessage('s', next.id, 2, 'second'); database.transitionRun('t:1', next.id, 'running'); nextTurn()
  }
  if (state === 'abort') controller.abort()
  release({ data: { state: 'running' } })
  const result = await outcome
  expect(result.value).toBeUndefined()
  if (state === 'abort') expect(result.error?.name).toBe('AbortError')
})

it('shares admission between concurrent native MCP calls while the original dispatched run waits', async () => {
  const { runtime, platform, database, run, sessions } = setup()
  database.transitionRun('t:1', run.id, 'queued')
  let release
  platform.json.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const calls = [runtime.authorizeMcpCall('s', 'search', 'v1'), runtime.authorizeMcpCall('s', 'search', 'v1')]
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  release({ data: { state: 'running' } })
  expect(await Promise.all(calls)).toEqual([expect.objectContaining({ runId: run.id }), expect.objectContaining({ runId: run.id })])
  expect(platform.json).toHaveBeenCalledOnce()
  expect(sessions.prompt).not.toHaveBeenCalled()
})
