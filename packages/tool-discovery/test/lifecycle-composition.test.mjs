import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { WorkbenchDatabase } from '../../workbench-adapter/src/persistence.js'
import { TaskScheduler } from '../../workbench-adapter/src/scheduler.js'
import { WorkbenchRuntime } from '../../workbench-adapter/src/runtime.js'
import { WorkbenchService } from '../../workbench-adapter/src/service.js'
import { HumanInputBridge } from '../../workbench-adapter/src/human-input.js'
import { registerScheduledClaims } from '../../workbench-adapter/src/scheduled-claims.js'
import { projectSessionEvent, createAssistantStreamProjector, settleNativeIdle, reconcileNativeSessions } from '../../workbench-adapter/src/projection.js'
import { registerRunResourceContext } from '../../workbench-adapter/src/resource-mentions.js'
import * as mcp from '../../workbench-mcp-tools/src/index.js'
import * as discovery from '../src/index.js'
import { ACTIVE_EVENT, PROJECTION_KEY } from '../src/projection.js'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { buildForkSeed } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Goals from '@deepseek-ai/dsh-goal'
import * as GoalDriver from '@deepseek-ai/dsh-goal-round-driver'
import Commands from '@deepseek-ai/dsh-commands'
import * as GoalCommand from '@deepseek-ai/dsh-command-goal'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user'

// Resolve the native controller's internal entry from this same dependency graph.
const req = createRequire(import.meta.url)
const { SessionCommandController } = await import(pathToFileURL(join(dirname(req.resolve('@deepseek-ai/dsh-api-session-controller')), 'types', 'commands.js')).href)
let serial = 0
const toolCall = (name, args = {}) => ({ name, args })
const search = () => toolCall('tool_search', { query: 'case_lookup' })
class Model extends LlmAdapter {
  requests = []
  constructor(script) { super(); this.script = [...script] }
  async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 100000 } }
  async *stream(options) {
    this.requests.push(structuredClone({ ...options, signal: undefined }))
    const entry = await this.script.shift()
    if (entry === 'hang') {
      await new Promise((resolve, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
      return
    }
    if (entry === undefined) throw new Error('Fixture script exhausted')
    if (entry?.name) {
      const id = `lifecycle-${++serial}`, args = JSON.stringify(entry.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: entry.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: entry.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: entry }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: entry } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
const catalog = ['case_lookup', 'unused_lookup'].map((name, index) => ({
  id: `${index ? 'personal' : 'global'}:mcp:records:${name}`, scope: index ? 'personal' : 'global',
  runtime_name: `${index ? 'personal' : 'global'}_${name}`, server_id: 'records', tool_name: name,
  provider_name: index ? '个人档案' : '全局档案', provider_call_name: index ? 'my_records' : 'records', version: 'v1', manifest_version: 'm1',
  description: name === 'case_lookup' ? '查询案件档案' : 'Unused capability', inputSchema: { type: 'object', properties: {} },
}))
const until = async (predicate, text) => { const deadline = Date.now() + 6000; while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${text}`); await new Promise(resolve => setTimeout(resolve, 10)) } }

async function fixture(script, { delayed = false, complete = false } = {}) {
  const ctx = new Context(), db = new WorkbenchDatabase(':memory:'), owner = { ownerId: 't:1' }, calls = [], admissions = []
  ctx.provide('workingDirectory', { ensure: async agent => agent.session.header.cwd, get: session => session.header.cwd })
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, Tools, Agents, Goals, GoalDriver, Commands, GoalCommand]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new Model(script); ctx.llm.registerAdapter(['mock'], model)
  const agent = await ctx.agentLoop.create(`source-${++serial}`, { provider: 'mock', model: 'mock' }, { cwd: '/workspace/conversations/source-chat' })
  const chat = db.createChat({ id: 'source-chat', ownerId: owner.ownerId, sessionId: agent.id, selection: {} })
  const controllerCtx = Object.create(ctx)
  controllerCtx.attachments = { admitPromptContent: async content => content }
  controllerCtx.fileUploads = { retirePrompt() {}, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) }
  const controller = new SessionCommandController(controllerCtx, { resolveAgent: async id => ({ agent: ctx.agents.get(id) }),
    selectionFor: () => ({ current: { provider: 'mock', model: 'mock' } }) }, process.cwd())
  const sessions = { prompt: (request, signal) => controller.prompt(request, signal), updateQueue: request => controller.updateQueue(request),
    cancel: () => agent.cancel({ kind: 'user' }, { keepInbox: true }),
    modelCatalog: async () => ({ groups: [{ id: 'mock', models: [{ id: 'mock', name: 'Fixture' }] }] }),
    selectModel: async ({ provider, model }) => {
      assert.equal(provider, 'mock'); assert.equal(model, 'mock')
      return { selected: { provider, model } }
    },
  }
  let available = !delayed, currentCatalog = catalog
  const platform = { json: async request => {
    if (request.route === 'workbench/config') return { data: { enabled: true,
      models: { default: 'mock/mock', providers: { mock: { models: [{ id: 'mock', name: 'Fixture' }] } } } } }
    if (request.route === 'mcp/catalog') { if (!available) throw Object.assign(new Error('Unavailable'), { status: 503 }); return { tools: currentCatalog } }
    const body = JSON.parse(request.body ?? '{}')
    if (request.route === 'mcp/call') { calls.push(body); return { data: { result: { content: [{ type: 'text', text: 'Found' }] } } } }
    if (request.route === 'mcp/cancel') return { data: { fenced: true } }
    admissions.push(body); return { data: { state: body.action === 'release' ? 'done' : 'running' } }
  } }
  const scheduler = new TaskScheduler({ database: db, sessions, platformClient: platform, ownerId: owner.ownerId, agents: ctx.agents })
  const runtime = new WorkbenchRuntime(ctx, db, owner.ownerId); runtime.scheduler = scheduler
  scheduler.executionRun = id => runtime.executionRun(id)
  scheduler.hasOwnedWork = (sessionId, runId) => runtime.hasOwnedWork(sessionId, runId)
  ctx.on('agent/created', ({ agent: current }) => runtime.bindChild(current), { global: true, prepend: true })
  registerRunResourceContext(ctx)
  registerScheduledClaims(ctx, { runtime, database: db, ownerId: owner.ownerId })
  ctx.on('agent/assistant-stream', createAssistantStreamProjector(db, owner.ownerId))
  ctx.on('session/event', (session, event) => { const current = ctx.agents.get(session.id); projectSessionEvent(db, session.id, event, owner.ownerId,
    { goal: current && ctx.goals.get(current), nativeIdle: current?.status === 'idle', mcpCatalogReady: runtime.mcpCatalogState?.ready === true, mcpTools: runtime.mcpResources?.() ?? [] }) })
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (status === 'idle') { runtime.settleChild(current); settleNativeIdle(db, current.id, ctx.goals.get(current)) }
  })
  ctx.on('agent/pre-step', (payload, next) => scheduler.admitNativeStep(payload, next), { prepend: true })
  ctx.provide('workbenchPlatformClient', platform)
  await ctx.plugin(mcp, { discovery: true }); await ctx.plugin(discovery)
  if (complete) ctx.systemPrompt.section({ name: 'test:complete', order: 0, complete: true, text: 'Complete fixture prompt.' })
  const service = new WorkbenchService({ database: db, sessionController: sessions, agents: ctx.agents, scheduler,
    goals: ctx.goals, commands: ctx.commands, workspace: '/workspace', workingDirectory: ctx.workingDirectory,
    onGoalChanged: listener => ctx.on('goal/changed', listener, { prepend: true }), platformClient: platform,
    skills: { list: async () => [] }, fileManager: { operate: async () => ({}) } })
  return { ctx, db, owner, agent, chat, model, calls, admissions, scheduler, runtime, service,
    create: (query, target = agent, targetChat = chat, resources = catalog) => db.createRun({ ownerId: owner.ownerId, chatId: targetChat.id, sessionId: target.id, query, selection: {}, mcpTools: resources }).run,
    setCatalog: async value => { currentCatalog = value; available = true; await ctx.parallel('workbench/resources-changed') },
    close: async () => { for (const current of ctx.agents.list()) current.cancel({ kind: 'user' }, { keepInbox: true }); await scheduler.close(); await ctx.fiber.dispose(); db.close() },
  }
}
const names = request => request.tools.map(tool => tool.name)
// These tests compose real native lifecycle services with discovery mode enabled.
test.each([false, true])('scheduled inbox retries catalog and starts each run with fresh discovery (complete=%s)', async complete => {
  const h = await fixture([search(), toolCall('case_lookup'), 'first done', search(), toolCall('case_lookup'), 'second done'], { delayed: true, complete })
  try {
    const first = createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: 'Check scheduled records' }] })
    h.agent.followup(first)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(h.model.requests.length, 0); assert.equal(h.db.getRun(h.owner.ownerId, first.id), undefined)
    await h.setCatalog(catalog); await h.agent.whenIdle(); await h.scheduler.tick()
    const second = createUserMessage({ source: { kind: 'schedule' }, content: [{ type: 'text', text: 'Check next scheduled records' }] })
    h.agent.followup(second); await h.agent.whenIdle()
    assert.equal(h.model.requests.length, 6)
    assert.deepEqual(names(h.model.requests[0]), ['mcp', 'tool_search']); assert.deepEqual(names(h.model.requests[3]), ['mcp', 'tool_search'])
    assert.ok(names(h.model.requests[1]).includes('case_lookup')); assert.ok(!names(h.model.requests[1]).includes('unused_lookup'))
    assert.deepEqual(h.calls.map(call => call.run_id), [first.id, second.id])
    for (const id of [first.id, second.id]) assert.equal(h.db.getRun(h.owner.ownerId, id).status, 'completed')
  } finally { await h.close() }
})

test.each([false, true])('Goal rounds retain activation and resume revalidates it (changed manifest=%s)', async changed => {
  const h = await fixture([search(), toolCall('case_lookup'), 'round one done', toolCall('case_lookup'), 'hang'])
  try {
    const created = await h.service.issueCommand(h.owner, h.chat.id, { command: '/goal Check cases across rounds', request_key: 'goal' })
    await until(() => h.model.requests.length === 5, 'second Goal round')
    assert.ok(names(h.model.requests[3]).includes('case_lookup'))
    assert.deepEqual(h.calls.map(call => call.run_id), [created.run.id, created.run.id])
    await h.service.mutateGoal(h.owner, h.chat.id, 'pause', { ref: h.ctx.goals.get(h.agent) })
    h.agent.cancel({ kind: 'user' }, { keepInbox: true }); await h.agent.whenIdle(); await h.scheduler.tick()
    if (changed) await h.setCatalog(catalog.map(tool => ({ ...tool, manifest_version: 'm2' })))
    h.model.script.push(...(changed ? [toolCall('case_lookup'), 'hang'] : [search(), toolCall('case_lookup'), 'hang']))
    const resumed = await h.service.mutateGoal(h.owner, h.chat.id, 'resume', { ref: h.ctx.goals.get(h.agent) })
    await until(() => h.model.requests.length === (changed ? 7 : 8), 'resumed Goal request')
    assert.notEqual(resumed.run.id, created.run.id)
    assert.deepEqual(names(h.model.requests[5]), ['mcp', 'tool_search'])
    assert.equal(h.calls.length, changed ? 2 : 3)
    if (!changed) assert.equal(h.calls[2].run_id, resumed.run.id)
    await h.service.mutateGoal(h.owner, h.chat.id, 'pause', { ref: h.ctx.goals.get(h.agent) })
    h.agent.cancel({ kind: 'user' }, { keepInbox: true }); await h.agent.whenIdle()
  } finally { await h.close() }
})

test('native compaction and fork preserve history but revalidate new run authority', async () => {
  const h = await fixture([search(), toolCall('case_lookup'), 'done'])
  try {
    const original = h.create('Large history '.repeat(1000))
    await h.scheduler.enqueue(original, [{ type: 'text', text: original.query }]); await h.scheduler.tick(); await h.agent.whenIdle(); await h.scheduler.tick()
    assert.equal(h.calls.length, 1)
    const priorCatalogs = h.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'mcp-catalog')
    assert.equal(priorCatalogs.length, 1)
    const activation = h.agent.session.snapshotEvents().find(event => event.type === ACTIVE_EVENT)
    assert.ok(activation)
    class ProbeCompaction extends BasicCompaction {
      async summarize() { return { summary: [{ type: 'text', text: 'Completed case lookup.' }], provider: 'mock', model: 'mock' } }
    }
    await h.ctx.plugin(TokenMeter); await h.ctx.plugin(ProbeCompaction, { auto: false, retainTokens: 0, headroomTokens: 1000, maxTokens: 1000 })
    const compacted = await h.ctx.compaction.compactNow(h.agent, new AbortController().signal)
    assert.ok(compacted)
    assert.ok(h.agent.session.snapshotEvents().some(event => event.type === 'compaction/summary'))
    assert.equal(h.ctx.sessionProjections.stateOf(h.agent.session, PROJECTION_KEY).tools[0].name, 'case_lookup')
    const events = h.agent.session.snapshotEvents(), boundary = events.at(-1).seq, seed = buildForkSeed(events, boundary)
    const forkId = `fork-${++serial}`
    const handle = await h.ctx.agents.create({ sessionId: forkId, meta: { cwd: process.cwd(), parentSession: h.agent.id, isSeeded: true },
      inheritedEventCount: boundary + 1, seed, agentOptions: { provider: 'mock', model: 'mock' } })
    const fork = handle.agent, chat = h.db.createChat({ id: forkId, ownerId: h.owner.ownerId, sessionId: forkId, selection: {} })
    assert.ok(fork.session.snapshotEvents().some(event => event.type === ACTIVE_EVENT))
    h.model.script.push(toolCall('case_lookup'), 'fork done')
    const forkRun = h.create('Continue fork with changed permissions', fork, chat, [])
    await h.scheduler.enqueue(forkRun, [{ type: 'text', text: forkRun.query }]); await h.scheduler.tick(); await fork.whenIdle()
    assert.deepEqual(names(h.model.requests[3]), ['mcp', 'tool_search'])
    assert.equal(h.calls.length, 1)
    assert.ok(fork.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.isError))
    const forkCatalogs = fork.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'mcp-catalog')
    assert.ok(forkCatalogs.length > priorCatalogs.length)
    assert.match(forkCatalogs.at(-1).data.content[0].text, /当前没有可用插件/)
  } finally { await h.close() }
})

test.each([false, true])('native human answer reacquires admission and keeps same-run discovery (already active=%s)', async alreadyActive => {
  const question = toolCall('ask_user_question', { questions: [{ id: 'record', question: 'Which case should be checked?' }] })
  const h = await fixture(alreadyActive
    ? [search(), toolCall('case_lookup'), question, toolCall('case_lookup'), 'answered']
    : [question, search(), toolCall('case_lookup'), 'answered'])
  try {
    await h.ctx.plugin(UserQuestions); await h.ctx.plugin(AskUser)
    const bridge = new HumanInputBridge({ database: h.db, executionRun: id => h.runtime.executionRun(id),
      resumeInput: (run, signal) => h.scheduler.resumeInput(run, signal) })
    h.ctx.on('user-questions/request', bridge.handleRequest, { global: true, prepend: true })
    h.service.humanInput = bridge
    const run = h.create('Ask for the case, then look it up')
    await h.scheduler.enqueue(run, [{ type: 'text', text: run.query }]); await h.scheduler.tick()
    await until(() => h.db.getPendingInput(h.owner.ownerId, run.id)?.status === 'pending', 'native human question')
    assert.equal(h.db.getRun(h.owner.ownerId, run.id).status, 'waiting_input')
    await h.scheduler.tick()
    assert.equal(h.scheduler.hasAdmission(h.agent.id), false)
    const firstAfterAnswer = h.model.requests.length
    const pending = h.db.getPendingInput(h.owner.ownerId, run.id)
    bridge.resume(h.owner.ownerId, run.id, { request_id: pending.requestId,
      answers: [{ id: 'record', selected: [], custom: 'CASE-2026-15' }] })
    await h.agent.whenIdle()
    assert.equal(h.model.requests.length, alreadyActive ? 5 : 4)
    assert.equal(names(h.model.requests[firstAfterAnswer]).includes('case_lookup'), alreadyActive)
    assert.ok(names(h.model.requests[firstAfterAnswer]).includes('tool_search'))
    assert.ok(JSON.stringify(h.model.requests[firstAfterAnswer].messages).includes('CASE-2026-15'))
    assert.deepEqual(h.calls.map(call => call.run_id), alreadyActive ? [run.id, run.id] : [run.id])
    assert.ok(h.admissions.filter(body => body.action === 'acquire' && body.run_id === run.id).length >= 2)
    assert.equal(h.db.getPendingInput(h.owner.ownerId, run.id).status, 'submitted')
    assert.equal(h.db.getRun(h.owner.ownerId, run.id).status, 'completed')
    assert.equal(h.db.listRuns(h.owner.ownerId, h.chat.id).length, 1)
  } finally { await h.close() }
})

test('tool-jobs notice wakes an idle root with current discovery and one durable receipt', async () => {
  const h = await fixture([search(), toolCall('case_lookup'), 'original done',
    toolCall('tool_search', { query: 'unused_lookup' }), toolCall('unused_lookup'), 'job collected'])
  try {
    const original = h.create('Start background work')
    await h.scheduler.enqueue(original, [{ type: 'text', text: original.query }]); await h.scheduler.tick()
    await h.agent.whenIdle(); await h.scheduler.tick()
    await h.setCatalog([catalog[1]])
    const notice = createUserMessage({ content: [{ type: 'text', text: 'Native background job output is ready' }],
      source: { kind: 'tool-jobs', form: 'notice', summary: 'Background job completed' } })
    h.agent.followup(notice); await h.agent.whenIdle()
    assert.equal(h.model.requests.length, 6)
    assert.deepEqual(names(h.model.requests[3]), ['mcp', 'tool_search'])
    assert.ok(names(h.model.requests[4]).includes('unused_lookup'))
    assert.ok(!names(h.model.requests[4]).includes('case_lookup'))
    assert.deepEqual(h.calls.map(call => [call.run_id, call.resource_id]),
      [[original.id, catalog[0].id], [notice.id, catalog[1].id]])
    const resumed = h.db.getRun(h.owner.ownerId, notice.id)
    assert.equal(resumed.status, 'completed')
    assert.equal(resumed.selection.native_source, 'tool-jobs')
    assert.equal(resumed.selection.native_notice, true)
    assert.deepEqual(resumed.mcpTools.map(tool => tool.id), [catalog[1].id])
    await reconcileNativeSessions(h.db, { observeSession: async () => ({ events: h.agent.session.snapshotEvents() }) }, h.owner.ownerId)
    assert.equal(h.db.listRuns(h.owner.ownerId, h.chat.id).length, 2)
    assert.equal(h.model.requests.length, 6)
    assert.equal(h.calls.length, 2)
  } finally { await h.close() }
})

test('owned child discovery stays scoped and its settled notice reopens only a fresh parent run', async () => {
  let finishParent
  const parentOutput = new Promise(resolve => { finishParent = resolve })
  const h = await fixture([search(), toolCall('case_lookup'), parentOutput,
    toolCall('tool_search', { query: 'unused_lookup' }), toolCall('unused_lookup'), 'child done',
    search(), toolCall('case_lookup'), 'notice incorporated'])
  try {
    const original = h.create('Delegate a case check')
    await h.scheduler.enqueue(original, [{ type: 'text', text: original.query }]); await h.scheduler.tick()
    await until(() => h.model.requests.length === 3, 'parent waiting for child')
    const childId = `owned-child-${++serial}`
    const { agent: child } = await h.ctx.agents.create({ sessionId: childId, parentAgent: h.agent,
      meta: { parentSession: h.agent.id, origin: 'subagent' }, agentOptions: { provider: 'mock', model: 'mock' } })
    assert.equal(h.ctx.agents.isOwnedBy(child.id, h.agent), true)
    child.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the delegated records' }], source: { kind: 'user' } }))
    await child.whenIdle()
    assert.deepEqual(names(h.model.requests[3]), ['mcp', 'tool_search'])
    assert.ok(names(h.model.requests[4]).includes('unused_lookup'))
    assert.ok(!names(h.model.requests[4]).includes('case_lookup'))
    assert.ok(h.ctx.tools.get('case_lookup', h.agent))
    assert.equal(h.ctx.tools.get('unused_lookup', h.agent), undefined)
    assert.deepEqual(h.calls.map(call => call.run_id), [original.id, original.id])
    finishParent('parent done'); await h.agent.whenIdle(); await h.scheduler.tick()
    assert.equal(h.db.getRun(h.owner.ownerId, original.id).status, 'completed')
    await h.setCatalog([catalog[0]])
    const notice = createUserMessage({ content: [{ type: 'text', text: 'The owned child finished its record check' }],
      source: { kind: 'subagent-settled', senderSessionId: child.id, form: 'notice', summary: 'Completed' } })
    h.agent.followup(notice); await h.agent.whenIdle()
    assert.equal(h.model.requests.length, 9)
    assert.deepEqual(names(h.model.requests[6]), ['mcp', 'tool_search'])
    assert.ok(names(h.model.requests[7]).includes('case_lookup'))
    assert.ok(!names(h.model.requests[7]).includes('unused_lookup'))
    assert.deepEqual(h.calls.map(call => call.run_id), [original.id, original.id, notice.id])
    const resumed = h.db.getRun(h.owner.ownerId, notice.id)
    assert.equal(resumed.parentRunId, original.id)
    assert.equal(resumed.status, 'completed')
    assert.equal(resumed.selection.native_source, 'subagent-settled')
    assert.deepEqual(resumed.mcpTools.map(tool => tool.id), [catalog[0].id])
    await reconcileNativeSessions(h.db, { observeSession: async () => ({ events: h.agent.session.snapshotEvents() }) }, h.owner.ownerId)
    assert.equal(h.db.listRuns(h.owner.ownerId, h.chat.id).length, 2)
    assert.equal(h.model.requests.length, 9)
    assert.equal(h.calls.length, 3)
  } finally { finishParent('cleanup'); await h.close() }
})

test('ordinary Continue uses the native resume inbox and revalidates discovery for its new run', async () => {
  const h = await fixture([search(), toolCall('case_lookup'), 'original done',
    toolCall('tool_search', { query: 'unused_lookup' }), toolCall('unused_lookup'), 'continued'])
  try {
    const original = h.create('Read the current case')
    await h.scheduler.enqueue(original, [{ type: 'text', text: original.query }]); await h.scheduler.tick()
    await h.agent.whenIdle(); await h.scheduler.tick()
    await h.setCatalog([catalog[1]])
    h.db.updateChatConfig(h.owner.ownerId, h.chat.id, h.chat.version, { model: 'mock/mock' })
    const body = { silent_resume: true, continue_run_id: original.id, request_key: 'continue-once' }
    const resumed = await h.service.submitRun(h.owner, h.chat.id, body)
    await h.scheduler.tick(); await h.agent.whenIdle()
    assert.equal(h.model.requests.length, 6)
    assert.deepEqual(names(h.model.requests[3]), ['mcp', 'tool_search'])
    assert.ok(names(h.model.requests[4]).includes('unused_lookup'))
    assert.ok(!names(h.model.requests[4]).includes('case_lookup'))
    assert.deepEqual(h.calls.map(call => [call.run_id, call.resource_id]),
      [[original.id, catalog[0].id], [resumed.id, catalog[1].id]])
    const event = h.agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source?.rpcId === resumed.id)
    assert.equal(event.data.source.kind, 'workbench-resume')
    assert.equal(h.db.getRun(h.owner.ownerId, resumed.id).status, 'completed')
    assert.equal(h.db.getRun(h.owner.ownerId, resumed.id).parentRunId, original.id)
    assert.equal((await h.service.submitRun(h.owner, h.chat.id, body)).id, resumed.id)
    await reconcileNativeSessions(h.db, { observeSession: async () => ({ events: h.agent.session.snapshotEvents() }) }, h.owner.ownerId)
    assert.equal(h.db.listRuns(h.owner.ownerId, h.chat.id).length, 2)
    assert.equal(h.model.requests.length, 6)
    assert.equal(h.calls.length, 2)
  } finally { await h.close() }
})
