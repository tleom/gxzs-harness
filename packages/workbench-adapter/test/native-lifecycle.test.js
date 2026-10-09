import { afterEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { WorkbenchDatabase } from '../src/persistence.js'
import { TaskScheduler } from '../src/scheduler.js'
import { WorkbenchService } from '../src/service.js'
import { WorkbenchRuntime } from '../src/runtime.js'
import { createAssistantStreamProjector, projectInboxClaim, projectSessionEvent, reconcileNativeSessions, settleNativeIdle } from '../src/projection.js'
import { apply as applyMcpTools } from '../../workbench-mcp-tools/src/index.js'
import { registerRunResourceContext } from '../src/resource-mentions.js'
import { prepareNativeFiles } from '../src/attachments.js'

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
    const entry = await this.script.shift()
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
  const sessions = { updateQueue: request => controller.updateQueue(request), prompt: (request, signal) => controller.prompt(request, signal), cancel: () => agent.cancel({ kind: 'user' }, { keepInbox: true }) }
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
  registerRunResourceContext(ctx)
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
  return { ctx, db, agent, owner, chat, model, scheduler, runtime, sessions, controllerCtx, requests, create,
    permit: value => { permitted = value } }
}

it('resolves a canonical conversation mention through native pre-step into model context', async () => {
  const test = await fixture(['reference received'])
  const [{ default: Query }, { default: References }] = await Promise.all([native('dsh-session-query'), native('dsh-session-reference')])
  await test.ctx.plugin(Query)
  await test.ctx.plugin(References)
  const source = test.ctx.sessions.create('reference-source')
  source.append('user/message', createUserMessage({ content: [{ type: 'text', text: '证据原件存放于档案柜七号。' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const candidates = await test.ctx.sessionReferenceResolver.remoteExportCandidates(test.agent, '', new AbortController().signal)
  const candidate = candidates.find(item => item.sessionId === source.id)
  expect(candidate).toBeDefined()
  const run = test.create(`核对 ${candidate.mention}`)
  await test.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(1)
  const messages = JSON.stringify(test.model.requests[0].messages)
  expect(messages).toContain('证据原件存放于档案柜七号')
  expect(messages).not.toContain('dsh-session:')
})

it('sends global and personal MCP schemas and skill display names to the real native model request', async () => {
  const test = await fixture(['catalog received'])
  const [{ default: Skills }, SkillTool] = await Promise.all([native('dsh-skill'), native('dsh-tool-skill')])
  await test.ctx.plugin(Skills)
  await test.ctx.plugin(SkillTool)
  const definitions = [
    { name: 'global-evidence', description: 'Global evidence', metadata: { 'display-name': '全局证据整理' } },
    { name: 'personal-evidence', description: 'Personal evidence', metadata: { 'display-name': '个人证据整理' } },
  ].map(item => ({ ...item, invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'fixture', rank: 100 }))
  cleanups.push(test.ctx.skills.registerProvider(() => ({ name: 'fixture', list: async () => definitions,
    get: async item => ({ ...item, content: 'Only loaded on invocation' }) })))
  const tools = ['global', 'personal'].map(scope => ({ id: `${scope}:mcp:fixture:${scope}_lookup`,
    runtime_name: `${scope}_fixture_lookup`, version: 'v1', manifest_version: 'm1', scope,
    server_id: `${scope}_fixture`, provider_call_name: `${scope}_fixture`, provider_name: `${scope}展示名`,
    tool_name: `${scope}_lookup`, description: `${scope} Lookup`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }))
  test.ctx.provide('workbenchPlatformClient', { json: async () => ({ tools }) })
  await applyMcpTools(test.ctx)
  const run = test.db.createRun({ ownerId: test.owner.ownerId, chatId: test.chat.id, sessionId: test.agent.id,
    query: '使用全局证据整理和个人证据整理', selection: {}, mcpTools: tools }).run
  await test.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(1)
  const request = test.model.requests[0]
  for (const tool of tools) expect(request.tools.find(item => item.name === tool.tool_name)?.parameters).toEqual(tool.inputSchema)
  const modelText = JSON.stringify(request)
  for (const label of ['global-evidence', '全局证据整理', 'personal-evidence', '个人证据整理']) expect(modelText).toContain(label)
  expect(modelText).not.toContain('Only loaded on invocation')
})

it('delivers a durable queued file through native upload and prompt admission', async () => {
  const test = await fixture(['File received'])
  const root = await mkdtemp(join(process.cwd(), '.attachment-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const { LocalAttachmentStore } = await native('dsh-attachment-local')
  await test.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  test.ctx.provide('connection', { fetch: { register: () => () => {} } })
  const { FileUploads } = await native('dsh-client-file-upload')
  await test.ctx.plugin(FileUploads)
  test.controllerCtx.attachments = test.ctx.attachments
  test.controllerCtx.fileUploads = test.ctx.fileUploads
  test.scheduler.prepareContent = (sessionId, content) => prepareNativeFiles(test.ctx.fileUploads, sessionId, content)
  const run = test.create('Read the evidence')
  const content = [{ type: 'text', text: run.query }, { type: 'file', name: 'evidence.txt', data: Buffer.from('durable evidence').toString('base64') }]
  // Rehydrate the actual queue row without an in-memory upload receipt.
  test.db.saveSubmission(test.owner.ownerId, run.id, JSON.parse(JSON.stringify(content)))
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  await test.agent.whenIdle()
  const messages = test.agent.session.snapshotEvents().filter(event => event.type === 'user/message')
  const files = messages.flatMap(event => event.data.content ?? []).filter(part => part.type === 'file')
  expect(files).toHaveLength(1)
  expect(await readFile(test.ctx.attachments.fileHostPath(files[0].attachment), 'utf8')).toBe('durable evidence')
  expect(JSON.stringify(test.model.requests[0])).toContain('evidence.txt')
  await test.scheduler.tick()
  expect(test.model.requests).toHaveLength(1)
})

it('passes goal-edit files through the native attachment store and user inbox', async () => {
  const test = await fixture(['hang', 'hang'])
  const root = await mkdtemp(join(process.cwd(), '.attachment-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const { LocalAttachmentStore } = await native('dsh-attachment-local')
  await test.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  test.ctx.provide('connection', { fetch: { register: () => () => {} } })
  const { FileUploads } = await native('dsh-client-file-upload')
  await test.ctx.plugin(FileUploads)
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, commands: test.ctx.commands, goals: test.ctx.goals, fileUploads: test.ctx.fileUploads, workspace: '/workspace', nativeFileAttachments: true,
    skills: { list: async () => [] }, platformClient: { json: async () => ({ tools: [] }) },
    fileManager: { operate: async () => ({ kind: 'file', version: 'v1', data: Buffer.from('updated evidence').toString('base64') }) } })
  await service.issueCommand(test.owner, test.chat.id, { command: '/goal Review evidence', request_key: 'file-goal' })
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const body = { command: '/goal edit Review the new evidence', request_key: 'edit-files', files: [{ path: 'evidence.txt', version: 'v1' }] }
  await service.issueCommand(test.owner, test.chat.id, body)
  await service.issueCommand(test.owner, test.chat.id, body)
  const messages = [...test.agent.inbox.nextTurn, ...test.agent.inbox.nextStep]
  const files = messages.flatMap(message => message.content ?? []).filter(block => block.type === 'file')
  expect(files).toHaveLength(1)
  expect(await readFile(test.ctx.attachments.fileHostPath(files[0].attachment), 'utf8')).toBe('updated evidence')
  expect(test.ctx.goals.get(test.agent).objective).toBe('Review the new evidence')
  test.ctx.goals.pause(test.agent, test.ctx.goals.get(test.agent))
  test.agent.cancel({ kind: 'user' })
  await test.agent.whenIdle()
})

it('starts an attachment-only plan through the native driver exactly once', async () => {
  const test = await fixture(['Evidence plan'])
  const { default: PlanMode } = await native('dsh-plan-mode')
  await test.ctx.plugin(PlanMode, { section: 'Prepare a plan.' })
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, commands: test.ctx.commands, workspace: '/workspace',
    skills: { list: async () => [] }, platformClient: { json: async () => ({ tools: [] }) },
    fileManager: { operate: async () => ({ kind: 'file', version: 'v1', data: Buffer.from('evidence').toString('base64') }) } })
  const body = { command: '/plan', request_key: 'native-file-plan', files: [{ path: 'evidence.txt', version: 'v1' }] }
  await service.issueCommand(test.owner, test.chat.id, body)
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  await test.agent.whenIdle()
  await service.issueCommand(test.owner, test.chat.id, body)
  expect(test.model.requests).toHaveLength(1)
  expect(JSON.stringify(test.model.requests[0])).toContain('/workspace/evidence.txt')
  expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(1)
  expect(test.ctx.sessionProjections.snapshot(test.agent.session, ['plan']).values.plan.active).toBe(true)
})

it('uses the native plan command and review tool without submitting the task twice', async () => {
  const test = await fixture(['Plan prepared', 'Plan executed'])
  const { default: PlanMode } = await native('dsh-plan-mode')
  await test.ctx.plugin(PlanMode, { section: 'Investigate and prepare a plan for review before executing.' })
  const reviews = []
  test.ctx.provide('userQuestions', { ask: async request => {
    reviews.push(request)
    return { answers: request.questions.map(question => ({ id: question.id, selected: [question.intent.approve] })) }
  } })
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, commands: test.ctx.commands, workspace: '/workspace',
    skills: { list: async () => [] }, platformClient: { json: async () => ({ tools: [] }) },
    fileManager: { operate: async () => ({}) } })
  await service.issueCommand(test.owner, test.chat.id, { command: '/plan Review the case evidence', request_key: 'native-plan' })
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(1)
  expect(test.ctx.sessionProjections.snapshot(test.agent.session, ['plan']).values.plan.active).toBe(true)
  const result = await test.ctx.tools.execute({ callId: 'plan-review', name: 'exit_plan_mode',
    arguments: { plan: '# Case evidence\nRead the supplied documents and compare the dates.' },
    agent: test.agent, signal: new AbortController().signal })
  expect(result.isError).not.toBe(true)
  expect(reviews).toHaveLength(1)
  expect(reviews[0].questions[0].intent.kind).toBe('plan-review')
  expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(1)
  // The native exit tool commits its intent at the next accepted pre-step.
  const next = test.create('Execute the approved plan')
  await test.scheduler.enqueue(next, [{ type: 'text', text: next.query }])
  await vi.waitFor(async () => {
    await test.scheduler.tick()
    expect(test.model.requests).toHaveLength(2)
  })
  await test.agent.whenIdle()
  expect(test.ctx.sessionProjections.snapshot(test.agent.session, ['plan']).values.plan.active).toBe(false)
})

it('advertises only selected MCP tools on the actual first native request and binds selected raw-name calls', async () => {
  const test = await fixture(['without weather', 'hang'])
  const weather = { id: 'personal:mcp:gaode:maps_weather', runtime_name: 'personal_gaode_weather', version: 'v1', manifest_version: 'm1',
    scope: 'personal', server_id: 'gaode', tool_name: 'maps_weather', description: 'Weather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }
  const calls = []
  test.ctx.provide('workbenchPlatformClient', { json: async request => {
    if (request.route === 'mcp/catalog') return { tools: [weather] }
    calls.push(JSON.parse(request.body))
    return { result: { content: [{ type: 'text', text: 'fixture weather' }] } }
  } })
  await applyMcpTools(test.ctx)
  const create = tools => test.db.createRun({ ownerId: test.owner.ownerId, chatId: test.chat.id, sessionId: test.agent.id,
    query: 'fixture', selection: { tools: tools.map(tool => tool.id) }, mcpTools: tools }).run
  const first = create([])
  await test.scheduler.enqueue(first, [{ type: 'text', text: 'fixture' }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(1)
  expect(test.model.requests[0].tools?.map(tool => tool.name) ?? []).not.toContain('maps_weather')
  const denied = await test.ctx.tools.execute({ callId: 'not-selected', name: 'maps_weather', arguments: { city: 'fixture' }, agent: test.agent, signal: new AbortController().signal })
  expect(denied.isError).toBe(true)
  expect(calls).toHaveLength(0)
  await test.scheduler.tick()
  const second = create([weather])
  await test.scheduler.enqueue(second, [{ type: 'text', text: 'fixture' }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(2))
  expect(test.model.requests[1].tools.map(tool => tool.name)).toContain('maps_weather')
  expect(test.model.requests[1].tools.some(tool => tool.name.startsWith('mcp__'))).toBe(false)
  const result = await test.ctx.tools.execute({ callId: 'selected-weather', name: 'maps_weather', arguments: { city: 'fixture' }, agent: test.agent, signal: new AbortController().signal })
  expect(result.isError).not.toBe(true)
  expect(calls).toEqual([expect.objectContaining({ run_id: second.id, resource_id: weather.id, server_id: 'gaode', tool_name: 'maps_weather', version: 'v1', manifest_version: 'm1' })])
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
})

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
    skills: { list: async () => [{ name: 'evidence', displayName: '证据整理', description: '整理证据' }] },
    platformClient: { json: async () => ({ data: { fenced: true } }) },
    fileManager: { operate: async () => ({}) } })
  test.permit(false)
  const result = await service.issueCommand(test.owner, test.chat.id, { command: '/goal check command admission', request_key: 'goal-command', resource_mentions: { skills: ['evidence'] } })
  expect(result.run).toMatchObject({ chat_id: test.chat.id })
  await vi.waitFor(() => expect(test.requests.some(request => request.action === 'acquire')).toBe(true))
  expect(test.model.requests).toHaveLength(0)
  test.permit(true)
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  expect(JSON.stringify(test.model.requests[0])).toContain('evidence')
  expect(result.run).toMatchObject({ command: 'goal', query: 'check command admission' })
  expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(1)
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

it.each(['button', 'command'])('preserves native goal state and resource context when resuming via %s', async (entry) => {
  const test = await fixture(['hang', 'hang'])
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, goals: test.ctx.goals, commands: test.ctx.commands, workspace: '/workspace',
    skills: { list: async () => [{ name: 'evidence', description: 'Evidence skill' }] },
    platformClient: { json: async () => ({ tools: [] }) }, fileManager: { operate: async () => ({}) } })
  await service.issueCommand(test.owner, test.chat.id, { command: '/goal Review evidence', request_key: 'native-ref', resource_mentions: { skills: ['evidence'] } })
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const first = test.ctx.goals.get(test.agent)
  await service.mutateGoal(test.owner, test.chat.id, 'pause', { ref: { id: first.id, revision: first.revision } })
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
  await expect(service.mutateGoal(test.owner, test.chat.id, 'clear', { ref: { id: first.id, revision: first.revision } })).rejects.toMatchObject({ status: 409 })
  const paused = test.ctx.goals.get(test.agent)
  await service.mutateGoal(test.owner, test.chat.id, 'edit', { ref: paused, request: { objective: 'Review all evidence' } })
  const edited = test.ctx.goals.get(test.agent)
  if (entry === 'button') await service.mutateGoal(test.owner, test.chat.id, 'resume', { ref: edited })
  else await service.issueCommand(test.owner, test.chat.id, { command: '/goal resume', request_key: 'native-resume' })
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(2))
  expect(JSON.stringify(test.model.requests[1])).toContain('evidence')
  expect((await service.getControl(test.owner, test.chat.id)).goal).toMatchObject({ phase: 'active', activation: 'armed', objective: 'Review all evidence' })
  await service.mutateGoal(test.owner, test.chat.id, 'clear', { ref: test.ctx.goals.get(test.agent) })
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
  expect((await service.getControl(test.owner, test.chat.id)).goal).toBeNull()
})

it('delegates compact once to the native command without prompting the model or creating a business run', async () => {
  const test = await fixture([])
  const compactNow = vi.fn(async () => null)
  test.ctx.provide('compaction', { compactNow })
  await test.ctx.plugin(await native('dsh-command-compact'))
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    commands: test.ctx.commands, workspace: '/workspace', fileManager: { operate: async () => ({}) },
    sessionQuery: { observeSession: async () => ({ events: test.agent.session.snapshotEvents(), [Symbol.dispose]() {} }) } })
  const body = { command: '/compact', request_key: 'compact-once' }
  const result = await service.issueCommand(test.owner, test.chat.id, body)
  expect(result.message).toBe('No compactable history yet.')
  expect(result.state.commands).toEqual([expect.objectContaining({ name: 'compact', outcome: expect.objectContaining({ kind: 'success', text: result.message }) })])
  await service.issueCommand(test.owner, test.chat.id, body)
  expect(compactNow).toHaveBeenCalledOnce()
  expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(0)
  expect(test.model.requests).toHaveLength(0)
  await expect(service.issueCommand(test.owner, test.chat.id, { ...body, request_key: 'compact-file', files: [{ path: 'x' }] })).rejects.toMatchObject({ status: 400 })
})

it('lets a native plan command steer the running turn and projects its message once', async () => {
  let release
  const test = await fixture([new Promise(resolve => { release = resolve }), 'plan response'])
  const { default: PlanMode } = await native('dsh-plan-mode')
  await test.ctx.plugin(PlanMode, { section: 'Prepare a plan.' })
  const first = test.create('Original task')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, commands: test.ctx.commands, workspace: '/workspace', skills: { list: async () => [] },
    platformClient: { json: async () => ({ tools: [] }) }, fileManager: { operate: async () => ({}) } })
  const result = await service.issueCommand(test.owner, test.chat.id, { command: '/plan Inspect first', request_key: 'steer-plan' })
  expect(test.agent.inbox.nextStep).toHaveLength(1)
  release('First response')
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(service.getRun(test.owner, result.run.id)).toMatchObject({ status: 'steered', steer_target_run_id: first.id })
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.content?.some(part => part.text === 'Inspect first'))).toHaveLength(1)
})

it('rejects stale steering after asynchronous preparation and leaves the pending submission intact', async () => {
  const test = await fixture(['hang'])
  const first = test.create('first'), second = test.create('steer')
  await test.scheduler.enqueue(first, [{ type: 'text', text: 'first' }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  test.db.saveSubmission('t:1', second.id, [{ type: 'text', text: 'steer' }, { type: 'file', name: 'evidence.txt', data: 'dGVzdA==' }])
  let prepared
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, fileUploads: { uploadStream: () => new Promise(resolve => { prepared = resolve }) } })
  const steering = service.steer(test.owner, second.id, first.id)
  await vi.waitFor(() => expect(prepared).toBeTypeOf('function'))
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
  prepared({ receiptId: 'prepared-file' })
  await expect(steering).rejects.toMatchObject({ status: 409, code: 'STALE_RUN' })
  expect(test.db.getRun('t:1', second.id).status).toBe('queued')
  expect(test.db.submission('t:1', second.id).dispatched).toBe(false)
  expect(test.model.requests).toHaveLength(1)
})


it('projects official DSH fallback, provider and manual titles without adapter naming', async () => {
  const test = await fixture(['first answer', 'second answer'])
  const { default: SessionTitle } = await native('dsh-session-title')
  await test.ctx.plugin(SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  const session = test.ctx.sessions.get(test.agent.id)
  const run = test.create('one two three four five six seven')
  await test.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  await vi.waitFor(() => expect(test.ctx.sessionTitle.get(session)?.source.kind).toBe('fallback'))
  expect(test.db.getChat(test.owner.ownerId, test.chat.id).title).toBe(test.ctx.sessionTitle.get(session).title)
  expect(test.db.getChat(test.owner.ownerId, test.chat.id).title).not.toBe(run.query)
  test.ctx.sessionTitle.register({ id: 'test-title-provider', automatic: 'first-prompt',
    generate: async ({ messages }) => ({ title: 'DSH generated title', messageSeqs: messages.map(message => message.seq) }) })
  await test.ctx.sessionTitle.refresh(session)
  expect(test.db.getChat(test.owner.ownerId, test.chat.id).title).toBe('DSH generated title')
  test.ctx.sessionTitle.rename(session, '  Human   title  ')
  const next = test.create('next question')
  await test.scheduler.enqueue(next, [{ type: 'text', text: next.query }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.db.getChat(test.owner.ownerId, test.chat.id).title).toBe('Human title')
  expect(test.ctx.sessionTitle.get(session).source.kind).toBe('user')
})


it.each(['local', 'native'])('direct-sends a %s queued file through DSH once', async placement => {
  let finishFirst
  const firstReply = new Promise(resolve => { finishFirst = resolve })
  const test = await fixture([firstReply, 'File received'])
  const root = await mkdtemp(join(process.cwd(), '.attachment-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const { LocalAttachmentStore } = await native('dsh-attachment-local')
  await test.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  test.ctx.provide('connection', { fetch: { register: () => () => {} } })
  const { FileUploads } = await native('dsh-client-file-upload')
  await test.ctx.plugin(FileUploads)
  test.controllerCtx.attachments = test.ctx.attachments
  test.controllerCtx.fileUploads = test.ctx.fileUploads
  test.scheduler.prepareContent = (sessionId, content) => prepareNativeFiles(test.ctx.fileUploads, sessionId, content)
  const first = test.create('Start reviewing')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const run = test.create('Also read the evidence')
  const content = [{ type: 'text', text: run.query }, { type: 'file', name: 'evidence.txt', data: Buffer.from('steered evidence').toString('base64') }]
  test.db.saveSubmission(test.owner.ownerId, run.id, content)
  if (placement === 'native') await test.scheduler.tick()
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, fileUploads: test.ctx.fileUploads, workspace: '/workspace' })
  await service.steer(test.owner, run.id, first.id)
  await service.steer(test.owner, run.id, first.id)
  const files = test.agent.inbox.nextStep.flatMap(message => message.content).filter(part => part.type === 'file')
  expect(files).toHaveLength(1)
  expect(await readFile(test.ctx.attachments.fileHostPath(files[0].attachment), 'utf8')).toBe('steered evidence')
  finishFirst('Initial review')
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(JSON.stringify(test.model.requests[1])).toContain('evidence.txt')
  await test.scheduler.tick()
  expect(test.model.requests).toHaveLength(2)
  expect(test.db.getRun(test.owner.ownerId, run.id).status).toBe('steered')
})
