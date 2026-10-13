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

it('continues an owned background-child notice after the parent completed and replays it once', async () => {
  const test = await fixture(['parent done', 'child result incorporated'])
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
  expect(continued).toMatchObject({status:'completed',parentRunId:original.id,selection:{is_continuation:true,native_notice:true},mcpTools:original.mcpTools})
  const query = {observeSession:async () => ({events:test.agent.session.snapshotEvents(),[Symbol.dispose]() {}})}
  await reconcileNativeSessions(test.db,query,test.owner.ownerId)
  expect(test.db.listRuns(test.owner.ownerId,test.chat.id)).toHaveLength(2)
  expect(test.model.requests).toHaveLength(2)
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
  if (scheduledClaims) registerScheduledClaims(ctx, { runtime, database: db, ownerId: owner.ownerId })
  else ctx.on('agent/inbox/claimed', payload => projectInboxClaim(db, payload, owner.ownerId))
  ctx.on('agent/assistant-stream', createAssistantStreamProjector(db, owner.ownerId))
  ctx.on('session/event', (session, event) => projectSessionEvent(db, session.id, event, owner.ownerId,
    { goal: ctx.goals.get(agent), nativeIdle: agent.status === 'idle',
      ...(scheduledClaims ? { mcpCatalogReady: runtime.mcpCatalogState?.ready === true,
        mcpTools: runtime.mcpResources?.() ?? [] } : {}) }))
  ctx.on('agent/status', ({ agent: current, status }) => {
    if (status === 'idle') settleNativeIdle(db, current.id, ctx.goals.get(current))
  })
  ctx.on('agent/pre-step', (payload, next) => scheduler.admitNativeStep(payload, next), { prepend: true })
  const create = query => db.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: agent.id, query, selection: {},
    mcpTools: [{ id: 'personal:server:tool', version: 'v1' }] }).run
  return { ctx, db, agent, owner, chat, model, scheduler, runtime, sessions, controllerCtx, requests, create,
    permit: value => { permitted = value } }
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
  const first = test.create('original'), second = test.create('keep queued'), third = test.create('before edit')
  await test.scheduler.enqueue(first, [{ type: 'text', text: first.query }])
  await test.scheduler.tick()
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(1))
  for (const run of [second, third]) test.db.saveSubmission(test.owner.ownerId, run.id, [{ type: 'text', text: run.query }])
  if (placement === 'native') await test.scheduler.tick()
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents, scheduler: test.scheduler })
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
  expect(JSON.stringify(test.model.requests[1].messages)).not.toContain('keep queued')
  const messages = test.agent.session.snapshotEvents().filter(event => event.type === 'user/message')
  expect(messages.map(event => event.data.source.rpcId)).toEqual([first.id, third.id, second.id])
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
  const service = new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, commands: test.ctx.commands, goals: test.ctx.goals, workspace: '/workspace',
    skills: { list: async () => [{ id: 'personal:evidence', name: 'evidence', enabled: true }] },
    fileManager: { operate: async () => ({}) },
    platformClient: { json: async () => ({ tools: [] }) } })
  const response = await service.issueCommand(test.owner, test.chat.id, { command: '/goal Audit evidence', request_key: 'active-goal',
    resource_mentions: { skills: ['personal:evidence'] } })
  expect(response.run.id).not.toBe(current.id)
  expect(test.db.getRun(test.owner.ownerId, current.id).mcpTools).toEqual(current.mcpTools)
  expect(test.db.getRun(test.owner.ownerId, response.run.id).selection.resource_context).toContain('evidence')
  finishCurrent('Previous request completed')
  await vi.waitFor(() => expect(test.model.requests).toHaveLength(2))
  expect(JSON.stringify(test.model.requests[1])).toContain('用户指定技能')
  expect(JSON.stringify(test.model.requests[1])).toContain('evidence')
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

it('exposes the published DSH projected occupancy immediately after a compacted surface replacement', async () => {
  const test = await fixture([])
  const { default: TokenMeter } = await native('dsh-token-meter')
  const { createMessage } = await native('dsh-llm')
  await test.ctx.plugin(TokenMeter)
  const session = test.agent.session
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
  const before = (await service.getControl(test.owner, test.chat.id)).contextPressure
  const nodes = test.ctx.tokenMeter.measure(session).nodes.filter(node => node.seq >= first && node.seq <= last)
  session.append('compaction/summary', { compactionId: 'compact-test', summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start: first, end: last }, shadowedSeqs: nodes.map(node => node.seq), shadowedTokenCount: nodes.reduce((total, node) => total + node.tokens, 0), provider: 'mock', model: 'mock' })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'test' } }),
    { surfaceOp: { op: 'replace', startSeq: first, endSeq: last }, sourceEventSeqs: [first, last] })
  const after = (await service.getControl(test.owner, test.chat.id)).contextPressure
  expect(after.pressureTokens).toBe(before.pressureTokens)
  expect(after.projectedTokens).toBeLessThan(before.projectedTokens)
  expect(after.contextWindow).toBe(100000)
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
function goalServiceFixture(test) {
  return new WorkbenchService({ database: test.db, sessionController: test.sessions, agents: test.ctx.agents,
    scheduler: test.scheduler, goals: test.ctx.goals, commands: test.ctx.commands, workspace: '/workspace',
    platformClient: { json: async () => ({ data: { tools: [] } }) }, skills: { list: async () => [] }, fileManager: { operate: async () => ({}) } })
}
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
  s.skills={list:async()=>[{name:'new-skill',description:'new evidence'}]}; const content=vi.spyOn(s,'resourceContent')
  await s.issueCommand(t.owner,t.chat.id,{command:'/goal edit revised objective',request_key:'edit',resource_mentions:{skills:['new-skill']}})
  expect(content).toHaveBeenCalled()
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
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('stay in plan mode, stop here, and wait for their message')
    expect(t.ctx.sessionProjections.snapshot(t.agent.session,['plan']).values.plan.active).toBe(true)
  } else {
    expect(result.isError).not.toBe(true)
    expect(t.ctx.planMode.get(t.agent)).toMatchObject({active:true,pending:false})
  }
})
