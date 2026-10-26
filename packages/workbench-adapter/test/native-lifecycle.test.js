import { HumanInputBridge } from '../src/human-input.js'
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
import { dispatchRunPrompt } from '../src/native-prompt.js'
import { registerScheduledClaims } from '../src/scheduled-claims.js'
import { registerDatabasePrompt } from '../src/database-prompt.js'
import WorkbenchFileSystem from '../../workbench-sandbox-runtime/src/fs.js'
import { registerBrowserTool } from '../src/browser-tool.js'
import { registerTerminalTool } from '../src/terminal-tool.js'
import { nativePresentation } from '../src/display-events.js'

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

it('settles two original queued Schedule turns without leaving the second receipt active', async () => {
  const test = await fixture(['first reminder complete', 'second reminder complete'], { scheduledClaims: true })
  test.runtime.mcpCatalogState = { ready: true }
  test.runtime.mcpResources = () => []
  const resourceServer = { id: 'global:mcp:records', version: '1', manifest_version: 'm', capabilities: { resources: {} } }
  test.runtime.mcpPlugins = () => [resourceServer]
  test.scheduler.start()
  const first = createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: 'first scheduled reminder' }] })
  const second = createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: 'second scheduled reminder' }] })
  test.agent.followup(first)
  test.agent.followup(second)
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed', 'completed'])
  expect(test.db.getRun(test.owner.ownerId, first.id)).toMatchObject({ status: 'completed' })
  expect(test.db.getRun(test.owner.ownerId, second.id)).toMatchObject({ status: 'completed' })
  expect(test.db.getRun(test.owner.ownerId, first.id).selection.mcp_servers).toEqual([resourceServer])
  expect(test.db.getRun(test.owner.ownerId, second.id).selection.mcp_servers).toEqual([resourceServer])
})

it('admits an owned child notice as a fresh turn with current permissions after the parent completed', async () => {
  const test = await fixture(['parent done', 'child result incorporated'], { scheduledClaims: true })
  test.runtime.mcpCatalogState = { ready: true }
  test.runtime.mcpResources = () => [{ id: 'current-catalog' }]
  const original = test.create('delegate')
  test.db.updateRunResources(original, {subagent_ids:['owned-child']}, original.mcpTools)
  await test.scheduler.enqueue(original,[{type:'text',text:'delegate'}])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.db.getRun(test.owner.ownerId,original.id).status).toBe('completed')
  await test.scheduler.flushFences()
  expect(test.db.pendingRunFences(test.owner.ownerId)).toEqual([])
  expect(test.requests.some(request => request.run_id === original.id && request.action === 'cancel')).toBe(false)
  const message = createUserMessage({content:[{type:'text',text:'child completed'}],source:{kind:'subagent-settled',senderSessionId:'owned-child',form:'notice',summary:'completed'}})
  test.agent.followup(message)
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('child completed')
  const continued = test.db.listRuns(test.owner.ownerId,test.chat.id).find(run => run.id !== original.id)
  expect(continued).toMatchObject({status:'completed',parentRunId:original.id,selection:{native_source:'subagent-settled',native_notice:true},mcpTools:[{id:'current-catalog'}]})
  expect(continued.selection.is_continuation).toBeUndefined()
  const query = {observeSession:async () => ({events:test.agent.session.snapshotEvents(),[Symbol.dispose]() {}})}
  await reconcileNativeSessions(test.db,query,test.owner.ownerId)
  expect(test.db.listRuns(test.owner.ownerId,test.chat.id)).toHaveLength(2)
  expect(test.model.requests).toHaveLength(2)
})

it.each(['cancelled', 'interrupted'])('admits a late owned child message after a %s task without reopening its receipt', async status => {
  const test = await fixture(['new child reply'], { scheduledClaims: true })
  test.runtime.mcpCatalogState = { ready: true }
  test.runtime.mcpResources = () => [{ id: 'current-catalog' }]
  const original = test.create('old task')
  test.db.updateRunResources(original, { subagent_ids: ['owned-child'], subagent_names: { 'owned-child': '核对员' } }, original.mcpTools)
  test.db.transitionRun(test.owner.ownerId, original.id, status)
  const message = createUserMessage({ content: [{ type: 'text', text: 'late child result' }], source: { kind: 'agent-message', senderSessionId: 'owned-child' } })
  test.agent.followup(message)
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(1)
  const run = test.db.getRun(test.owner.ownerId, message.id)
  expect(run).toMatchObject({ status: 'completed', parentRunId: original.id, mcpTools: [{ id: 'current-catalog' }], selection: { native_source: 'agent-message', subagent_names: { 'owned-child': '核对员' } } })
  expect(test.db.getRun(test.owner.ownerId, original.id).status).toBe(status)
  expect(test.requests.filter(item => item.action === 'acquire')).toHaveLength(1)
})

it('creates a deferred child receipt before DSH commits the child user message', async () => {
  const test = await fixture(['new reply'], { scheduledClaims: true })
  test.runtime.mcpCatalogState = { ready: false }
  test.runtime.mcpResources = () => [{ id: 'current-catalog' }]
  const parent = test.create('delegate')
  test.db.updateRunResources(parent, { subagent_ids: ['owned-child'], subagent_names: { 'owned-child': '核对员' } }, parent.mcpTools)
  test.db.transitionRun(test.owner.ownerId, parent.id, 'completed')
  const message = createUserMessage({ content: [{ type: 'text', text: 'late child result' }], source: { kind: 'agent-message', senderSessionId: 'owned-child' } })
  test.agent.followup(message)
  await vi.waitFor(() => expect(test.agent.inbox.hasPending).toBe(false))
  expect(test.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === message.id)).toBe(false)
  expect(test.db.getRun(test.owner.ownerId, message.id)).toBeUndefined()
  test.runtime.mcpCatalogState = { ready: true }
  await test.agent.whenIdle()
  expect(test.db.allEvents(test.owner.ownerId, message.id)).toContainEqual(expect.objectContaining({
    event: 'workbench_agent_message', message_id: message.id, sender_session_id: 'owned-child', sender_name: '核对员',
  }))
})

it('keeps a busy native turn on its frozen permissions when a child replies during catalog loss', async () => {
  let release
  const test = await fixture([new Promise(resolve => { release = resolve }), 'child incorporated'], { scheduledClaims: true })
  test.runtime.mcpCatalogState = { ready: true }
  const parent = test.create('working')
  await test.scheduler.enqueue(parent, [{ type: 'text', text: parent.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  test.runtime.mcpCatalogState = { ready: false }
  test.runtime.mcpResources = () => []
  const message = createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: { kind: 'agent-message', senderSessionId: 'owned-child' } })
  test.agent.steer(message)
  release('first response')
  try {
    await vi.waitFor(() => expect(test.model.requests).toHaveLength(2))
    await test.agent.whenIdle()
    expect(test.db.getRun(test.owner.ownerId, parent.id).mcpTools).toEqual(parent.mcpTools)
    expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(1)
    expect(test.db.getRun(test.owner.ownerId, parent.id).status).toBe('completed')
  } finally { test.runtime.mcpCatalogState = { ready: true }; test.runtime.mcpResources = () => []; await test.agent.whenIdle() }
})

it('lets a native job completion wake an idle root and retains one admission receipt on replay', async () => {
  const test = await fixture(['root done', 'job output collected'])
  const original = test.create('start background work')
  await test.scheduler.enqueue(original, [{ type: 'text', text: original.query }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  const message = createUserMessage({ content: [{ type: 'text', text: 'Native background job completed' }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'Background job completed' } })
  test.agent.followup(message)
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('Native background job completed')
  expect(test.db.getRun(test.owner.ownerId, message.id)).toMatchObject({ status: 'completed',
    selection: { native_source: 'tool-jobs', native_notice: true } })
  await reconcileNativeSessions(test.db, { observeSession: async () => ({ events: test.agent.session.snapshotEvents() }) }, test.owner.ownerId)
  expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(2)
  expect(test.model.requests).toHaveLength(2)
})

it('injects a native job completion into a busy root without starting a second business run', async () => {
  let release
  const test = await fixture([new Promise(resolve => { release = resolve }), 'collected'])
  const original = test.create('working')
  await test.scheduler.enqueue(original, [{ type: 'text', text: original.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  test.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Background output is ready' }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'Background job completed' } }))
  release('continue collecting')
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('Background output is ready')
  expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(1)
})

it('waits for the current MCP catalog before a native job wake freezes its scope and assembles the model prompt', async () => {
  const test = await fixture(['collected'], { scheduledClaims: true })
  test.runtime.mcpCatalogState = { ready: false }
  test.runtime.mcpResources = () => test.runtime.mcpCatalogState.ready ? [{ id: 'current-catalog' }] : []
  const resourceServer = { id: 'personal:mcp:resources', version: '2', manifest_version: 'current', capabilities: { resources: {} } }
  test.runtime.mcpPlugins = () => test.runtime.mcpCatalogState.ready ? [resourceServer] : []
  const message = createUserMessage({ content: [{ type: 'text', text: 'Background output is ready' }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'Background job completed' } })
  test.agent.followup(message)
  await vi.waitFor(() => expect(test.agent.status).toBe('running'))
  expect(test.model.requests).toHaveLength(0)
  expect(test.db.getRun(test.owner.ownerId, message.id)).toBeUndefined()
  test.runtime.mcpCatalogState.ready = true
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(1)
  expect(test.db.getRun(test.owner.ownerId, message.id).mcpTools).toEqual([{ id: 'current-catalog' }])
  expect(test.db.getRun(test.owner.ownerId, message.id).selection.mcp_servers).toEqual([resourceServer])
})

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

it.each(['terminal', 'browser'])('lets the original Agent handle a manually closed %s and explicitly reopen it', async name => {
  const test = await fixture([])
  const id = '12345678-1234-1234-1234-123456789abc'
  let rejectActive, opened = false, closes = 0
  const pending = new Promise((_, reject) => { rejectActive = reject })
  const script = name === 'terminal'
    ? [{ action: 'read', terminal_id: id, wait_ms: 0 }, { action: 'open', wait_ms: 0 }, 'reopened and continued']
    : [{ action: 'snapshot' }, { action: 'navigate', url: 'https://example.com/new' }, 'reopened and continued']
  test.model.stream = async function* (options) {
    this.requests.push(options)
    const value = script.shift()
    if (typeof value === 'object') {
      yield { type: 'tool-call-delta', index: 0, id: `resource-call-${this.requests.length}`, name, argumentsDelta: JSON.stringify(value) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      if (value === undefined) throw new Error('resource recovery model script exhausted')
      yield { type: 'text-delta', index: 0, text: value }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  let manualClose
  if (name === 'terminal') {
    let info = { id, title: 'bash', state: 'running' }
    let inspecting = false
    const native = {
      list: () => info ? [info] : [],
      create: async (_agent, request) => { opened = true; return info = { id: request.id, title: 'bash', state: 'running' } },
      inspectForAgent: async () => {
        if (!opened) { inspecting = true; return pending }
        return { info, screen: 'new shell ready', truncated: false }
      },
      close: async () => { closes++; info = undefined; rejectActive(new Error('Terminal closed by user')) },
    }
    registerTerminalTool(test.ctx, { native, runtime: test.runtime, database: test.db, ownerId: test.owner.ownerId })
    manualClose = async () => { await vi.waitFor(() => expect(inspecting).toBe(true)); await native.close() }
  } else {
    let acting = false
    const oldBrowser = { command: async () => { acting = true; return pending } }
    const replacement = { command: async () => ({ url: 'https://example.com/new', title: 'new page', revision: 1 }) }
    let current = oldBrowser
    const browsers = {
      create: async () => { if (!current) { opened = true; current = replacement } },
      require: () => current,
    }
    registerBrowserTool(test.ctx, { browsers, runtime: test.runtime, database: test.db, ownerId: test.owner.ownerId })
    manualClose = async () => { await vi.waitFor(() => expect(acting).toBe(true)); closes++; current = undefined; rejectActive(new Error('Browser closed by user')) }
  }
  const run = test.create(`Operate ${name}`)
  await test.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
  await test.scheduler.tick()
  await manualClose()
  await test.agent.whenIdle()
  expect(closes).toBe(1)
  expect(opened).toBe(true)
  expect(test.model.requests).toHaveLength(3)
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('closed by user')
  expect(test.db.getRun(test.owner.ownerId, run.id)).toMatchObject({ status: 'completed' })
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
})

async function fixture(script, { scheduledClaims = false } = {}) {
  const ctx = new Context()
  // New native skill and terminal consumers share the working-directory owner.
  ctx.provide('workingDirectory', { ensure: async agent => agent.session.header.cwd,
    get: session => session.header.cwd })
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
  controllerCtx.fileUploads = { retirePrompt() {}, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) }
  const controller = new SessionCommandController(controllerCtx, {
    resolveAgent: async () => ({ agent }), selectionFor: () => ({ current: { provider: 'mock', model: 'mock' } }),
  }, '/workspace')
  const sessions = { updateQueue: request => controller.updateQueue(request), prompt: request => controller.prompt(request, { kind: 'user', rpcId: request.requestId }), cancel: () => agent.cancel({ kind: 'user' }, { keepInbox: true }) }
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
  if (scheduledClaims) registerScheduledClaims(ctx, { runtime, database: db, ownerId: owner.ownerId })
  else ctx.on('agent/inbox/claimed', payload => projectInboxClaim(db, payload, owner.ownerId))
  ctx.on('agent/assistant-stream', createAssistantStreamProjector(db, owner.ownerId))
  ctx.on('session/event', (session, event) => projectSessionEvent(db, session.id, event, owner.ownerId,
    { goal: ctx.goals.get(agent), nativeIdle: agent.status === 'idle',
      ...(scheduledClaims ? { mcpCatalogReady: runtime.mcpCatalogState?.ready === true,
        mcpTools: runtime.mcpResources?.() ?? [], mcpServers: runtime.mcpPlugins?.() ?? [] } : {}) }))
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (status === 'idle') settleNativeIdle(db, current.id, ctx.goals.get(current))
  })
  ctx.on('agent/pre-step', (payload, next) => scheduler.admitNativeStep(payload, next), { prepend: true })
  const create = query => db.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: agent.id, query, selection: {},
    mcpTools: [{ id: 'personal:server:tool', version: 'v1' }] }).run
  return { ctx, db, agent, owner, chat, model, scheduler, runtime, sessions, controllerCtx, requests, create,
    permit: value => { permitted = value } }
}

async function registerUserSkills(test, names) {
  const [{ default: Skills }, SkillTool] = await Promise.all([native('dsh-skill'), native('dsh-tool-skill')])
  await test.ctx.plugin(Skills)
  await test.ctx.plugin(SkillTool)
  for (const name of names) cleanups.push(test.ctx.skills.register({ name, description: `Skill ${name}`,
    invocation: { userInvocable: true, modelInvocable: false }, source: 'custom',
    provider: 'gxzs-sandbox-personal', content: `BODY_FOR_${name}` }))
  return { skills: test.ctx.skills, workingDirectory: test.ctx.workingDirectory,
    onGoalChanged: listener => test.ctx.on('goal/changed', listener, { prepend: true }) }
}

async function delayedScheduledCatalog(test) {
  let available = false
  const configRequests = []
  const tool = { id: 'personal:server:search', runtime_name: 'personal_mcp_search', version: 'v1',
    manifest_version: 'm1', scope: 'personal', server_id: 'server', tool_name: 'search',
    description: 'Search records', inputSchema: { type: 'object', properties: {} } }
  test.ctx.provide('workbenchPlatformClient', { json: async request => {
    if (request.route === 'workbench/config') {
      configRequests.push(request)
      return { data: { enabled: true, system_prompt: 'fixture database prompt' } }
    }
    if (request.route !== 'mcp/catalog') return { data: { result: { content: [] } } }
    if (!available) throw Object.assign(new Error('bootstrap unavailable'), { status: 503 })
    return { tools: [tool] }
  } })
  await applyMcpTools(test.ctx)
  return { tool, configRequests, release() { available = true; test.ctx.emit('workbench/resources-changed') } }
}

it.each(['queue', 'steer'])('delivers native root %s after renewal without a second ticket or queue-to-steer request', async mode => {
  let release
  const test = await fixture([new Promise(resolve => { release = resolve }), 'received'])
  const first = test.create('working')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const next = test.create('new evidence')
  test.db.updateRunResources(next, { ...next.selection, prompt_mode: mode }, next.mcpTools)
  let unavailable = true
  const platform = test.scheduler.platformClient.json
  test.scheduler.platformClient.json = request => {
    if (unavailable && JSON.parse(request.body).action === 'renew')
      throw Object.assign(new Error('temporary unavailable'), { status: 503 })
    return platform(request)
  }
  await test.scheduler.enqueue(test.db.getRun(test.owner.ownerId, next.id), [{ type: 'text', text: next.query }])
  await test.scheduler.tick()
  expect([...test.agent.inbox.nextTurn, ...test.agent.inbox.nextStep]).toEqual([])
  expect(test.model.requests).toHaveLength(1)
  unavailable = false
  await test.scheduler.tick()
  const target = mode === 'steer' ? test.agent.inbox.nextStep : test.agent.inbox.nextTurn
  expect(target.map(message => message.source.rpcId)).toEqual([next.id])
  expect(test.requests.filter(request => request.action === 'acquire')).toHaveLength(1)
  release('first response')
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('new evidence')
  const firstTurn = test.db.getRun(test.owner.ownerId, first.id).turnNumber
  const accepted = test.db.getRun(test.owner.ownerId, next.id)
  expect(accepted.status).toBe(mode === 'steer' ? 'steered' : 'completed')
  expect(accepted.turnNumber === firstTurn).toBe(mode === 'steer')
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.rpcId === next.id)).toHaveLength(1)
})

it('lets the original AgentLoop handle a closed steering window as a new admitted turn and deduplicate its replay', async () => {
  const test = await fixture(['first response', 'next response'])
  const first = test.create('working')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  const next = test.create('late evidence')
  test.db.updateRunResources(next, { ...next.selection, prompt_mode: 'steer' }, next.mcpTools)
  const accepted = test.db.getRun(test.owner.ownerId, next.id)
  const content = [{ type: 'text', text: next.query }]
  await test.scheduler.enqueue(accepted, content)
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.db.getRun(test.owner.ownerId, next.id)).toMatchObject({ status: 'completed', turnNumber: 2 })
  expect(test.requests.filter(request => request.action === 'acquire')).toHaveLength(2)
  await dispatchRunPrompt(test, { ...accepted, sessionId: test.agent.id, selection: { ...accepted.selection, prompt_mode: 'queue' } }, content)
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.rpcId === next.id)).toHaveLength(1)
})

it('registers the sidebar browser with the real native prompt and tool services', async () => {
  const test = await fixture(['browser ready'])
  registerBrowserTool(test.ctx, { browsers: {}, runtime: test.runtime, database: test.db, ownerId: test.owner.ownerId })
  const run = test.create('Open the sidebar browser')
  await test.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(1)
  expect(JSON.stringify(test.model.requests[0])).toContain('The browser tool operates the single browser in the current chat sidebar')
  expect(test.model.requests[0].tools).toContainEqual(expect.objectContaining({ name: 'browser' }))
  expect(test.db.getRun(test.owner.ownerId, run.id).status).toBe('completed')
})

it.each(['failed','cancelled'])('keeps a resumed native child %s outcome and exposes its cancellable control receipt', async status => {
  const test = await fixture(['parent done', status === 'failed' ? new Error('child model failure') : 'hang'])
  const original = test.create('delegate')
  test.db.updateRunResources(original, {subagent_ids:['outcome-child']}, original.mcpTools)
  await test.scheduler.enqueue(original,[{type:'text',text:'delegate'}])
  await test.scheduler.tick(); await test.agent.whenIdle(); await test.scheduler.tick()
  const handle = await test.ctx.agents.create({sessionId:'outcome-child',parentAgent:test.agent,
    agentOptions:{provider:'mock',model:'mock'},meta:{cwd:'/workspace/conversations/native-chat',origin:'subagent'}})
  const child = handle.agent
  test.runtime.bindChild(child)
  const receipt = test.runtime.prepareChildPrompt(test.chat,{id:child.id,title:'验收助手'},'outcome')
  test.ctx.on('agent/status',({agent,status}) => { if (agent===child && status==='idle') test.runtime.settleChild(child) })
  const service = new WorkbenchService({database:test.db,sessionController:test.sessions,agents:test.ctx.agents,
    scheduler:test.scheduler,platformClient:{json:async()=>({data:{fenced:true}})},workspace:'/workspace'})
  service.cancelOwned = (id,runId) => test.runtime.cancelOwned(id,runId)
  child.followup(createUserMessage({content:[{type:'text',text:'continue'}],source:{kind:'user'}}))
  if (status==='cancelled') {
    await vi.waitFor(()=>expect(test.model.requests).toHaveLength(2))
    const view = service.getChat(test.owner,test.chat.id)
    expect(view.control_run).toMatchObject({id:receipt.id,status:'running',events:[]})
    expect(view.runs.some(run=>run.id===receipt.id)).toBe(false)
    await service.stopRun(test.owner,view.control_run.id)
  }
  await child.whenIdle()
  expect(test.db.getRun(test.owner.ownerId,receipt.id).status).toBe(status)
  expect(service.getChat(test.owner,test.chat.id).control_run).toBeNull()
  if (status==='failed') expect(test.db.pendingRunFences(test.owner.ownerId).some(run=>run.id===receipt.id)).toBe(true)
  await test.scheduler.flushFences()
  expect(test.db.getRun(test.owner.ownerId,receipt.id).stopConfirmation?.fenced).toBe(true)
  expect(() => test.runtime.prepareChildPrompt(test.chat,{id:child.id,title:'验收助手'},'outcome')).toThrow('该消息已结束')
  await handle.dispose()
})

it('reacquires real native admission before a later sidebar child step uses its frozen MCP scope', async () => {
  const test = await fixture(['parent done', 'child continued'])
  const original = test.create('delegate')
  test.db.updateRunResources(original, { subagent_ids: ['idle-child'] }, original.mcpTools)
  await test.scheduler.enqueue(original, [{ type: 'text', text: 'delegate' }])
  await test.scheduler.tick()
  await test.agent.whenIdle()
  await test.scheduler.tick()
  expect(test.scheduler.hasAdmission(test.agent.id)).toBe(false)
  const handle = await test.ctx.agents.create({ sessionId: 'idle-child', parentAgent: test.agent,
    agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: '/workspace/conversations/native-chat', origin: 'subagent' } })
  const child = handle.agent
  test.runtime.bindChild(child)
  const receipt = test.runtime.prepareChildPrompt(test.chat, { id: child.id, title: '调查员' }, 'later-sidebar-message')
  let authorization
  test.ctx.on('agent/pre-step', (payload, next) => {
    if (payload.agent === child) authorization = test.runtime.authorizeMcp(child.id, 'personal:server:tool', 'v1')
    return next()
  }, { global: true })
  child.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
  await child.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(test.requests).toContainEqual(expect.objectContaining({ action: 'acquire', run_id: receipt.id }))
  expect(authorization).toMatchObject({ runId: receipt.id, ownerId: test.owner.ownerId })
  test.runtime.settleChild(child)
  expect(test.db.getRun(test.owner.ownerId, receipt.id).status).toBe('completed')
  await handle.dispose()
})

it.each([false, true])('reloads personal user context for scheduled turns and child agents with complete prompt=%s', async complete => {
  const test = await fixture(['first', 'changed', 'cleared', 'child'], { scheduledClaims: true })
  test.runtime.mcpCatalogState = { ready: true }
  test.runtime.mcpResources = () => []
  let preferences = { version: 1, preferredName: '李律师', identity: '执行案件代理人',
    responseStyle: 'professional', customInstructions: '先给结论 {{literal}}' }
  test.ctx.provide('workbenchPlatformClient', { json: async () => ({ data: {
    enabled: true, system_prompt: 'platform instructions', user_preferences: preferences,
  } }) })
  registerDatabasePrompt(test.ctx, test.owner.ownerId)
  if (complete) {
    test.ctx.systemPrompt.section({ name: 'fixture:complete', order: 0, complete: true, text: 'complete fixture prompt' })
    test.ctx.systemPrompt.suppressRuntimeContext()
  }
  const send = async agent => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check records' }], source: { kind: 'schedule' } }))
    await agent.whenIdle()
  }
  const latestContext = agent => agent.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.source.kind === 'runtime-context').at(-1)?.data.content[0].text
  await send(test.agent)
  expect(latestContext(test.agent)).toContain('李律师')
  expect(JSON.stringify(test.model.requests[0].messages)).toContain('{{literal}}')
  const system = test.model.requests[0].messages.filter(message => message.role === 'system')
  expect(JSON.stringify(system)).not.toContain('李律师')
  preferences = { ...preferences, version: 2, preferredName: '李老师' }
  await send(test.agent)
  expect(latestContext(test.agent)).toContain('李老师')
  preferences = { version: 3, preferredName: '', identity: '', responseStyle: 'default', customInstructions: '' }
  await send(test.agent)
  expect(latestContext(test.agent)).not.toContain('李老师')
  preferences = { ...preferences, version: 4, preferredName: '子任务称呼' }
  const parent = test.db.listRuns(test.owner.ownerId, test.chat.id)[0]
  test.db.updateRunResources(parent, { ...parent.selection, subagent_ids: ['personal-prompt-child'] }, parent.mcpTools)
  const handle = await test.ctx.agents.create({ sessionId: 'personal-prompt-child', parentAgent: test.agent,
    agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: '/workspace/other', origin: 'subagent' } })
  const child = handle.agent
  test.runtime.bindChild(child)
  test.runtime.prepareChildPrompt(test.chat, { id: child.id, title: '偏好验收助手' }, 'prompt-child')
  child.followup(createUserMessage({ content: [{ type: 'text', text: 'Check delegated records' }], source: { kind: 'user' } }))
  await child.whenIdle()
  expect(latestContext(child)).toContain('子任务称呼')
  expect(test.model.requests).toHaveLength(4)
  await handle.dispose()
})

it.each([false, true])('assembles the actual first scheduled native request with verified MCP tools and complete prompt=%s', async complete => {
  const test = await fixture(['scheduled answer'], { scheduledClaims: true })
  const catalog = await delayedScheduledCatalog(test)
  registerDatabasePrompt(test.ctx, test.owner.ownerId)
  if (complete) test.ctx.systemPrompt.section({ name: 'fixture:complete', order: 0, complete: true, text: 'complete fixture prompt' })
  const claimed = vi.fn()
  test.ctx.on('agent/inbox/claimed', claimed)
  const message = createUserMessage({ content: [{ type: 'text', text: 'Use search to check records' }], source: { kind: 'schedule' } })
  test.agent.followup(message)
  await vi.waitFor(() => expect(claimed).toHaveBeenCalledOnce())
  expect(test.model.requests).toHaveLength(0)
  expect(test.db.getRun(test.owner.ownerId, message.id)).toBeUndefined()
  catalog.release()
  await vi.waitFor(() => expect(test.runtime.mcpCatalogState.ready).toBe(true))
  await test.agent.whenIdle()
  expect(claimed).toHaveBeenCalledOnce()
  expect(test.model.requests).toHaveLength(1)
  expect(test.model.requests[0].tools.map(tool => tool.name)).toContain('search')
  if (complete) {
    expect(JSON.stringify(test.model.requests[0])).toContain('complete fixture prompt')
    expect(JSON.stringify(test.model.requests[0])).not.toContain('当前可用 MCP 插件')
    expect(JSON.stringify(test.model.requests[0])).not.toContain('fixture database prompt')
  } else expect(JSON.stringify(test.model.requests[0])).toContain('当前可用 MCP 插件')
  expect(catalog.configRequests).toHaveLength(1)
  expect(test.db.getRun(test.owner.ownerId, message.id)).toMatchObject({ status: 'completed',
    mcpTools: [expect.objectContaining({ id: catalog.tool.id, version: 'v1', manifest_version: 'm1' })] })
})

it('cancels a delayed scheduled native assembly before creating a receipt or model request', async () => {
  const test = await fixture(['must not request'], { scheduledClaims: true })
  const catalog = await delayedScheduledCatalog(test)
  const claimed = vi.fn()
  test.ctx.on('agent/inbox/claimed', claimed)
  const message = createUserMessage({ content: [{ type: 'text', text: 'scheduled' }], source: { kind: 'schedule' } })
  test.agent.followup(message)
  await vi.waitFor(() => expect(claimed).toHaveBeenCalledOnce())
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
  catalog.release()
  await vi.waitFor(() => expect(test.runtime.mcpCatalogState.ready).toBe(true))
  expect(test.model.requests).toHaveLength(0)
  expect(test.db.getRun(test.owner.ownerId, message.id)).toBeUndefined()
})

it('runs background resume through the native inbox without making it a title input, including replay', async () => {
  const test = await fixture(['continued answer', 'human answer'])
  await test.ctx.plugin((await native('dsh-session-title')).default,
    { fallbackMaxWords: 8, fallbackMaxBytes: 100, maxTitleBytes: 200 })
  const original = test.create('Goal objective')
  test.db.transitionRun(test.owner.ownerId, original.id, 'cancelled')
  const resumed = test.db.createRun({ ownerId: test.owner.ownerId, chatId: test.chat.id, sessionId: test.agent.id,
    query: 'resume', parentRunId: original.id, selection: { silent_resume: true } }).run
  await test.scheduler.enqueue(resumed, [{ type: 'text', text: 'resume' }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  await test.agent.whenIdle()
  expect(test.db.getRun(test.owner.ownerId, resumed.id).status).toBe('completed')
  const events = test.agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'session/title')).toEqual([])
  expect(events.find(event => event.type === 'user/message').data.source).toEqual({ kind: 'workbench-resume', rpcId: resumed.id })
  await dispatchRunPrompt(test.scheduler, resumed, [{ type: 'text', text: 'resume' }])
  expect(test.model.requests).toHaveLength(1)
  await reconcileNativeSessions(test.db, { observeSession: async () => ({ events }) }, test.owner.ownerId)
  expect(test.db.runForTurn(test.agent.id, 1).id).toBe(resumed.id)
  const human = test.create('中文企业画像')
  await test.scheduler.enqueue(human, [{ type: 'text', text: human.query }])
  await test.scheduler.tick()
  await vi.waitFor(async () => { await test.scheduler.tick(); expect(test.model.requests).toHaveLength(2) })
  await test.agent.whenIdle()
  await vi.waitFor(() => expect(test.db.getChat(test.owner.ownerId, test.chat.id).title).toBe(human.query))
})

it.each(['local', 'native'])('edits and directly sends the selected %s queue item without waiting on unrelated scheduling', async placement => {
  let release
  const test = await fixture([new Promise(resolve => { release = resolve }), 'steered answer', 'queued answer'])
  const skills = await registerUserSkills(test, ['queue-helper'])
  const first = test.create('original'), second = test.create('keep queued')
  const third = test.db.createRun({ ownerId: test.owner.ownerId, chatId: test.chat.id, sessionId: test.agent.id,
    query: 'before edit', selection: { resource_mentions: { skills: ['queue-helper'] } }, mcpTools: [] }).run
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  for (const run of [second, third]) test.db.saveSubmission(test.owner.ownerId, run.id, [{ type: 'text', text: run.query }])
  if (placement === 'native') await test.scheduler.tick()
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents, scheduler: test.scheduler, ...skills })
  await service.editQueued(test.owner, third.id, { content: [{ type: 'text', text: 'edited supplement' }] })
  test.scheduler.pendingTick = new Promise(() => {})
  try {
    await service.steer(test.owner, third.id, first.id)
    expect(test.agent.inbox.nextStep.map(item => item.content[0].text)).toEqual(['edited supplement'])
    expect(test.db.getRun(test.owner.ownerId, second.id).status).toBe('queued')
  } finally { test.scheduler.pendingTick = null }
  await test.scheduler.tick()
  release('first answer')
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(3)
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('edited supplement')
  expect(JSON.stringify(test.model.requests[0].messages)).not.toContain('BODY_FOR_queue-helper')
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('BODY_FOR_queue-helper')
  expect(JSON.stringify(test.model.requests[1].messages)).not.toContain('keep queued')
  const messages = test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
  expect(messages.map(event => event.data.source.rpcId)).toEqual([first.id, third.id, second.id])
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')).toHaveLength(1)
  expect(service.getRun(test.owner, third.id)).toMatchObject({ query: 'edited supplement', resource_mentions: { skills: ['queue-helper'] } })
  expect(test.db.getRun(test.owner.ownerId, third.id).status).toBe('steered')
})

it.each(['local', 'native'])('removes only the selected %s queue item and consumes the remainder in order', async placement => {
  let release
  const test = await fixture([new Promise(resolve => { release = resolve }), 'answer A', 'answer C'])
  const first = test.create('first'), a = test.create('A'), b = test.create('B'), c = test.create('C')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  for (const run of [a, b, c]) test.db.saveSubmission(test.owner.ownerId, run.id, [{ type: 'text', text: run.query }])
  if (placement === 'native') await test.scheduler.tick()
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents, scheduler: test.scheduler })
  await service.removeQueued(test.owner, b.id)
  await test.scheduler.tick()
  release('first answer')
  await test.agent.whenIdle()
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.source.rpcId)).toEqual([first.id, a.id, c.id])
  expect(test.db.getRun(test.owner.ownerId, b.id).status).toBe('discarded')
})

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

it('publishes a skill catalog only when its actual display metadata changes', async () => {
  const test = await fixture(['first', 'unchanged', 'renamed', 'unchanged again'])
  const [{ default: Skills }, SkillTool] = await Promise.all([native('dsh-skill'), native('dsh-tool-skill')])
  await test.ctx.plugin(Skills)
  await test.ctx.plugin(SkillTool)
  let label = '证据整理'
  let invalidate
  cleanups.push(test.ctx.skills.registerProvider(control => { invalidate = control.invalidate; return { name: 'fixture', list: async () => [{
    name: 'evidence', description: 'Evidence', metadata: { 'display-name': label },
    invocation: { modelInvocable: true, userInvocable: true }, source: 'custom', provider: 'fixture', rank: 100,
  }], get: async () => undefined } }))
  for (let index = 0; index < 4; index += 1) {
    if (index === 2) { label = '证据复核'; invalidate() }
    const run = test.create(`question ${index}`)
    await test.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
    await test.scheduler.tick()
    await vi.waitFor(async () => { await test.scheduler.tick(); expect(test.model.requests).toHaveLength(index + 1) })
    await test.agent.whenIdle()
  }
  const catalogs = test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-catalog')
  expect(catalogs).toHaveLength(2)
  expect(catalogs.map(event => event.data.source.entries[0].displayName)).toEqual(['证据整理', '证据复核'])
  expect(catalogs[1].data.source.update).toBe(true)
})

it('reuses a legacy skill catalog without a display name without rewriting its history', async () => {
  const test = await fixture(['first', 'unchanged'])
  const [{ default: Skills }, SkillTool] = await Promise.all([native('dsh-skill'), native('dsh-tool-skill')])
  await test.ctx.plugin(Skills)
  await test.ctx.plugin(SkillTool)
  const source = { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'evidence', description: 'Evidence' }] }
  test.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Existing evidence catalog' }], source }), { surfaceOp: 'append' })
  cleanups.push(test.ctx.skills.registerProvider(() => ({ name: 'fixture', list: async () => [{
    name: 'evidence', description: 'Evidence', invocation: { modelInvocable: true, userInvocable: true },
    source: 'custom', provider: 'fixture', rank: 100,
  }], get: async () => undefined })))
  for (let index = 0; index < 2; index += 1) {
    const run = test.create(`question ${index}`)
    await test.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
    await test.scheduler.tick()
    await vi.waitFor(async () => { await test.scheduler.tick(); expect(test.model.requests).toHaveLength(index + 1) })
    await test.agent.whenIdle()
  }
  const catalogs = test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-catalog')
  expect(catalogs).toHaveLength(1)
  expect(catalogs[0].data.source).toEqual(source)
})

it('delivers a durable queued file through native upload and prompt admission', async () => {
  const test = await fixture(['File received', 'Restored file received'])
  const root = await mkdtemp(join(process.cwd(), '.attachment-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const { LocalAttachmentStore } = await native('dsh-attachment-local')
  await test.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  const hostAttachmentRoot = join(root, 'attachments')
  const sandboxAttachmentRoot = '/srv/dsh/attachments'
  test.ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access' })
  const ssh = { request: vi.fn(async (method, { target }) => {
    expect(method).toBe('fs.readBytes')
    expect(target.targetKey.startsWith(`${sandboxAttachmentRoot}/`)).toBe(true)
    const relative = target.targetKey.slice(sandboxAttachmentRoot.length + 1)
    return (await readFile(join(hostAttachmentRoot, ...relative.split('/')))).toString('base64')
  }) }
  test.ctx.provide('ssh', ssh)
  await test.ctx.plugin(WorkbenchFileSystem, { attachmentHostRoot: hostAttachmentRoot, attachmentSandboxRoot: sandboxAttachmentRoot })
  test.ctx.provide('connection', { fetch: { register: () => () => {} } })
  const { FileUploads } = await native('dsh-client-file-upload')
  await test.ctx.plugin(FileUploads)
  test.controllerCtx.attachments = test.ctx.attachments
  test.controllerCtx.fileUploads = test.ctx.fileUploads
  test.scheduler.prepareContent = (sessionId, content) => prepareNativeFiles(test.ctx.fileUploads, sessionId, content)
  const run = test.create('Read the evidence')
  const name = "资料 '副本' (2026).txt"
  const content = [{ type: 'text', text: run.query }, { type: 'file', name, data: Buffer.from('durable evidence').toString('base64') }]
  // Rehydrate the actual queue row without an in-memory upload receipt.
  test.db.saveSubmission(test.owner.ownerId, run.id, JSON.parse(JSON.stringify(content)))
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  await test.agent.whenIdle()
  const messages = test.agent.session.snapshotEvents().filter(event => event.type === 'user/message')
  const files = messages.flatMap(event => event.data.content ?? []).filter(part => part.type === 'file')
  expect(files).toHaveLength(1)
  expect(await readFile(test.ctx.attachments.fileHostPath(files[0].attachment), 'utf8')).toBe('durable evidence')
  const expectedPath = `${sandboxAttachmentRoot}/v1/files/${String(files[0].attachment.attachmentId).slice(7, 9)}/${String(files[0].attachment.attachmentId).slice(7)}/${name}`
  const text = test.model.requests[0].messages.flatMap(message => message.content).filter(part => part.type === 'text').map(part => part.text).join('\n')
  expect(text).toContain(`verbatim read-only copy saved at ${JSON.stringify(expectedPath)}`)
  expect(text).not.toContain('cannot access a readable path')
  expect(await test.ctx.fs.readBytes({ targetKey: expectedPath }, new AbortController().signal)).toEqual(Buffer.from('durable evidence'))
  // History persists the reference, not a host path or an expired upload receipt.
  const restoredMessages = JSON.parse(JSON.stringify(messages.map(event => event.data)))
  expect(restoredMessages[0].content.some(part => part.type === 'file')).toBe(true)
  expect(JSON.stringify(restoredMessages)).not.toContain(hostAttachmentRoot)
  for await (const _ of test.ctx.llm.stream({ ...test.model.requests[0], messages: restoredMessages, signal: new AbortController().signal })) {}
  expect(JSON.stringify(test.model.requests[1])).toContain('/srv/dsh/attachments/v1/files/')
  expect(JSON.stringify(test.model.requests[1])).not.toContain('cannot access a readable path')
  await test.scheduler.tick()
  expect(test.model.requests).toHaveLength(2)
})

it('resolves a normalized image through the same native attachment path contract', async () => {
  const test = await fixture([])
  const root = await mkdtemp(join(process.cwd(), '.attachment-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const [{ LocalAttachmentStore }, { resolveImageAttachmentAccess, offloadedImageText }] = await Promise.all([
    native('dsh-attachment-local'), native('dsh-llm'),
  ])
  await test.ctx.plugin(LocalAttachmentStore, { dshHome: root })
  test.ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access' })
  test.ctx.provide('ssh', { request: vi.fn() })
  await test.ctx.plugin(WorkbenchFileSystem, { attachmentHostRoot: join(root, 'attachments') })
  const ref = await test.ctx.attachments.saveImage({ name: 'pixel.png', mediaType: 'image/png',
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') })
  const access = resolveImageAttachmentAccess(test.ctx.attachments, path => test.ctx.fs.processPathFromHostPath(path), ref)
  expect(access.readonlyPath).toBe(`/srv/dsh/attachments/v1/objects/${String(ref.attachmentId).slice(7, 9)}/${String(ref.attachmentId).slice(7)}`)
  expect(offloadedImageText(ref, access)).toContain(access.readonlyPath)
  expect(offloadedImageText(ref, access)).not.toContain('No local normalized image path')
})

it('retains sandbox-path file references when editing a goal with an older manager', async () => {
  const test = await fixture(['hang'])
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, commands: test.ctx.commands, goals: test.ctx.goals, workspace: '/workspace',
    skills: { list: async () => [] }, platformClient: { json: async () => ({ tools: [] }) },
    fileManager: { operate: async () => ({ kind: 'file', version: 'v1', data: Buffer.from('evidence').toString('base64') }) } })
  await service.issueCommand(test.owner, test.chat.id, { command: '/goal Review evidence', request_key: 'legacy-goal' })
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const body = { command: '/goal edit Review new evidence', request_key: 'legacy-edit', files: [{ path: 'evidence.txt', version: 'v1' }] }
  await service.issueCommand(test.owner, test.chat.id, body)
  await service.issueCommand(test.owner, test.chat.id, body)
  const messages = [...test.agent.inbox.nextTurn, ...test.agent.inbox.nextStep]
  expect(messages.filter(message => JSON.stringify(message.content).includes('/workspace/evidence.txt'))).toHaveLength(1)
  expect(test.ctx.goals.get(test.agent).objective).toBe('Review new evidence')
  test.ctx.goals.pause(test.agent, test.ctx.goals.get(test.agent))
  test.agent.cancel({ kind: 'user' })
  await test.agent.whenIdle()
})

it('freezes a goal resource selection separately from the already running request', async () => {
  let finishCurrent
  const test = await fixture([new Promise(resolve => { finishCurrent = resolve }), 'hang'])
  const current = test.create('Existing work')
  test.db.saveSubmission(test.owner.ownerId, current.id, [{ type: 'text', text: current.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const skills = await registerUserSkills(test, ['evidence'])
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, commands: test.ctx.commands, goals: test.ctx.goals, workspace: '/workspace',
    ...skills,
    fileManager: { operate: async () => ({}) },
    platformClient: { json: async () => ({ tools: [] }) } })
  const response = await service.issueCommand(test.owner, test.chat.id, { command: '/goal Audit evidence', request_key: 'active-goal',
    resource_mentions: { skills: ['personal:evidence'] } })
  expect(response.run.id).not.toBe(current.id)
  expect(test.db.getRun(test.owner.ownerId, current.id).mcpTools).toEqual(current.mcpTools)
  expect(test.db.getRun(test.owner.ownerId, response.run.id).selection.resource_mentions.skills).toEqual(['personal:evidence'])
  finishCurrent('Previous request completed')
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(2))
  expect(JSON.stringify(test.model.requests[1])).toContain('BODY_FOR_evidence')
  test.ctx.goals.pause(test.agent, test.ctx.goals.get(test.agent))
  test.agent.cancel({ kind: 'user' })
  await test.agent.whenIdle()
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
    scheduler: test.scheduler, commands: test.ctx.commands, goals: test.ctx.goals, fileUploads: test.ctx.fileUploads, attachments: test.ctx.attachments, workspace: '/workspace', nativeFileAttachments: true,
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
  const skills = await registerUserSkills(test, ['evidence'])
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, goals: test.ctx.goals, commands: test.ctx.commands, workspace: '/workspace',
    ...skills,
    platformClient: { json: async () => ({ data: { fenced: true } }) },
    fileManager: { operate: async () => ({}) } })
  test.permit(false)
  const result = await service.issueCommand(test.owner, test.chat.id, { command: '/goal check command admission', request_key: 'goal-command', resource_mentions: { skills: ['evidence'] } })
  expect(result.run).toMatchObject({ chat_id: test.chat.id })
  await vi.waitFor(() => expect(test.requests.some(request => request.action === 'acquire')).toBe(true))
  expect(test.model.requests).toHaveLength(0)
  test.permit(true)
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  expect(JSON.stringify(test.model.requests[0])).toContain('BODY_FOR_evidence')
  expect(result.run).toMatchObject({ command: 'goal', query: 'check command admission' })
  expect(result.run.resource_mentions.skills).toEqual(['evidence'])
  expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(1)
  const run = test.db.getRun(test.owner.ownerId, result.run.id)
  const messages = test.agent.session.snapshotEvents().filter(event => event.type === 'user/message')
  expect(messages.some(event => event.data.source.kind === 'user' && event.data.content[0]?.text === 'check command admission'
    && event.data.content[1]?.text === '/evidence')).toBe(true)
  expect(messages.flatMap(event => nativePresentation(run, event,
    { messageRun: test.db.runForMessage(test.agent.id, event.data.id) }))).toEqual([])
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

it('keeps an actual owned child admitted with frozen MCP authority while its parent waits for a human answer', async () => {
  const test = await fixture(['hang', 'child completed while parent waits'])
  const run = test.create('parent question')
  await test.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const questionLifetime = new AbortController()
  const bridge = new HumanInputBridge({ database: test.db, executionRun: id => test.runtime.executionRun(id),
    resumeInput: (receipt, signal) => test.scheduler.resumeInput(receipt, signal) })
  const answer = bridge.handleRequest({ agent: test.agent, questions: [{ id: 'continue', question: 'Continue?' }], signal: questionLifetime.signal }, () => undefined)
  void answer.catch(() => {})
  const childHandle = await test.ctx.agents.create({ sessionId: 'question-child', parentAgent: test.agent,
    meta: { parentSession: test.agent.id, origin: 'subagent' }, agentOptions: { provider: 'mock', model: 'mock' } })
  cleanups.push(async () => {
    questionLifetime.abort(); await answer.catch(() => {})
    test.agent.cancel({ kind: 'user' }, { keepInbox: true }); await test.agent.whenIdle()
    await childHandle.dispose()
  })
  const child = childHandle.agent
  test.runtime.bindChild(child)
  test.scheduler.hasOwnedWork = (id, runId) => test.runtime.hasOwnedWork(id, runId)
  let childAuthority, backendAuthority, parentAuthority
  test.ctx.on('agent/pre-step', (payload, next) => {
    if (payload.agent === child) {
      childAuthority = test.runtime.authorizeMcp(child.id, 'personal:server:tool', 'v1')
      backendAuthority = test.runtime.authorizeRunMcp(test.owner.ownerId, run.id, 'personal:server:tool', 'v1')
      parentAuthority = test.runtime.authorizeMcp(test.agent.id, 'personal:server:tool', 'v1')
      expect(test.runtime.authorizeMcp(child.id, 'personal:server:tool', 'v2')).toBeUndefined()
      expect(test.runtime.authorizeMcp(child.id, 'personal:other:tool', 'v1')).toBeUndefined()
      expect(test.runtime.authorizeRunMcp('t:other', run.id, 'personal:server:tool', 'v1')).toBe(false)
      expect(test.runtime.authorizeRunMcp(test.owner.ownerId, run.id, 'personal:server:tool', 'v2')).toBe(false)
      expect(test.runtime.authorizeRunMcp(test.owner.ownerId, run.id, 'personal:other:tool', 'v1')).toBe(false)
      const lease = test.scheduler.leases.get(test.agent.id)
      test.scheduler.leases.set(test.agent.id, { ...lease, checkedAt: Date.now() - 10001 })
      try {
        expect(test.runtime.authorizeMcp(child.id, 'personal:server:tool', 'v1')).toBeUndefined()
        expect(test.runtime.authorizeRunMcp(test.owner.ownerId, run.id, 'personal:server:tool', 'v1')).toBe(false)
      } finally { test.scheduler.leases.set(test.agent.id, lease) }
    }
    return next()
  }, { global: true })
  child.followup(createUserMessage({ content: [{ type: 'text', text: 'continue delegated work' }], source: { kind: 'user' } }))
  await child.whenIdle()
  expect(child.session.snapshotEvents().findLast(event => event.type === 'turn/end').data.reason.kind).toBe('completed')
  expect(test.model.requests).toHaveLength(2)
  expect(childAuthority).toMatchObject({ runId: run.id, ownerId: test.owner.ownerId })
  expect(backendAuthority).toBe(true)
  expect(parentAuthority).toBeUndefined()
  expect(test.db.getRun(test.owner.ownerId, run.id).status).toBe('waiting_input')
  expect(test.db.getPendingInput(test.owner.ownerId, run.id).status).toBe('pending')
  expect(test.runtime.authorizeRunMcp(test.owner.ownerId, run.id, 'personal:server:tool', 'v1')).toBe(false)
})

it.each(['button', 'command'])('preserves native goal state and resource context when resuming via %s', async (entry) => {
  const test = await fixture(['hang', 'hang'])
  const skills = await registerUserSkills(test, ['evidence'])
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, goals: test.ctx.goals, commands: test.ctx.commands, workspace: '/workspace',
    ...skills,
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
  expect(edited.phase).toBe('paused')
  expect(test.agent.inbox.nextTurn).toHaveLength(0)
  expect(test.model.requests).toHaveLength(1)
  if (entry === 'button') await service.mutateGoal(test.owner, test.chat.id, 'resume', { ref: edited })
  else await service.issueCommand(test.owner, test.chat.id, { command: '/goal resume', request_key: 'native-resume' })
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(2))
  expect(JSON.stringify(test.model.requests[1])).toContain('BODY_FOR_evidence')
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')).toHaveLength(2)
  expect((await service.getControl(test.owner, test.chat.id)).goal).toMatchObject({ phase: 'active', activation: 'armed', objective: 'Review all evidence' })
  await service.mutateGoal(test.owner, test.chat.id, 'clear', { ref: test.ctx.goals.get(test.agent) })
  test.agent.cancel({ kind: 'user' }, { keepInbox: true })
  await test.agent.whenIdle()
  expect((await service.getControl(test.owner, test.chat.id)).goal).toBeNull()
})

it('uses the native retained estimate immediately after compaction, on reload, then fresh provider usage', async () => {
  const test = await fixture([])
  const { default: TokenMeter } = await native('dsh-token-meter')
  const { createMessage } = await native('dsh-llm')
  await test.ctx.plugin(TokenMeter)
  const session = test.agent.session
  session.append('system/message', { message: createMessage({ role: 'system', content: [{ type: 'text', text: 'native test instructions' }] }) }, { surfaceOp: 'append' })
  session.append('request/header', { header: { config: {}, tools: [{ name: 'inspect', description: 'inspect test artifacts', inputSchema: { type: 'object', properties: {} } }] } })
  session.append('request/context', { provider: 'mock', model: 'mock', contextWindow: 100000 })
  const first = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'long context '.repeat(1000) }], source: { kind: 'test' } }), { surfaceOp: 'append' }).seq
  const usage = { inputTokens: 9000, outputTokens: 20 }
  session.append('step/start', { turn: 1, step: 1 })
  const last = session.append('assistant/message', {
    turn: 1, step: 1, usage, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' }).seq
  session.append('step/end', { turn: 1, step: 1 })
  const service = new WorkbenchService({ database: test.db, agents: test.ctx.agents,
    sessionQuery: { observeSession: async () => ({ events: session.snapshotEvents(), projections: test.ctx.sessionProjections.snapshot(session) }) } })
  const beforeControl = await service.getControl(test.owner, test.chat.id)
  const before = beforeControl.contextPressure
  expect(beforeControl.contextBreakdown).toEqual(test.ctx.sessionProjections.snapshot(session).values.contextBreakdown)
  expect(Object.values(beforeControl.contextBreakdown).every(value => value > 0)).toBe(true)
  const nodes = test.ctx.tokenMeter.measure(session).nodes.filter(node => node.seq >= first && node.seq <= last)
  session.append('compaction/summary', { compactionId: 'compact-test', summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start: first, end: last }, shadowedSeqs: nodes.map(node => node.seq), shadowedTokenCount: nodes.reduce((total, node) => total + node.tokens, 0), provider: 'mock', model: 'mock' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'test' } }),
    { surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: [first, last] })
  const afterControl = await service.getControl(test.owner, test.chat.id)
  const after = afterControl.contextPressure
  expect(afterControl.contextBreakdown.systemTokens).toBe(beforeControl.contextBreakdown.systemTokens)
  expect(afterControl.contextBreakdown.toolsTokens).toBe(beforeControl.contextBreakdown.toolsTokens)
  expect(afterControl.contextBreakdown.messageTokens).toBeLessThan(beforeControl.contextBreakdown.messageTokens)
  expect(after.pressureTokens).toBe(before.pressureTokens)
  expect(after.projectedTokens).toBeLessThan(before.projectedTokens)
  expect(after.projectedTokens).toBe(Object.values(afterControl.contextBreakdown).reduce((sum, tokens) => sum + tokens, 0))
  expect(test.ctx.sessionProjections.snapshot(session).values.contextPressure.projectedTokens).toBeGreaterThan(after.projectedTokens)
  expect(after.contextWindow).toBe(100000)
  const restored = new WorkbenchService({ database: test.db, agents: { get: () => undefined }, sessionQuery: service.sessionQuery })
  expect((await restored.getControl(test.owner, test.chat.id)).contextPressure).toEqual(after)
  const freshUsage = { inputTokens: 500, outputTokens: 20 }
  session.append('assistant/message', {
    turn: 2, step: 1, usage: freshUsage, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: freshUsage } }],
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'new answer' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
  expect((await service.getControl(test.owner, test.chat.id)).contextPressure).toEqual(test.ctx.sessionProjections.snapshot(session).values.contextPressure)
  expect(test.model.requests).toHaveLength(0)
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

it('acknowledges slow native compaction without holding chat admission and settles from native events', async () => {
  const test = await fixture([])
  let finish
  const compactNow = vi.fn(() => new Promise(resolve => { finish = resolve }))
  test.ctx.provide('compaction', { compactNow })
  await test.ctx.plugin(await native('dsh-command-compact'))
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    commands: test.ctx.commands, workspace: '/workspace', fileManager: { operate: async () => ({}) },
    sessionQuery: { observeSession: async () => ({ events: test.agent.session.snapshotEvents(), [Symbol.dispose]() {} }) } })
  const body = { command: '/compact', request_key: 'background-compact', background: true }
  try {
    const accepted = await service.issueCommand(test.owner, test.chat.id, body)
    expect(accepted).toMatchObject({ accepted: true, command_id: expect.any(String), run: null })
    expect(accepted.state.commands).toEqual([expect.objectContaining({ id: accepted.command_id, outcome: null })])
    expect(await service.withChatMutation(test.chat.id, async () => 'available')).toBe('available')
    expect(await service.issueCommand(test.owner, test.chat.id, body)).toEqual(accepted)
    expect(compactNow).toHaveBeenCalledOnce()
    finish(null)
    await vi.waitFor(async () => expect((await service.getControl(test.owner, test.chat.id)).commands[0].outcome).toMatchObject({ kind: 'success' }))
    expect(test.db.listRuns(test.owner.ownerId, test.chat.id)).toHaveLength(0)
  } finally { finish?.(null) }
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

it('keeps a late steering message queued for native admission after asynchronous preparation', async () => {
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
  await expect(steering).resolves.toMatchObject({ status: 'queued' })
  expect(test.db.getRun('t:1', second.id).status).toBe('queued')
  expect(test.db.getRun('t:1', second.id).selection.prompt_mode).toBe('steer')
  expect(test.db.submission('t:1', second.id).dispatched).toBe(false)
  expect(test.model.requests).toHaveLength(1)
})

it('keeps the native next turn when the prior turn finishes inside prompt admission', async () => {
  let finishFirst, admit
  const test = await fixture([new Promise(resolve => { finishFirst = resolve }), 'late evidence received'])
  const first = test.create('first'), second = test.create('late evidence')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  test.db.saveSubmission(test.owner.ownerId, second.id, [{ type: 'text', text: second.query }])
  test.controllerCtx.attachments.admitPromptContent = content => new Promise(resolve => { admit = () => resolve(content) })
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions,
    agents: test.ctx.agents, scheduler: test.scheduler })
  const steering = service.steer(test.owner, second.id, first.id)
  await vi.waitFor(() => expect(admit).toBeTypeOf('function'))
  finishFirst('first answer')
  await test.agent.whenIdle()
  admit()
  const receipt = await steering
  expect(receipt.steer_target_run_id).toBeUndefined()
  await test.agent.whenIdle()
  expect(test.db.getRun(test.owner.ownerId, second.id)).toMatchObject({ status: 'completed', turnNumber: 2 })
  expect(test.model.requests).toHaveLength(2)
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.rpcId === second.id)).toHaveLength(1)
  await expect(service.steer(test.owner, second.id, first.id)).resolves.toMatchObject({ status: 'completed' })
  await test.scheduler.tick()
  expect(test.model.requests).toHaveLength(2)
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
function goalServiceFixture(test) {
  return new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, goals: test.ctx.goals, commands: test.ctx.commands, workspace: '/workspace',
    workingDirectory: test.ctx.workingDirectory, onGoalChanged: listener => test.ctx.on('goal/changed', listener, { prepend: true }),
    platformClient: { json: async () => ({ data: { tools: [] } }) }, skills: { list: async () => [] }, fileManager: { operate: async () => ({}) } })
}
it.each(['slash', 'button'])('pauses through the native model tool after steering and resumes once through %s', async method => {
  const t = await fixture([]), s = goalServiceFixture(t)
  const GoalTool = await native('dsh-tool-goal')
  await t.ctx.plugin(GoalTool, {})
  let release
  const first = new Promise(resolve => { release = resolve })
  t.model.stream = async function* (options) {
    this.requests.push(options)
    const step = this.requests.length
    if (step === 1) await first
    if (step === 2 || step === 3) {
      const goal = t.ctx.goals.get(t.agent)
      yield { type: 'tool-call-delta', index: 0, id: `goal-control-${step}`,
        name: step === 2 ? 'get_goal' : 'update_goal',
        argumentsDelta: JSON.stringify(step === 2 ? {} : { goal_id: goal.id, revision: goal.revision, action: 'pause' }) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'text-delta', index: 0, text: step === 1 ? '处理中' : '本轮完成' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const started = await s.issueCommand(t.owner, t.chat.id, { command: '/goal 核验材料', request_key: 'goal-tool-pause' })
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(1))
  const pause = t.create('先暂停，待会儿继续')
  t.db.saveSubmission(t.owner.ownerId, pause.id, [{ type: 'text', text: pause.query }])
  await t.scheduler.tick()
  await s.steer(t.owner, pause.id, started.run.id)
  await s.steer(t.owner, pause.id, started.run.id)
  release()
  await t.agent.whenIdle()
  expect(t.ctx.goals.get(t.agent)).toMatchObject({ phase: 'paused', activation: 'disarmed', roundsStarted: 1 })
  const history = () => t.agent.session.snapshotEvents()
  expect(history().filter(event => event.type === 'user/message' && event.data.source.rpcId === pause.id)).toHaveLength(1)
  expect(history().filter(event => event.type === 'goal/change' && event.data.operation === 'pause')).toHaveLength(1)
  expect(t.db.getRun(t.owner.ownerId, pause.id).status).toBe('steered')
  const requests = t.model.requests.length
  await t.scheduler.tick()
  await t.agent.whenIdle()
  expect(t.model.requests).toHaveLength(requests)
  // Bound the resumed fake model while checking real native activation and receipt ownership.
  t.model.script = ['hang']
  t.model.stream = FakeModel.prototype.stream
  const resumed = method === 'slash'
    ? await s.issueCommand(t.owner, t.chat.id, { command: '/goal resume', request_key: 'resume-tool-paused' })
    : await s.mutateGoal(t.owner, t.chat.id, 'resume', { ref: t.ctx.goals.get(t.agent) })
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(requests + 1))
  expect(t.ctx.goals.get(t.agent)).toMatchObject({ phase: 'active', activation: 'armed', roundsStarted: 2 })
  expect(resumed.run.is_continuation).toBe(true)
  await s.mutateGoal(t.owner, t.chat.id, 'pause', { ref: t.ctx.goals.get(t.agent) })
  await t.agent.whenIdle()
  expect(t.model.requests).toHaveLength(requests + 1)
  expect(history().filter(event => event.type === 'user/message' && event.data.source.rpcId === pause.id)).toHaveLength(1)
})

it.each(['slash', 'button', 'message'])('consumes pending steering once after native pause and %s resume', async method => {
  const t = await fixture(['hang', 'hang']), s = goalServiceFixture(t)
  const started = await s.issueCommand(t.owner, t.chat.id, { command: '/goal 核验材料', request_key: 'pause-pending' })
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(1))
  const attachment = { name: '材料.pdf', path: '材料.pdf' }
  const pending = t.db.createRun({ ownerId: t.owner.ownerId, chatId: t.chat.id, sessionId: t.agent.id,
    query: '补充材料', selection: {}, attachments: [attachment] }).run
  t.db.saveSubmission(t.owner.ownerId, pending.id, [{ type: 'text', text: pending.query }])
  await t.scheduler.tick()
  await s.steer(t.owner, pending.id, started.run.id)
  await s.mutateGoal(t.owner, t.chat.id, 'pause', { ref: t.ctx.goals.get(t.agent) })
  await t.agent.whenIdle()
  const consumed = () => t.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.rpcId === pending.id)
  expect(consumed()).toHaveLength(0)
  expect(t.agent.inbox.nextStep.map(message => message.source.rpcId)).toContain(pending.id)
  await t.scheduler.tick()
  await t.agent.whenIdle()
  expect(t.model.requests).toHaveLength(1)
  let resumed
  if (method === 'message') {
    const next = t.create('继续核验另一个材料')
    await dispatchRunPrompt(t.scheduler, next, [{ type: 'text', text: next.query }])
    resumed = { run: s.inputRunDto(t.owner, t.db.getRun(t.owner.ownerId, next.id)) }
  } else {
    resumed = method === 'slash'
      ? await s.issueCommand(t.owner, t.chat.id, { command: '/goal resume', request_key: 'resume-pending' })
      : await s.mutateGoal(t.owner, t.chat.id, 'resume', { ref: t.ctx.goals.get(t.agent) })
  }
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(2))
  if (method === 'message') t.sessions.cancel({ sessionId: t.agent.id })
  else await s.mutateGoal(t.owner, t.chat.id, 'pause', { ref: t.ctx.goals.get(t.agent) })
  await t.agent.whenIdle()
  expect(consumed()).toHaveLength(1)
  expect(s.getRun(t.owner, pending.id).steer_target_run_id).toBe(started.run.id)
  await expect(s.steer(t.owner, pending.id, started.run.id)).resolves.toMatchObject({ status: 'steered' })
  const records = t.agent.session.snapshotEvents()
  const consumingTurn = t.db.getRun(t.owner.ownerId, resumed.run.id).turnNumber
  const start = records.findIndex(event => event.type === 'turn/start' && event.data.turn === consumingTurn)
  const page = () => s.historyPageView(t.owner, t.db.getChat(t.owner.ownerId, t.chat.id), {
    through_seq: records.at(-1).seq, records: records.slice(start).map(event => ({ event })),
  }, false, true)
  expect(page().runs).toHaveLength(1)
  expect(page().runs[0].steering_messages).toMatchObject([{ id: pending.id, query: pending.query, attachments: [attachment] }])
  const before = t.db.steeringEvents(t.owner.ownerId, resumed.run.id)
  await reconcileNativeSessions(t.db, { observeSession: async () => ({ events: records }) }, t.owner.ownerId)
  expect(t.db.steeringEvents(t.owner.ownerId, resumed.run.id)).toEqual(before)
  if (method !== 'message') expect(resumed.run).toMatchObject({ is_continuation: true, parent_run_id: started.run.id })
  const { HistoryPresentation } = await import('../src/history-presentation.js')
  const projection = new HistoryPresentation(t.agent.id,
    turn => Number.isInteger(turn) ? t.db.runForTurn(t.agent.id, turn) : undefined,
    undefined, id => t.db.runForMessage(t.agent.id, id))
  const display = projection.accept({ type: 'snapshot', records: t.agent.session.snapshotEvents().map(event => ({ event })) })
  expect(display.events.filter(item => item.event.event === 'workbench_steering')).toMatchObject([
    { run_id: resumed.run.id, event: { steering_id: pending.id, query: pending.query } },
  ])
})

it.each(['slash', 'button'])('keeps native Goal text clean and preserves model-visible plugin binding across %s resume', async method => {
  const t = await fixture(['hang', 'hang', 'hang']), s = goalServiceFixture(t)
  const tool = { id: 'personal:mcp:douyin:lookup', runtime_name: 'douyin_lookup', version: 'v1', manifest_version: 'm1',
    scope: 'personal', server_id: 'douyin', provider_call_name: 'douyin', tool_name: 'lookup', description: '查询视频', inputSchema: { type: 'object' } }
  s.platformClient = { json: async () => ({ tools: [tool] }) }
  const first = await s.issueCommand(t.owner, t.chat.id, { command: '/goal 请搜索视频', request_key: 'plugin-goal',
    resource_mentions: { plugins: ['douyin'] }, mention_positions: [{ kind: 'tools', id: 'douyin', offset: 1 }] })
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(1))
  expect(t.ctx.goals.get(t.agent).objective).toBe('请搜索视频')
  expect((await s.getControl(t.owner, t.chat.id)).goal.objective).toBe('请搜索视频')
  expect(JSON.stringify(t.model.requests[0])).toContain('请【插件：douyin】搜索视频')
  const { Session } = await native('dsh-session')
  const restored = Session.create(t.agent.id, t.agent.session.snapshotEvents(), t.agent.session.header)
  expect(t.ctx.sessionProjections.stateOf(restored, 'goal').current.goal.objective).toBe('请搜索视频')
  t.ctx.goals.pause(t.agent, t.ctx.goals.get(t.agent)); await t.agent.whenIdle()
  const resumed = method === 'slash'
    ? await s.issueCommand(t.owner, t.chat.id, { command: '/goal resume', request_key: 'plugin-resume' })
    : await s.mutateGoal(t.owner, t.chat.id, 'resume', { ref: t.ctx.goals.get(t.agent) })
  expect(resumed.run.query).toBe('请搜索视频')
  expect(resumed.run.mentioned_resources[0].offset).toBe(1)
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(2))
  expect(JSON.stringify(t.model.requests[1])).toContain('请【插件：douyin】搜索视频')
  t.ctx.goals.pause(t.agent, t.ctx.goals.get(t.agent)); await t.agent.whenIdle()
  // Plain objective edits clear offsets tied to the previous text.
  await expect(s.mutateGoal(t.owner, t.chat.id, 'edit', { ref: t.ctx.goals.get(t.agent), request: { objective: '' } })).rejects.toThrow()
  expect(t.db.goalRun(t.agent.id).selection.mentioned_resources[0].offset).toBe(1)
  if (method === 'slash') await s.issueCommand(t.owner, t.chat.id, { command: '/goal edit 请先整理材料', request_key: 'plugin-edit' })
  else await s.mutateGoal(t.owner, t.chat.id, 'edit', { ref: t.ctx.goals.get(t.agent), request: { objective: '请先整理材料' } })
  expect(t.ctx.goals.get(t.agent).objective).toBe('请先整理材料')
  expect(t.db.goalRun(t.agent.id).selection.mentioned_resources[0].offset).toBeUndefined()
  const last = await s.mutateGoal(t.owner, t.chat.id, 'resume', { ref: t.ctx.goals.get(t.agent) })
  expect(last.run.query).toBe('请先整理材料')
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(3))
  const system = t.model.requests[2].messages.filter(message => message.role === 'system')
  expect(system.length).toBeGreaterThan(0)
  expect(JSON.stringify(system)).not.toContain('请【插件：douyin】搜索视频')
  expect(t.db.getRun(t.owner.ownerId, first.run.id).query).toBe('请搜索视频')
  t.ctx.goals.pause(t.agent, t.ctx.goals.get(t.agent)); await t.agent.whenIdle()
})

it('uses newly edited Goal plugin positions only after native acceptance', async () => {
  const t = await fixture(['hang', 'hang']), s = goalServiceFixture(t)
  const tool = { id: 'personal:mcp:law:details', runtime_name: 'law_details', version: 'v1', scope: 'personal',
    server_id: 'law', provider_call_name: 'law', tool_name: 'details', description: '查询', inputSchema: { type: 'object' } }
  s.platformClient = { json: async () => ({ tools: [tool] }) }
  await s.issueCommand(t.owner, t.chat.id, { command: '/goal 原目标', request_key: 'old' })
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(1))
  t.ctx.goals.pause(t.agent, t.ctx.goals.get(t.agent)); await t.agent.whenIdle()
  await s.issueCommand(t.owner, t.chat.id, { command: '/goal edit 先核验再整理', request_key: 'new',
    resource_mentions: { plugins: ['law'] }, mention_positions: [{ kind: 'tools', id: 'law', offset: 1 }] })
  expect(t.ctx.goals.get(t.agent).objective).toBe('先核验再整理')
  const resumed = await s.mutateGoal(t.owner, t.chat.id, 'resume', { ref: t.ctx.goals.get(t.agent) })
  expect(resumed.run.query).toBe('先核验再整理')
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(2))
  expect(JSON.stringify(t.model.requests[1])).toContain('先【插件：law】核验再整理')
  t.ctx.goals.pause(t.agent, t.ctx.goals.get(t.agent)); await t.agent.whenIdle()
})
it('rejected duplicate creation preserves the active goal run binding', async () => {
  const t = await fixture(['hang']); const s = goalServiceFixture(t)
  const first = await s.issueCommand(t.owner,t.chat.id,{command:'/goal first objective',request_key:'first'})
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(1))
  await expect(s.issueCommand(t.owner,t.chat.id,{command:'/goal second objective',request_key:'second'})).rejects.toMatchObject({status:409})
  expect(t.ctx.goals.get(t.agent).objective).toBe('first objective')
  expect(t.db.goalRun(t.agent.id).id).toBe(first.run.id)
  expect(t.db.goalRun(t.agent.id).status).toBe('running')
  t.ctx.goals.pause(t.agent,t.ctx.goals.get(t.agent)); await t.agent.whenIdle()
})
it('slash resume rejection preserves the active goal run binding', async () => {
  const t = await fixture(['hang']); const s = goalServiceFixture(t)
  const first = await s.issueCommand(t.owner,t.chat.id,{command:'/goal first objective',request_key:'first'})
  await vi.waitFor(() => expect(t.model.requests).toHaveLength(1))
  await expect(s.issueCommand(t.owner,t.chat.id,{command:'/goal resume',request_key:'resume'})).rejects.toMatchObject({status:409})
  expect(t.db.goalRun(t.agent.id).id).toBe(first.run.id)
  expect(t.db.goalRun(t.agent.id).status).toBe('running')
  t.ctx.goals.pause(t.agent,t.ctx.goals.get(t.agent)); await t.agent.whenIdle()
})
it('cold control reports disarmed activation', async () => {
  const t = await fixture([]); const run=t.create('goal'); t.db.setGoalRun(t.agent.id,run.id)
  t.ctx.goals.create(t.agent,{objective:'cold objective'})
  t.ctx.goals.disarm(t.agent)
  const s=goalServiceFixture(t); s.agents={get:()=>undefined}
  const state=await s.getControl(t.owner,t.chat.id)
  expect(state.goal.phase).toBe('active'); expect(state.goal.activation).toBe('disarmed')
})

it('fork preserves all goal turn bindings', async () => {
  const t=await fixture([]); const s=goalServiceFixture(t); const run=t.create('multi-round goal')
  t.db.setGoalRun(t.agent.id,run.id); t.db.bindNativeTurn(run,1); t.db.bindNativeTurn(run,2)
  t.db.setRunSourceSeq(t.owner.ownerId,run.id,'source_end_seq',20)
  t.db.transitionRun(t.owner.ownerId,run.id,'completed')
  s.sessions={fork:async()=>({sessionId:'forked-session'}),rename:async()=>({})}
  const child=await s.fork(t.owner,run.id,{request_key:'fork'})
  expect(t.db.runForTurn('forked-session',1)).toBeDefined()
  expect(t.db.runForTurn('forked-session',2)?.id).toBe(child.runs[0].id)
  expect(child.runs).toHaveLength(1)
})
it('native domain rejection retains conflict semantics', async () => {
  const {sendError}=await import('../src/http.js')
  const t=await fixture(['hang']);const s=goalServiceFixture(t)
  await s.issueCommand(t.owner,t.chat.id,{command:'/goal first objective',request_key:'first'})
  await vi.waitFor(()=>expect(t.model.requests).toHaveLength(1))
  let failure;try{await s.mutateGoal(t.owner,t.chat.id,'resume',{ref:t.ctx.goals.get(t.agent)})}catch(e){failure=e}
  expect(failure.code).toBe('GOAL_INVALID_TRANSITION')
  const res={writeHead:vi.fn(),end:vi.fn()};sendError(res,failure)
  expect(res.writeHead.mock.calls[0][0]).toBe(409)
  expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({code:'GOAL_INVALID_TRANSITION'})
  t.ctx.goals.pause(t.agent,t.ctx.goals.get(t.agent));await t.agent.whenIdle()
})
it('editing objective updates selected resource context', async () => {
  const t=await fixture(['hang']); const s=goalServiceFixture(t)
  const first=await s.issueCommand(t.owner,t.chat.id,{command:'/goal first objective',request_key:'first'})
  await vi.waitFor(()=>expect(t.model.requests).toHaveLength(1))
  t.ctx.goals.pause(t.agent,t.ctx.goals.get(t.agent));await t.agent.whenIdle()
  Object.assign(s, await registerUserSkills(t, ['new-skill']))
  await s.issueCommand(t.owner,t.chat.id,{command:'/goal edit revised objective',request_key:'edit',resource_mentions:{skills:['new-skill']}})
  expect(t.model.requests).toHaveLength(1)
  expect(t.agent.inbox.nextTurn).toHaveLength(0)
  expect(t.ctx.goals.get(t.agent).objective).toBe('revised objective')
  expect(t.db.getRun(t.owner.ownerId,first.run.id).selection.resource_mentions.skills).toEqual(['new-skill'])
})
it('rejected replacement leaves original goal continuation intact', async () => {
  let release;const output=new Promise(resolve=>{release=resolve})
  const t=await fixture([output,'hang']); const s=goalServiceFixture(t)
  await s.issueCommand(t.owner,t.chat.id,{command:'/goal original objective',request_key:'original'})
  await vi.waitFor(()=>expect(t.model.requests).toHaveLength(1))
  await expect(s.issueCommand(t.owner,t.chat.id,{command:'/goal other objective',request_key:'other'})).rejects.toMatchObject({status:409})
  release('first round complete')
  await vi.waitFor(()=>expect(t.model.requests).toHaveLength(2))
  t.ctx.goals.pause(t.agent,t.ctx.goals.get(t.agent));await t.agent.whenIdle()
})

it.each([true, false])('waits for native descendants before a goal round, preserving pause=%s', async pause => {
  const t = await fixture(['first round', 'hang'])
  const s = goalServiceFixture(t)
  let finishChildren
  const children = new Promise(resolve => { finishChildren = resolve })
  const waitForChildren = vi.fn(() => t.model.requests.length ? children : Promise.resolve())
  t.ctx.provide('subagents', { waitForChildren })
  await s.issueCommand(t.owner, t.chat.id, { command: '/goal Verify records', request_key: 'descendants' })
  await vi.waitFor(() => expect(waitForChildren.mock.calls.length).toBeGreaterThanOrEqual(2))
  expect(t.model.requests).toHaveLength(1)
  expect(t.ctx.goals.get(t.agent).roundsStarted).toBe(1)
  if (pause) t.ctx.goals.pause(t.agent, t.ctx.goals.get(t.agent))
  finishChildren()
  if (!pause) {
    await vi.waitFor(() => expect(t.model.requests).toHaveLength(2))
    t.ctx.goals.pause(t.agent, t.ctx.goals.get(t.agent))
  }
  await t.agent.whenIdle()
  expect(t.model.requests).toHaveLength(pause ? 1 : 2)
  expect(t.ctx.goals.get(t.agent).phase).toBe('paused')
})

it('cold control uses native projection round counter', async () => {
  const t=await fixture(['hang']);const s=goalServiceFixture(t)
  await s.issueCommand(t.owner,t.chat.id,{command:'/goal count rounds',request_key:'rounds'})
  await vi.waitFor(()=>expect(t.model.requests).toHaveLength(1))
  expect(t.ctx.goals.get(t.agent).roundsStarted).toBe(1)
  const cold=goalServiceFixture(t);cold.agents={get:()=>undefined}; cold.sessionQuery={observeSession:async()=>({projections:t.ctx.sessionProjections.snapshot(t.agent.session,['goal']),events:[]})}
  expect((await cold.getControl(t.owner,t.chat.id)).goal.rounds_started).toBe(1)
  t.ctx.goals.pause(t.agent,t.ctx.goals.get(t.agent));await t.agent.whenIdle()
})

it.each(['approve', 'discuss'])('settles native plan review through the Workbench bridge: %s', async action => {
  const t=await fixture(['Plan ready'])
  const {default:Questions}=await native('dsh-user-questions')
  const {default:Plan}=await native('dsh-plan-mode')
  const {HumanInputBridge}=await import('../src/human-input.js')
  await t.ctx.plugin(Questions);await t.ctx.plugin(Plan,{section:'Prepare a plan for review.'})
  const s=new WorkbenchService({database:t.db,sessionController:t.sessions,agents:t.ctx.agents,scheduler:t.scheduler,commands:t.ctx.commands,workspace:'/workspace',skills:{list:async()=>[]},platformClient:{json:async()=>({tools:[]})},fileManager:{operate:async()=>({})}})
  const response=await s.issueCommand(t.owner,t.chat.id,{command:'/plan Review evidence',request_key:'plan'})
  await vi.waitFor(()=>expect(t.model.requests).toHaveLength(1));await t.agent.whenIdle()
  const bridge=new HumanInputBridge({database:t.db,executionRun:()=>t.db.getRun(t.owner.ownerId,response.run.id),
    resumeInput:(run,signal)=>t.scheduler.resumeInput(run,signal)})
  t.ctx.on('user-questions/request',bridge.handleRequest,{global:true,prepend:true})
  const pending=t.ctx.tools.execute({callId:'review',name:'exit_plan_mode',arguments:{plan:'# Evidence plan\nReview facts.'},agent:t.agent,signal:new AbortController().signal})
  await vi.waitFor(()=>expect(bridge.pendings.size).toBe(1))
  const saved=t.db.getPendingInput(t.owner.ownerId,response.run.id)
  expect(saved.deadlineAt).toBeNull()
  await t.scheduler.flushFences()
  await t.scheduler.tick()
  expect(t.scheduler.hasAdmission(t.agent.id)).toBe(false)
  if (action === 'discuss') bridge.skip(t.owner.ownerId,response.run.id,saved.requestId)
  else bridge.resume(t.owner.ownerId,response.run.id,{ request_id: saved.requestId, answers: [{id:saved.payload.questions[0].id,selected:[saved.payload.questions[0].intent.approve]}] })
  const result=await pending
  if (action === 'discuss') {
    // alpha.5 concludes this turn natively when review is dismissed.
    expect(result.isError).toBe(false)
    expect(result.concludesTurn).toBe(true)
    expect(JSON.stringify(result.content)).toContain('plan mode remains active')
    expect(t.ctx.sessionProjections.snapshot(t.agent.session,['plan']).values.plan.active).toBe(true)
  } else {
    expect(result.isError).not.toBe(true)
    expect(t.ctx.planMode.get(t.agent)).toMatchObject({active:true,pending:false})
  }
})

it('dismisses plan review without another model request and settles the Workbench receipt', async () => {
  const t = await fixture([])
  const [{ default: Questions }, { default: Plan }] = await Promise.all([native('dsh-user-questions'), native('dsh-plan-mode')])
  await t.ctx.plugin(Questions)
  await t.ctx.plugin(Plan, { section: 'Prepare a plan for review.' })
  t.ctx.planMode.set(t.agent, true)
  t.model.stream = async function* (options) {
    this.requests.push(options)
    if (this.requests.length > 1) throw new Error('Dismissal must not call the model again')
    yield { type: 'tool-call-delta', index: 0, id: 'review-plan', name: 'exit_plan_mode', argumentsDelta: JSON.stringify({ plan: '# Review\nCheck evidence' }) }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  const run = t.create('Prepare the plan')
  const bridge = new HumanInputBridge({ database: t.db, executionRun: id => t.runtime.executionRun(id),
    resumeInput: (current, signal) => t.scheduler.resumeInput(current, signal) })
  t.ctx.on('user-questions/request', bridge.handleRequest, { global: true, prepend: true })
  await t.scheduler.enqueue(run, [{ type: 'text', text: run.query }])
  await t.scheduler.tick()
  await vi.waitFor(() => expect(bridge.pendings.size).toBe(1))
  const pending = t.db.getPendingInput(t.owner.ownerId, run.id)
  bridge.skip(t.owner.ownerId, run.id, pending.requestId)
  await t.agent.whenIdle()
  expect(t.model.requests).toHaveLength(1)
  expect(t.ctx.planMode.get(t.agent)).toMatchObject({ active: true })
  expect(t.db.getRun(t.owner.ownerId, run.id)).toMatchObject({ status: 'completed' })
  expect(t.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason).toEqual({ kind: 'completed' })
})

it('directly steers an old answer ahead of queued messages without waiting for another scheduler tick', async () => {
  let release
  const test = await fixture([new Promise(resolve => { release = resolve }), 'updated from reanswer', 'queued reply'])
  const first = test.create('working')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const bridge = new HumanInputBridge({ database: test.db, executionRun: id => test.runtime.executionRun(id),
    resumeInput: (run, signal) => test.scheduler.resumeInput(run, signal) })
  const question = bridge.handleRequest({ agent: test.agent, questions: [{ id: 'old', question: 'old question' }],
    signal: new AbortController().signal }, () => { throw new Error('unexpected fallback') })
  const oldId = test.db.getPendingInput(test.owner.ownerId, first.id).requestId
  bridge.skip(test.owner.ownerId, first.id, oldId)
  await question
  const queued = test.create('ordinary queued message')
  // A pending dispatcher snapshot must not delay an explicit reanswer.
  test.db.saveSubmission(test.owner.ownerId, queued.id, [{ type: 'text', text: queued.query }])
  const tick = vi.spyOn(test.scheduler, 'tick').mockResolvedValue()
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions,
    agents: test.ctx.agents, scheduler: test.scheduler })
  service.humanInput = bridge
  const body = { request_id: oldId, answers: [{ id: 'old', selected: [], custom: 'new evidence' }] }
  const accepted = await service.supplement(test.owner, first.id, body)
  expect(accepted).toMatchObject({ status: 'steered', steer_target_run_id: first.id,
    input_supplement: [{ question: 'old question', answer: 'new evidence' }] })
  expect(test.agent.inbox.nextStep.some(message => message.source?.rpcId === accepted.id)).toBe(true)
  expect(test.agent.inbox.nextTurn).toHaveLength(0)
  expect(test.db.submission(test.owner.ownerId, accepted.id)).toBeUndefined()
  expect(test.scheduler.hasAdmission(test.agent.id)).toBe(true)
  expect(test.db.getRun(test.owner.ownerId, queued.id).status).toBe('queued')
  expect((await service.supplement(test.owner, first.id, body)).id).toBe(accepted.id)
  release('original answer')
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('new evidence')
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.rpcId === accepted.id)).toHaveLength(1)
  tick.mockRestore()
})

it('accepts an old answer while a newer native question has released admission, skipping only the newer question', async () => {
  let release
  const test = await fixture([new Promise(resolve => { release = resolve }), 'updated with old answer'])
  const first = test.create('working')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  const bridge = new HumanInputBridge({ database: test.db, executionRun: id => test.runtime.executionRun(id),
    resumeInput: (run, signal) => test.scheduler.resumeInput(run, signal) })
  const question = text => bridge.handleRequest({ agent: test.agent, questions: [{ id: text, question: text }], signal: new AbortController().signal }, () => { throw new Error('unexpected fallback') })
  const oldAnswer = question('old-question')
  const oldId = test.db.getPendingInput(test.owner.ownerId, first.id).requestId
  bridge.skip(test.owner.ownerId, first.id, oldId)
  await oldAnswer
  const newAnswer = question('new-question')
  await test.scheduler.tick()
  expect(test.scheduler.hasAdmission(test.agent.id)).toBe(false)
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler })
  service.humanInput = bridge
  const invalid = { request_id: oldId, answers: [{ id: 'wrong', selected: [], custom: 'invalid' }] }
  await expect(service.supplement(test.owner, first.id, invalid)).rejects.toMatchObject({ status: 400 })
  expect(test.db.getPendingInput(test.owner.ownerId, first.id).status).toBe('pending')
  const body = { request_id: oldId, answers: [{ id: 'old-question', selected: [], custom: 'new evidence' }] }
  const accepted = await service.supplement(test.owner, first.id, body)
  expect(await newAnswer).toEqual({ answers: [{ id: 'new-question', selected: [] }] })
  expect(test.db.listPendingInputs(test.owner.ownerId, first.id).map(input => input.status)).toEqual(['submitted', 'skipped'])
  const repeated = await service.supplement(test.owner, first.id, body)
  expect(repeated.id).toBe(accepted.id)
  await test.scheduler.tick()
  release('original answer')
  await test.agent.whenIdle()
  expect(test.model.requests).toHaveLength(2)
  expect(JSON.stringify(test.model.requests[1].messages)).toContain('new evidence')
  expect(test.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.rpcId === accepted.id)).toHaveLength(1)
})
