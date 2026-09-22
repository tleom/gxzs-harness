import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { WorkbenchDatabase } from '../src/persistence.js'
import { TaskScheduler } from '../src/scheduler.js'
import { WorkbenchService } from '../src/service.js'
import { WorkbenchRuntime } from '../src/runtime.js'
import { createAssistantStreamProjector, projectInboxClaim, projectSessionEvent, reconcileNativeSessions, settleNativeIdle } from '../src/projection.js'

// Exercise the exact published DSH version installed by the production profile.
// CI must install profiles/workbench before running this contract suite.
const nativeRequire = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = async name => import(pathToFileURL(nativeRequire.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { default: LlmRuntime, LlmAdapter, createUserMessage },
  { default: SessionStore }, { default: Projections }, { default: SystemPrompt },
  { default: ToolRuntime }, { default: AgentRegistry }, { default: AgentLoop },
  { default: GoalService }, GoalDriver, { default: Commands }, GoalCommand] = await Promise.all([
  native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'),
  native('dsh-system-prompt'), native('dsh-tools'), native('dsh-agent'), native('dsh-agent-loop'),
  native('dsh-goal'), native('dsh-goal-round-driver'), native('dsh-commands'), native('dsh-command-goal'),
])
const controllerPath = join(dirname(nativeRequire.resolve('@deepseek-ai/dsh-api-session-controller')), 'types', 'commands.js')
const { SessionCommandController } = await import(pathToFileURL(controllerPath).href)
const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

class FakeModel extends LlmAdapter {
  requests = []
  constructor(script) { super(); this.script = script }
  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry instanceof Error) throw entry
    if (entry === 'hang') {
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) return reject(options.signal.reason)
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
      return
    }
    if (entry === undefined) throw new Error('fake model script exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: entry }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: entry } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(script) {
  const ctx = new Context()
  const db = new WorkbenchDatabase(':memory:')
  cleanups.push(() => db.close())
  cleanups.push(() => ctx.fiber.dispose())
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, ToolRuntime, AgentRegistry, GoalService]) await ctx.plugin(plugin)
  await ctx.plugin(GoalDriver)
  await ctx.plugin(Commands)
  await ctx.plugin(GoalCommand)
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new FakeModel(script)
  ctx.llm.registerAdapter(['mock'], model)
  const agent = await ctx.agentLoop.create('native-session', { provider: 'mock', model: 'mock' }, { cwd: '/workspace/conversations/native-chat' })
  const owner = { ownerId: 't:1' }
  const chat = db.createChat({ id: 'native-chat', ownerId: owner.ownerId, sessionId: agent.id, selection: {} })
  const controllerCtx = Object.create(ctx)
  controllerCtx.attachments = { admitPromptContent: async content => content }
  controllerCtx.fileUploads = { bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) }
  const controller = new SessionCommandController(controllerCtx, {
    resolveAgent: async () => ({ agent }), selectionFor: () => ({ current: { provider: 'mock', model: 'mock' } }),
  }, '/workspace')
  const sessions = { prompt: (request, signal) => controller.prompt(request, signal), cancel: () => agent.cancel({ kind: 'user' }, { keepInbox: true }) }
  let permitted = true
  const requests = []
  const platform = { json: async request => {
    const body = JSON.parse(request.body)
    requests.push(body)
    if (request.route === 'mcp/cancel') return { data: { fenced: true } }
    return { data: { state: body.action === 'release' ? 'done' : permitted ? 'running' : 'waiting' } }
  } }
  const scheduler = new TaskScheduler({ database: db, sessions, platformClient: platform, ownerId: owner.ownerId, agents: ctx.agents })
  cleanups.push(() => scheduler.close())
  const runtime = new WorkbenchRuntime(ctx, db, owner.ownerId)
  runtime.scheduler = scheduler
  scheduler.executionRun = id => runtime.executionRun(id)
  ctx.on('agent/inbox/claimed', payload => projectInboxClaim(db, payload, owner.ownerId))
  ctx.on('agent/assistant-stream', createAssistantStreamProjector(db, owner.ownerId))
  ctx.on('session/event', (session, event) => projectSessionEvent(db, session.id, event, owner.ownerId,
    { goal: ctx.goals.get(agent), nativeIdle: agent.status === 'idle' }))
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (status === 'idle') settleNativeIdle(db, current.id, ctx.goals.get(current))
  })
  ctx.on('agent/pre-step', (payload, next) => scheduler.admitNativeStep(payload, next), { prepend: true })
  const create = query => db.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: agent.id, query, selection: {},
    mcpTools: [{ id: 'personal:server:tool', version: 'v1' }] }).run
  return { ctx, db, agent, owner, chat, model, scheduler, runtime, sessions, requests, create,
    permit: value => { permitted = value } }
}

it('runs a fresh request after a failed native turn while duplicate delivery remains exactly once', async () => {
  const test = await fixture([new Error('provider failure'), 'second answer'])
  const first = test.create('first')
  await test.scheduler.enqueue(first, [{ type: 'text', text: 'first' }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.db.getRun('t:1', first.id).status).toBe('failed')
  await test.sessions.prompt({ requestId: first.id, sessionId: test.agent.id, content: [{ type: 'text', text: 'first' }], mode: 'queue' })
  expect(test.model.requests).toHaveLength(1)
  await test.scheduler.tick()
  const second = test.create('second')
  await test.scheduler.enqueue(second, [{ type: 'text', text: 'second' }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.db.getRun('t:1', second.id).status).toBe('completed')
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.source.rpcId)).toEqual([first.id, second.id])
})

it('gates the real Goal driver, projects two rounds to one run and preserves frozen MCP authority', async () => {
  const test = await fixture(['round one', 'round two'])
  const run = test.create('/goal finish twice')
  test.db.setGoalRun(test.agent.id, run.id)
  test.permit(false)
  const authorization = []
  test.ctx.on('agent/pre-step', async (_payload, next) => {
    authorization.push(test.runtime.authorizeMcp(test.agent.id, 'personal:server:tool', 'v1'))
    return next()
  })
  test.ctx.goals.create(test.agent, { objective: 'finish twice', maxGoalRounds: 2 })
  await vi.waitFor(() => expect(test.requests.some(request => request.action === 'acquire')).toBe(true))
  expect(test.model.requests).toHaveLength(0)
  expect(test.db.getRun('t:1', run.id).status).toBe('queued')
  test.permit(true)
  await vi.waitFor(() => expect(test.ctx.goals.get(test.agent).phase).toBe('blocked'))
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(test.db.runForTurn(test.agent.id, 1)?.id).toBe(run.id)
  expect(test.db.runForTurn(test.agent.id, 2)?.id).toBe(run.id)
  expect(authorization.every(value => value?.runId === run.id)).toBe(true)
  const events = test.db.allEvents('t:1', run.id)
  expect(events.filter(event => event.event === 'workbench_activity').map(event => event.data.text)).toEqual(['round one', 'round two'])
  expect(events.filter(event => event.event === 'workbench_end')).toHaveLength(1)
  expect(test.db.db.prepare('SELECT * FROM pending_turns').all()).toHaveLength(0)
})

it('reconciles native pending inbox after restart without hiding or replaying its message', async () => {
  const test = await fixture(['hang', 'next answer', 'wake answer'])
  const first = test.create('first'), second = test.create('second')
  await test.scheduler.enqueue(first, [{ type: 'text', text: 'first' }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  await test.scheduler.enqueue(second, [{ type: 'text', text: 'second' }])
  await test.scheduler.tick()
  const messageId = test.agent.inbox.nextTurn[0].id
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
  const beforeEvents = test.db.allEvents('t:1', first.id).length
  await reconcileNativeSessions(test.db, { observeSession: async () => ({ events: test.agent.session.snapshotEvents(), [Symbol.dispose]() {} }) }, 't:1')
  expect(test.db.getRun('t:1', second.id)).toMatchObject({ status: 'queued', messageId })
  expect(test.db.allEvents('t:1', first.id)).toHaveLength(beforeEvents)
  await test.scheduler.tick()
  // Explicit later wakeup uses the native inbox; the original message is consumed once.
  const third = test.create('wake')
  test.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'wake' }], source: { kind: 'user', rpcId: third.id } }))
  await test.agent.whenIdle()
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === messageId)).toHaveLength(1)
  expect(test.db.getRun('t:1', second.id).status).toBe('completed')
  expect(test.db.getRun('t:1', third.id).status).toBe('completed')
})

it('starts and pauses a real native Goal command without an unadmitted model call', async () => {
  const test = await fixture(['hang'])
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, goals: test.ctx.goals, commands: test.ctx.commands, workspace: '/workspace',
    platformClient: { json: async () => ({ data: { fenced: true } }) },
    fileManager: { operate: async () => ({}) } })
  test.permit(false)
  const result = await service.issueCommand(test.owner, test.chat.id, { command: '/goal check command admission', request_key: 'goal-command' })
  expect(result.run).toMatchObject({ chat_id: test.chat.id })
  await vi.waitFor(() => expect(test.requests.some(request => request.action === 'acquire')).toBe(true))
  expect(test.model.requests).toHaveLength(0)
  test.permit(true)
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  await service.stopRun(test.owner, result.run.id)
  await test.agent.whenIdle()
  expect(test.ctx.goals.get(test.agent)).toMatchObject({ phase: 'paused' })
  expect(test.db.getRun('t:1', result.run.id).status).toBe('cancelled')
  expect(test.model.requests).toHaveLength(1)
})

it('inherits admission and frozen tools only through native live subagent ownership', async () => {
  const test = await fixture(['hang', 'child answer'])
  const run = test.create('parent')
  await test.scheduler.enqueue(run, [{ type: 'text', text: 'parent' }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const childHandle = await test.ctx.agents.create({ sessionId: 'child-session', parentAgent: test.agent,
    meta: { parentSession: test.agent.id, origin: 'subagent' }, agentOptions: { provider: 'mock', model: 'mock' } })
  const child = childHandle.agent
  expect(test.runtime.authorizeMcp(child.id, 'personal:server:tool', 'v1')).toMatchObject({ runId: run.id })
  child.followup(createUserMessage({ content: [{ type: 'text', text: 'child' }], source: { kind: 'user' } }))
  await child.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  const unrelated = await test.ctx.agents.create({ sessionId: 'unrelated-session',
    meta: { parentSession: test.agent.id }, agentOptions: { provider: 'mock', model: 'mock' } })
  expect(test.runtime.authorizeMcp(unrelated.agent.id, 'personal:server:tool', 'v1')).toBeUndefined()
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
  expect(test.runtime.authorizeMcp(child.id, 'personal:server:tool', 'v1')).toBeUndefined()
})

it('rejects stale steering after asynchronous preparation and leaves the pending submission intact', async () => {
  const test = await fixture(['hang'])
  const first = test.create('first'), second = test.create('steer')
  await test.scheduler.enqueue(first, [{ type: 'text', text: 'first' }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  test.db.saveSubmission('t:1', second.id, [{ type: 'text', text: 'steer' }])
  let prepared
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, attachments: { admitPromptContent: () => new Promise(resolve => { prepared = resolve }) } })
  const steering = service.steer(test.owner, second.id, first.id)
  await vi.waitFor(() => expect(prepared).toBeTypeOf('function'))
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
  prepared([{ type: 'text', text: 'steer' }])
  await expect(steering).rejects.toMatchObject({ status: 409, code: 'STALE_RUN' })
  expect(test.db.getRun('t:1', second.id).status).toBe('queued')
  expect(test.db.submission('t:1', second.id).dispatched).toBe(false)
  expect(test.model.requests).toHaveLength(1)
})
