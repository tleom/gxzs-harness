import { platformToolName, platformToolNames } from '../../workbench-mcp-tools/src/names.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchService, runDto } from '../src/service.js'
import { projectSessionEvent } from '../src/projection.js'
import { publishedModels } from './model-fixture.js'
import { Context } from '@deepseek-ai/cordis'
import SessionReferences from '@deepseek-ai/dsh-session-reference'
import { goalFailureReason } from '../src/run-failure.js'
import { resourceTextHash } from '../src/resource-mentions.js'
import { HumanInputBridge } from '../src/human-input.js'

function referenceResolver(test, candidates) {
  test.service.sessionQuery = { listSessions: vi.fn(async () => candidates),
    observeSession: async () => ({ header: { cwd: test.service.chatDirectory(test.chat.id) } }) }
  test.service.sessionReferences = { config: { candidateLimit: 50 }, listCandidates: vi.fn(async () => candidates) }
}

const opened = []
it('presents history metadata without materializing an unmentioned frozen tool catalog', () => {
  const { service, database, owner, chat } = setup()
  const run = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
    query: 'history', selection: { mentioned_resources: [{ kind: 'skills', id: 'report' }] } }).run
  Object.defineProperty(run, 'mcpTools', { get() { throw new Error('Frozen catalog must stay lazy') } })
  vi.spyOn(database, 'getRun').mockImplementation(() => { throw new Error('Metadata must not hydrate a full receipt') })
  const view = service.inputRunDto(owner, run)
  expect(view).toMatchObject({ id: run.id, query: 'history', mentioned_resources: [{ kind: 'skills', id: 'report' }],
    human_input_history: [], started_at: null, completed_at: null })
})

it('uses database publication order for the global skill catalog', async () => {
  const { service, skills } = setup()
  skills.list.mockResolvedValue([
    { name: 'z-last', provider: 'gxzs-filesystem', description: 'Last' },
    { name: 'a-first', provider: 'gxzs-filesystem', description: 'First' },
  ])
  service.globalSkillOrder = async () => [{ id: 'z-last', order_num: 20 }, { id: 'a-first', order_num: 10 }]
  expect((await service.listSkills()).map(skill => [skill.id, skill.order_num]))
    .toEqual([['a-first', 10], ['z-last', 20]])
})

afterEach(() => opened.splice(0).forEach((database) => database.close()))

function setup() {
  const database = new WorkbenchDatabase(':memory:')
  opened.push(database)
  const owner = { ownerId: 'tenant:user', tenantId: 'tenant', userId: 'user' }
  const chat = database.createChat({ ownerId: owner.ownerId, sessionId: 'session-1', selection: { model: 'p/m' } })
  const sessionController = {
    updateQueue: vi.fn(async () => ({ accepted: true })), prompt: vi.fn(async () => ({ accepted: true })), cancel: vi.fn(() => ({ accepted: true })),
    rename: vi.fn(async ({ title }) => ({ title, seq: 1 })), selectModel: vi.fn(async () => ({ selected: {} })),
    create: vi.fn(async request => ({ sessionId: request.sessionId ?? 'session-new' })), fork: vi.fn(async () => ({ sessionId: 'session-fork' })),
    modelCatalog: vi.fn(async () => ({ groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }] }] })),
  }
  const agent = { id: chat.sessionId, cancel: vi.fn(), whenIdle: vi.fn(async () => {}) }
  const agents = { get: vi.fn(() => agent) }
  const commands = { execute: vi.fn(async () => ({ result: { text: 'ok' }, commandId: 'c1' })) }
  const directories = new Set()
  const fileManager = {
    operate: vi.fn(async ({ operation, path, unique }) => {
      if (operation === 'stat') return { kind: 'directory', version: 'tree-v1' }
      if (operation === 'list') return { entries: [] }
      if (operation === 'mkdir') { const base=path;let suffix=1;while(unique && directories.has(path))path=base+'-'+(++suffix);directories.add(path);return {path} }
      if (operation === 'delete') return { deleted: true }
      throw new Error('unexpected file operation')
    }),
    personalResources: vi.fn(async () => ({ memory: { content: '', version: null }, skills: [], warnings: [] })),
    personalMcp: vi.fn(async () => ({ mcp: [], warnings: [] })),
  }
  const skills = { list: vi.fn(async () => []), get: vi.fn() }
  const platformClient = { json: vi.fn(async () => ({ tools: [] })) }
  const publishedClient = { json: (request) => request.route === 'workbench/config' ? publishedModels()
    : request.route === 'mcp/cancel' ? Promise.resolve({ data: { fenced: true } }) : platformClient.json(request) }
  const service = new WorkbenchService({ database, sessionController, agents, commands, skills, fileManager, platformClient: publishedClient, workspace: '/workspace' })
  service.workingDirectory = { ensure: vi.fn(async () => '/workspace/current') }
  service.onGoalChanged = vi.fn(() => vi.fn())
  service.permanentDeletion = { prepare: vi.fn(async chat => [chat.sessionId]), erase: vi.fn(async () => {}) }
  return { database, owner, chat, service, sessionController, agents, commands, skills, fileManager, platformClient, agent }
}

it.each([true, false])('includes durable positioned tags in %s live goal controls without relying on loaded history', async live => {
  const { service, owner, chat, database, agents } = setup()
  const goal = { id: 'goal', objective: '排版用这个', revision: 1, phase: 'paused' }
  const mentions = [{ kind: 'skills', id: 'official-docx', name: '公文排版', offset: 2 }]
  const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
    query: goal.objective, selection: { command: 'goal', resource_position_hash: resourceTextHash(goal.objective), mentioned_resources: mentions } })
  database.setGoalRun(chat.sessionId, run.id)
  service.goals = { get: () => goal }
  const dispose = vi.fn()
  service.sessionQuery = { observeSession: async () => ({ projections: { values: { goal: { goal } } }, events: [], [Symbol.dispose]: dispose }) }
  if (!live) agents.get.mockReturnValue(undefined)
  expect((await service.getControl(owner, chat.id)).goal.mentioned_resources).toEqual(mentions)
  goal.objective = '新的目标内容'
  expect((await service.getControl(owner, chat.id)).goal.mentioned_resources)
    .toEqual([{ kind: 'skills', id: 'official-docx', name: '公文排版' }])
  expect(database.goalRun(chat.sessionId).selection.mentioned_resources).toEqual(mentions)
  expect(dispose).toHaveBeenCalledTimes(2)
})

it('keeps a legacy context snapshot small on follow-up polls while retaining the durable reading', () => {
  const { database, owner, chat, service } = setup()
  const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
  database.appendEvent(owner.ownerId, run.id, { event: 'workbench_context', phase: 'usage', used_tokens: 1200,
    window_tokens: 128000, model: 'p/m', estimated: false, mcpTools: [{ schema: 'x'.repeat(513420) }], mcpCatalogReady: true })
  const response = service.followups(owner, chat.id, [run.id])
  expect(response.runs[0].context_usage).toMatchObject({ used_tokens: 1200, model: 'p/m' })
  expect('mcpTools' in response.runs[0].context_usage).toBe(false)
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(2048)
  expect(database.latestContextEvent(owner.ownerId, run.id).mcpTools).toHaveLength(1)
})

it('joins concurrent empty Session preparation and never silently accepts a minted identity', async () => {
  const t = setup()
  t.agents.get.mockReturnValue(undefined)
  let release
  t.sessionController.create.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const first = t.service.ensureChatSession(t.owner, t.chat)
  const second = t.service.ensureChatSession(t.owner, t.chat)
  await vi.waitFor(() => expect(t.sessionController.create).toHaveBeenCalledOnce())
  release({ sessionId: t.chat.sessionId })
  expect(await first).toEqual(t.chat)
  expect(await second).toEqual(t.chat)
  expect(t.service.sessionPreparations.size).toBe(0)
  t.sessionController.create.mockResolvedValueOnce({ sessionId: 'unexpected-new-session' })
  await expect(t.service.ensureChatSession(t.owner, t.chat)).rejects.toMatchObject({ status: 409 })
  expect(t.service.sessionPreparations.size).toBe(0)
  expect(t.database.getChat(t.owner.ownerId, t.chat.id).sessionId).toBe(t.chat.sessionId)
  await expect(t.service.ensureChatSession(t.owner, t.chat)).resolves.toEqual(t.chat)
})

it('joins a pending native resume when listing scoped skills for a persisted cold session', async () => {
  const { service, owner, chat, agents, agent, sessionController, skills } = setup()
  const header = { id: chat.sessionId, cwd: service.chatDirectory(chat.id) }
  const dispose = vi.fn()
  service.sessionQuery = { observeSession: vi.fn(async () => ({ header, [Symbol.dispose]: dispose })) }
  agents.get.mockReturnValue(undefined)
  agent.session = { header }
  const resumed = Promise.withResolvers()
  sessionController.resolveAgent = vi.fn(() => resumed.promise)
  const nativeReader = sessionController.resolveAgent(chat.sessionId)
  const catalog = service.catalogSkills(owner, chat.id)
  await vi.waitFor(() => expect(sessionController.resolveAgent).toHaveBeenCalledTimes(2))
  expect(skills.list).not.toHaveBeenCalled()
  agents.get.mockReturnValue(agent)
  resumed.resolve({ agent })
  await expect(Promise.all([nativeReader, catalog])).resolves.toEqual([{ agent }, []])
  expect(sessionController.create).not.toHaveBeenCalled()
  expect(skills.list).toHaveBeenCalledWith({ cwd: '/workspace/current', scope: agent })
  expect(dispose).toHaveBeenCalledOnce()
})

it('preserves a real native writer conflict instead of recreating a persisted session', async () => {
  const { service, owner, chat, agents, sessionController, skills } = setup()
  service.sessionQuery = { observeSession: async () => ({ header: { cwd: service.chatDirectory(chat.id) } }) }
  agents.get.mockReturnValue(undefined)
  const error = Object.assign(new Error('writer held'), { code: 'session/writer-held' })
  sessionController.resolveAgent = vi.fn(async () => ({ error }))
  await expect(service.catalogSkills(owner, chat.id)).rejects.toBe(error)
  expect(sessionController.create).not.toHaveBeenCalled()
  expect(skills.list).not.toHaveBeenCalled()
})

it.each(['observed', 'resolved'])('rejects a mismatching %s cwd while restoring a cold session', async stage => {
  const { service, owner, chat, agents, sessionController, skills } = setup()
  const cwd = service.chatDirectory(chat.id)
  service.sessionQuery = { observeSession: async () => ({ header: { cwd: stage === 'observed' ? '/other' : cwd } }) }
  agents.get.mockReturnValue(undefined)
  sessionController.resolveAgent = vi.fn(async () => ({ agent: { session: { header: { cwd: '/other' } } } }))
  await expect(service.catalogSkills(owner, chat.id)).rejects.toMatchObject({ status: 409 })
  expect(sessionController.resolveAgent).toHaveBeenCalledTimes(stage === 'observed' ? 0 : 1)
  expect(sessionController.create).not.toHaveBeenCalled()
  expect(skills.list).not.toHaveBeenCalled()
})

it('keeps steering metadata complete across history pages and frozen at the upper cursor', () => {
  const { database, owner, chat, service } = setup()
  const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
  for (let index = 0; index < 256; index++) database.appendEvent(owner.ownerId, run.id,
    { event: 'workbench_activity', data: { stage: 'returned', tool_name: 'read', output: 'ok' } })
  database.appendEvent(owner.ownerId, run.id,
    { event: 'workbench_steering', steering_id: 'first-steer', query: '补充说明', attachments: [], created_at: 123 })
  database.appendEvent(owner.ownerId, run.id, { event: 'workbench_steered', steer_target_run_id: 'target-run' })
  const first = service.getRun(owner, run.id, true, { after: '0-0' })
  expect(first.events).toHaveLength(256)
  expect(first.events_next_cursor).toBe('256-0')
  expect(first.steering_messages).toEqual([{ id: 'first-steer', query: '补充说明', attachments: [], created_at: 123 }])
  expect(first.steer_target_run_id).toBe('target-run')
  database.appendEvent(owner.ownerId, run.id,
    { event: 'workbench_steering', steering_id: 'later-steer', query: '快照之后', attachments: [], created_at: 456 })
  const last = service.getRun(owner, run.id, true, { after: first.events_next_cursor, through: first.events_through_cursor })
  expect(last.steering_messages).toEqual(first.steering_messages)
  expect(last.steer_target_run_id).toBe(first.steer_target_run_id)
  expect(last.events.map(event => event._id)).toEqual(['257-0', '258-0'])
  expect(service.getRun(owner, run.id).steering_messages).toHaveLength(2)
})

it.each(['queue', 'steer'])('carries native %s submission through the admitted immutable receipt', async mode => {
  const test = setup()
  const body = { query: '更新材料', request_key: 'native-mode', mode }
  const accepted = await test.service.submitRun(test.owner, test.chat.id, body)
  expect(test.sessionController.prompt).toHaveBeenCalledOnce()
  expect(test.sessionController.prompt.mock.calls[0][0]).toMatchObject({ requestId: accepted.id, sessionId: test.chat.sessionId, mode })
  expect(test.database.getRun(test.owner.ownerId, accepted.id).selection.prompt_mode).toBe(mode)
  const replay = await test.service.submitRun(test.owner, test.chat.id, { ...body, mode: mode === 'steer' ? 'queue' : 'steer' })
  expect(replay.id).toBe(accepted.id)
  expect(test.sessionController.prompt).toHaveBeenCalledOnce()
  expect(test.platformClient.json).toHaveBeenCalledOnce()
})

it.each(['insert', null, {}])('rejects an invalid native prompt mode before admission: %s', async mode => {
  const test = setup()
  await expect(test.service.submitRun(test.owner, test.chat.id, { query: '消息', mode })).rejects.toMatchObject({ status: 400 })
  expect(test.database.listRuns(test.owner.ownerId, test.chat.id)).toEqual([])
  expect(test.sessionController.prompt).not.toHaveBeenCalled()
  expect(test.platformClient.json).not.toHaveBeenCalled()
})

function activateNative(test, runId, queued = []) {
  const { agent, database, chat, owner, service } = test
  database.bindRunMessage(chat.sessionId, runId, 1, `message-${runId}`)
  database.transitionRun(owner.ownerId, runId, 'running')
  agent.status = 'running'
  agent.session = { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] }
  agent.ctx = { sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0, lastTurn: 1 }) } }
  agent.inbox = { nextTurn: queued, nextStep: [], remove: vi.fn(id => {
    const index = agent.inbox.nextTurn.findIndex(message => message.id === id)
    if (index < 0) return false
    agent.inbox.nextTurn.splice(index, 1)
    return true
  }) }
  agent.steer = vi.fn(message => agent.inbox.nextStep.push(message))
  service.scheduler = { ...service.scheduler, hasAdmission: () => true }
}

it('returns state-only receipts and pages full large history without an oversized legacy response', async () => {
  const { service, owner, chat, database } = setup()
  const run = await service.submitRun(owner, chat.id, { query: 'large history' })
  const large = 'x'.repeat(1024 * 1024)
  for (let i = 0; i < 32; i++) database.appendEvent(owner.ownerId, run.id, { event: 'workbench_activity', data: { kind: 'text', text: large } })
  expect(database.allEvents(owner.ownerId, run.id).length).toBeGreaterThanOrEqual(32)
  const getAll = vi.spyOn(database, 'allEvents')
  const state = service.getChat(owner, chat.id)
  expect(getAll).not.toHaveBeenCalled()
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(32768)
  expect(state.runs[0]).toMatchObject({ id: run.id, query: 'large history', events: [], history_complete: false })
  expect(service.getRun(owner, run.id)).toMatchObject({ events: [], history_complete: false })
  expect(() => service.getRun(owner, run.id, true)).toThrow(expect.objectContaining({ status: 413, code: 'HISTORY_PAGE_REQUIRED' }))
  let after = '0-0', through, total = 0, textEvents = 0
  do {
    const page = service.getRun(owner, run.id, true, { after, through })
    const bytes = Buffer.byteLength(JSON.stringify(page))
    expect(bytes).toBeLessThan(4 * 1024 * 1024 + 32768)
    total += bytes
    textEvents += page.events.filter(event => event.data?.text === large).length
    through ??= page.events_through_cursor
    after = page.events_next_cursor
  } while (after)
  expect(total).toBeGreaterThan(30 * 1024 * 1024)
  expect(textEvents).toBe(32)
})

it('shows one badge per MCP provider while preserving its complete tool scope and distinct same-name providers', async () => {
  const { service } = setup()
  const tools = Array.from({ length: 50 }, (_, i) => ({ id: `global:mcp:redbook:tool-${i}`, provider: 'global:mcp:redbook', scope: 'global', server_id: 'redbook', provider_name: '小红书' }))
  tools.push({ id: 'personal:mcp:redbook:tool-0', provider: 'personal:mcp:redbook', scope: 'personal', server_id: 'redbook', provider_call_name: 'my-redbook', provider_name: '小红书' })
  const mentions = { tools: tools.map(tool => tool.id), skills: [], knowledge: [] }
  const snapshot = await service.mentionSnapshot(mentions, tools)
  expect(snapshot).toEqual([{ id: 'redbook', kind: 'tools', name: '小红书' }, { id: 'my-redbook', kind: 'tools', name: '小红书' }])
  expect(mentions.tools).toHaveLength(51)
  const historical = tools.map(tool => ({ id: tool.id, kind: 'tools', name: '小红书' }))
  const run = { id: 'run', chatId: 'chat', query: '查热榜', createdAt: 1000, status: 'completed', seq: 1,
    selection: { resource_mentions: mentions, mentioned_resources: historical }, mcpTools: tools }
  expect(runDto(run).mentioned_resources).toEqual([historical[0], historical[50]])
  expect(runDto(run).resource_mentions.tools).toHaveLength(51)
})

it('persists inline plugin positions and canonical names while keeping the displayed query unchanged', async () => {
  const { service, owner, chat } = setup()
  const tools = [{ id: 'global:mcp:law:lookup', provider: 'global:mcp:law', server_id: 'law', scope: 'global', provider_name: '法律检索' }]
  service.freezeMcpCatalog = vi.fn(async () => ({ tools, servers: [] }))
  const run = await service.submitRun(owner, chat.id, { query: '之前 后文', resource_mentions: { plugins: ['global:mcp:law'] },
    mention_positions: [{ kind: 'tools', id: 'plugin:mcp:global:mcp:law', offset: 3 }] })
  expect(run.query).toBe('之前 后文')
  expect(service.getRun(owner, run.id).mentioned_resources).toEqual([{ kind: 'tools', id: 'law', name: '法律检索', offset: 3 }])
})

it('uses an observed child target while sharing native ranking and platform archive visibility', async () => {
  const test=setup(), {service,owner,chat}=test
  const observed={header:{id:'child',parentSession:chat.sessionId,cwd:'/workspace/child'}}
  const records=[{header:{id:chat.sessionId}},{header:observed.header}]
  service.sessionQuery={listSessions:async()=>records}
  service.sessionReferences={config:{candidateLimit:50},listSessionCandidates:vi.fn(async()=>[
    {sessionId:chat.sessionId,label:'父任务'},{sessionId:'foreign',label:'不属于用户'},
  ])}
  service.fileReferences={listObserved:vi.fn(async()=>[{path:'证据.md',kind:'file'}])}
  const signal=new AbortController().signal
  const candidates=await service.observedReferenceCandidates(owner,observed,'证据',signal)
  expect(candidates.map(item=>item.path??item.sessionId)).toEqual(['证据.md',chat.sessionId])
  expect(service.fileReferences.listObserved).toHaveBeenCalledWith(observed,'证据',signal)
  expect(service.sessionReferences.listSessionCandidates).toHaveBeenCalledWith(observed.header,'证据',2,signal)
  expect(test.sessionController.create).not.toHaveBeenCalled()
  const files=service.fileReferences
  service.fileReferences=undefined
  expect((await service.observedReferenceCandidates(owner,observed,'',signal)).map(item=>item.sessionId)).toEqual([chat.sessionId])
  service.fileReferences={list:vi.fn()}
  await expect(service.observedReferenceCandidates(owner,observed,'',signal)).rejects.toMatchObject({status:503})
  expect(service.fileReferences.list).not.toHaveBeenCalled()
  service.fileReferences=files
  service.workspaces={baseline:async()=>({archivedSessionIds:[chat.sessionId]})}
  expect(await service.observedReferenceCandidates(owner,observed,'',signal)).toHaveLength(1)
})

describe('followup and control service', () => {
  it('fences a completed background parent captured before native archive stops its child', async () => {
    const { database, owner, chat, service } = setup()
    const run = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'background', selection: {}, mcpTools: [{ id: 'tool', version: 'v1' }] }).run
    database.transitionRun(owner.ownerId, run.id, 'running')
    database.transitionRun(owner.ownerId, run.id, 'completed')
    let background = true
    service.hasOwnedWork = (session, id) => session === chat.sessionId && id === run.id && background
    service.workspaces = { baseline: async () => ({ items: [] }), controller: { archiveSession: vi.fn(async () => { background = false }) } }
    service.platformClient = { json: vi.fn(async () => ({ fenced: true })) }
    await service.deleteChat(owner, chat.id)
    expect(service.platformClient.json).toHaveBeenCalledWith(expect.objectContaining({ route: 'mcp/cancel', body: expect.any(Buffer) }))
    expect(JSON.parse(service.platformClient.json.mock.calls[0][0].body).run_id).toBe(run.id)
    expect(database.pendingRunFences(owner.ownerId)).toEqual([])
  })
  it('fences the parent MCP run when a native child notice is stopped', async () => {
    const test=setup(),{database,owner,chat,service}=test
    const parent=database.createRun({ownerId:owner.ownerId,chatId:chat.id,sessionId:chat.sessionId,query:'parent',selection:{}}).run
    database.transitionRun(owner.ownerId,parent.id,'running')
    database.transitionRun(owner.ownerId,parent.id,'completed')
    const notice=database.createRun({ownerId:owner.ownerId,chatId:chat.id,sessionId:chat.sessionId,query:'notice',parentRunId:parent.id,selection:{native_notice:true,is_continuation:true}}).run
    activateNative(test,notice.id)
    service.cancelOwned=vi.fn()
    service.platformClient={json:vi.fn(async()=>({data:{fenced:true}}))}
    await service.stopRun(owner,notice.id)
    expect(service.platformClient.json.mock.calls.map(([request])=>JSON.parse(request.body).run_id)).toEqual([notice.id,parent.id])
    expect(database.getRun(owner.ownerId,parent.id).stopConfirmation?.fenced).toBe(true)
    expect(service.cancelOwned).toHaveBeenCalledWith(chat.sessionId,notice.id)
  })
  it('uses the persisted native error code in full history, state snapshots and goal reasons', () => {
    const { service, database, owner, chat } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'evidence', selection: {} })
    database.bindRunMessage(chat.sessionId, run.id, 1, 'native-message')
    database.setGoalRun(chat.sessionId, run.id)
    const nativeError = { code: 'data_inspection_failed', message: 'Input text data may contain inappropriate content.' }
    const live = projectSessionEvent(database, chat.sessionId, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error', error: nativeError } } })
    expect(service.getRun(owner, run.id).error).toBe(live.error)
    expect(service.getRun(owner, run.id, false).error).toBe(live.error)
    expect(service.inputRunDto(owner, database.listRuns(owner.ownerId, chat.id)[0]).error).toBe(live.error)
    expect(goalFailureReason({ phase: 'active', activation: 'disarmed' }, database.goalRun(chat.sessionId))).toBe(live.error)
    expect(database.getRun(owner.ownerId, run.id).error).toBe(nativeError.message)
    expect(database.runErrorCode('foreign-owner', run.id)).toBeUndefined()
  })
  it('opens history with steering at its native position before follow connects', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'first', selection: {} })
    database.bindRunMessage(chat.sessionId, run.id, 1, 'm')
    database.transitionRun(owner.ownerId, run.id, 'completed')
    database.setRunSourceSeq(owner.ownerId, run.id, 'source_end_seq', 5)
    service.sessionQuery = { observeSession: async () => ({ events: [{ seq: 5 }], [Symbol.dispose]() {} }) }
    sessionController.page = async () => ({ hasMore: false, records: [
      { event: { seq: 1, type: 'turn/start', data: { turn: 1 } } },
      { event: { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'before' }] } } } },
      { event: { seq: 3, type: 'user/message', data: { source: { rpcId: 'extra' }, content: [{ type: 'text', text: 'supplement' }] } } },
      { event: { seq: 4, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'after' }] } } } },
    ] })
    const page = await service.historyPage(owner, chat.id, undefined, new AbortController().signal, true)
    expect(page.runs).toHaveLength(1)
    expect(page.runs[0].native_history).toBe(true)
    expect(page.runs[0].events[2]).toMatchObject({ event: 'workbench_steering', steering_id: 'extra', query: 'supplement' })
    expect(page.runs[0].events[1].data.text).toBe('before')
    expect(page.runs[0].events[4].data.text).toBe('after')
  })
  it('keeps the complete SSE snapshot when a task finishes after the native opening cut', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const { run } = database.createRun({ownerId:owner.ownerId,chatId:chat.id,sessionId:chat.sessionId,query:'运行中',selection:{}})
    database.bindRunMessage(chat.sessionId,run.id,1,'m1')
    database.transitionRun(owner.ownerId,run.id,'running')
    service.sessionQuery={observeSession:vi.fn(async()=>({events:[{seq:50}],[Symbol.dispose](){}}))}
    sessionController.page=vi.fn(async request=>{
      if(request.maxMessages===1)return {records:[{event:{seq:39,type:'assistant/message'}}],hasMore:false}
      database.appendEvent(owner.ownerId,run.id,{event:'workbench_activity',data:{kind:'text',segment_id:'t1s1b0',text:'刚刚完成的输出'}})
      database.setRunSourceSeq(owner.ownerId,run.id,'source_end_seq',51)
      database.transitionRun(owner.ownerId,run.id,'completed')
      return {records:[{type:'event',event:{seq:40,type:'turn/start',data:{turn:1}}}],hasMore:true}
    })
    const page=await service.historyPage(owner,chat.id,undefined,new AbortController().signal)
    expect(page.through_seq).toBe(50)
    expect(page.runs[0]).toMatchObject({status:'completed',history_complete:true,events_cursor:'1-0'})
    expect(page.runs[0].events[0].data.text).toBe('刚刚完成的输出')
  })
  it('projects only the native page without replaying writes or losing named tools across goal rounds', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: '分析', selection: {}, mcpTools: [{runtime_name:'mcp__search',server_id:'法律资料',tool_name:'检索资料'}] })
    database.bindRunMessage(chat.sessionId, run.id, 1, 'message-1')
    database.bindNativeTurn(run, 2)
    const records = [
      {seq:40,type:'tool/call',data:{turn:1,callId:'call-1',name:'mcp__search',arguments:'{}'}},
      {seq:41,type:'tool/result',data:{turn:1,message:{source:{callId:'call-1'},content:[{type:'tool-result',content:[{type:'text',text:'找到了资料'}]}]}}},
      {seq:42,type:'assistant/message',data:{turn:2,step:1,message:{content:[{type:'text',text:'下一轮结果'}]}}},
      {seq:43,type:'workspace/changes',data:{turn:2}},
      {seq:44,type:'deliverables/presented',data:{turn:2,files:[{path:'报告.md'}]}},
    ].map(event=>({type:'event',event}))
    sessionController.page=vi.fn(async()=>({records,hasMore:true}))
    const allEvents=vi.spyOn(database,'allEvents'), append=vi.spyOn(database,'appendEvent')
    const page=await service.historyPage(owner,chat.id,{sessionId:chat.sessionId,throughSeq:99,beforeSeq:50},new AbortController().signal)
    expect(page.runs).toHaveLength(1)
    expect(page.runs[0].events[0].data).toMatchObject({provider_name:'法律资料',display_name:'检索资料'})
    expect(page.runs[0].events[1].data).toMatchObject({tool_name:'mcp__search',output:'找到了资料'})
    expect(page.runs[0].events.map(event=>event.event)).toEqual(['workbench_activity','workbench_activity','workbench_assistant_final','workbench_activity','workbench_changes','workbench_presented'])
    expect(new Set(page.runs[0].events.map(event=>event._id)).size).toBe(6)
    expect(page.cursor.beforeSeq).toBe(40)
    expect(allEvents).not.toHaveBeenCalled();expect(append).not.toHaveBeenCalled()
  })
  it('opens active native history and refreshes state without reading the complete run while retaining context usage', async () => {
    const {service,owner,chat,database,sessionController}=setup()
    const {run}=database.createRun({ownerId:owner.ownerId,chatId:chat.id,sessionId:chat.sessionId,query:'live',selection:{}})
    database.bindRunMessage(chat.sessionId,run.id,1,'m')
    database.transitionRun(owner.ownerId,run.id,'running')
    database.appendEvent(owner.ownerId,run.id,{event:'workbench_activity',data:{kind:'text',text:'old long transcript'}})
    database.appendEvent(owner.ownerId,run.id,{event:'workbench_context',used_tokens:42,model:'fixture'})
    service.sessionQuery={observeSession:async()=>({events:[{seq:30}],[Symbol.dispose](){}})}
    sessionController.page=vi.fn(async()=>({hasMore:true,records:[{type:'event',event:{seq:20,type:'assistant/message',data:{turn:1,step:2,message:{content:[{type:'text',text:'native window'}]}}}}]}))
    const all=vi.spyOn(database,'allEvents')
    const page=await service.historyPage(owner,chat.id,undefined,new AbortController().signal,true)
    expect(page.runs[0].events.at(-1).data.text).toBe('native window')
    expect(page.runs[0].history_complete).not.toBe(true)
    expect(page.runs[0].context_usage).toMatchObject({used_tokens:42})
    expect(service.getRun(owner,run.id,false)).toMatchObject({events:[],history_complete:false,context_usage:{used_tokens:42}})
    expect(all).not.toHaveBeenCalled()
  })
  it('follows the native bounded snapshot and stream without reading full business transcripts', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const {run}=database.createRun({ownerId:owner.ownerId,chatId:chat.id,sessionId:chat.sessionId,query:'live',selection:{}})
    database.bindRunMessage(chat.sessionId,run.id,1,'message-1')
    const disposed=vi.fn(), allEvents=vi.spyOn(database,'allEvents')
    sessionController.page=vi.fn(async()=>({records:[{event:{seq:89,type:'assistant/message'}}],hasMore:false}))
    sessionController.follow=vi.fn(async function* (request,signal) {
      expect(request).toEqual({address:{kind:'session',sessionId:chat.sessionId},maxMessages:500,
        turnWindow:{minMessages:50,minTurns:2},assistantStream:true})
      expect(signal).toBeInstanceOf(AbortSignal)
      try {
        yield {type:'snapshot',header:{cwd:'/private/host'},projections:{private:'settings'},cursor:90,hasMore:true,
          records:[{type:'event',event:{seq:90,type:'assistant/message',data:{turn:1}}}],
          assistantStream:{revision:2,activeAttempt:{attemptId:'active',turn:1,step:2,startedAfterSeq:90,nextIndex:0,stream:[]}}}
        yield {type:'assistant-stream',frame:{type:'chunk',revision:3}}
      } finally { disposed() }
    })
    const source=service.followHistory(owner,chat.id,new AbortController().signal)
    const snapshot=(await source.next()).value
    expect(snapshot).toMatchObject({event:'workbench_history',session_id:chat.sessionId,
      bindings:[{turn:1,run_id:run.id}],runs:[{id:run.id,events:[]}],value:{type:'snapshot',cursor:90,hasMore:true}})
    expect(snapshot.value).not.toHaveProperty('header')
    expect(snapshot.value).not.toHaveProperty('projections')
    expect((await source.next()).value.value).toEqual({type:'assistant-stream'})
    await source.return()
    expect(disposed).toHaveBeenCalledOnce()
    expect(allEvents).not.toHaveBeenCalled()
    await expect(service.followHistory({...owner,ownerId:'foreign'},chat.id,new AbortController().signal).next()).rejects.toMatchObject({status:404})
    expect(sessionController.follow).toHaveBeenCalledOnce()
  })
  it.each(['plan/mode', 'command/run', 'command/done', 'compaction/end', 'request/context', 'assistant/message', 'assistant/attempt'])('pushes native controls with %s instead of waiting for polling', async type => {
    const {service,owner,chat,sessionController}=setup()
    const control={revision:4,plan:{active:true,pending:false}}
    vi.spyOn(service,'getControl').mockResolvedValue(control)
    sessionController.follow=vi.fn(async function*(){yield {type:'event',event:{seq:1,type,data:{active:true}}}})
    const source=service.followHistory(owner,chat.id,new AbortController().signal)
    expect((await source.next()).value.control).toEqual(control)
    await source.return()
  })
  it('retains plugin result labels when the native call is outside the loaded history window without replaying tool state', async () => {
    const {service,owner,chat,database,sessionController}=setup()
    const {run}=database.createRun({ownerId:owner.ownerId,chatId:chat.id,sessionId:chat.sessionId,query:'search',selection:{},
      mcpTools:[{runtime_name:'mcp__search',server_id:'legal',provider_name:'法律资料',tool_name:'检索资料'}]})
    database.bindRunMessage(chat.sessionId,run.id,1,'m')
    database.startToolCall(owner.ownerId,run.id,'split-call','mcp__search')
    const records=[{type:'event',event:{seq:40,type:'tool/result',data:{turn:1,message:{source:{callId:'split-call'},content:[{type:'tool-result',content:[{type:'text',text:'检索结果'}]}]}}}}]
    sessionController.page=vi.fn(async()=>({records,hasMore:true}))
    sessionController.follow=vi.fn(async function*(){yield {type:'snapshot',cursor:50,records,hasMore:true,assistantStream:{revision:0}}})
    const finish=vi.spyOn(database,'finishToolCall'),append=vi.spyOn(database,'appendEvent'),all=vi.spyOn(database,'allEvents')
    const page=await service.historyPage(owner,chat.id,{sessionId:chat.sessionId,throughSeq:50,beforeSeq:45},new AbortController().signal)
    expect(page.runs[0].events[0].data).toMatchObject({tool_name:'mcp__search',provider_name:'法律资料',display_name:'检索资料',output:'检索结果'})
    const source=service.followHistory(owner,chat.id,new AbortController().signal)
    expect((await source.next()).value.display.events[0].event.data).toMatchObject({provider_name:'法律资料',display_name:'检索资料'})
    await source.return()
    expect(finish).not.toHaveBeenCalled();expect(append).not.toHaveBeenCalled();expect(all).not.toHaveBeenCalled()
    expect(()=>database.toolCallName('foreign',run.id,'split-call')).toThrow('任务不存在')
  })
  it('authorizes history before reading native sessions and rejects old workspace cursors', async () => {
    const { service, owner, chat, sessionController } = setup()
    const dispose = vi.fn()
    service.sessionQuery = { observeSession: vi.fn(async () => ({ events: [{ seq: 9 }], [Symbol.dispose]: dispose })) }
    sessionController.page = vi.fn(async () => ({ records: [], hasMore: false }))
    const signal = new AbortController().signal
    await expect(service.historyPage({ ...owner, ownerId: 'another-owner' }, chat.id, undefined, signal)).rejects.toThrow('会话不存在')
    expect(service.sessionQuery.observeSession).not.toHaveBeenCalled()
    await expect(service.historyPage(owner, chat.id, { sessionId: 'previous-directory-session', throughSeq: 9, beforeSeq: 5 }, signal)).rejects.toThrow('游标无效')
    expect(sessionController.page).not.toHaveBeenCalled()
    expect(await service.historyPage(owner, chat.id, undefined, signal)).toMatchObject({ records: [], cursor: null, runs: [] })
    expect(sessionController.page.mock.calls[0][0].address.sessionId).toBe(chat.sessionId)
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('projects native plan-review intent separately from ordinary questions', () => {
    const { service, database, owner, chat } = setup()
    vi.spyOn(database, 'activeRun').mockReturnValue({ id: 'waiting', status: 'waiting_input' })
    const input = vi.spyOn(database, 'getPendingInput').mockReturnValue({ status: 'pending', payload: { questions: [{ intent: { kind: 'plan-review' } }] } })
    expect(service.chatSummary(owner, chat)).toMatchObject({ needs_input: true, pending_interaction: 'plan-review', has_error: false })
    input.mockReturnValue({ status: 'pending', payload: { questions: [{ question: '请选择材料' }] } })
    expect(service.chatSummary(owner, chat).pending_interaction).toBe('question')
  })
  it('lists native file references before conversation references and passes the same cancellation signal', async () => {
    const test = setup()
    const { service, owner, chat, agent } = test
    const signal = new AbortController().signal
    service.fileReferences = { list: vi.fn(async () => [{ path: '证据 原件.pdf', kind: 'file' }, { path: '材料', kind: 'directory' }]) }
    referenceResolver(test, [{ sessionId: chat.sessionId, label: '当前对话' }])
    const candidates = await service.referenceCandidates(owner, chat.id, '证据', signal)
    expect(candidates.map(item => item.group ?? 'sessions')).toEqual(['files', 'files', 'sessions'])
    expect(candidates[0]).toMatchObject({ path: '证据 原件.pdf', kind: 'file' })
    expect(service.fileReferences.list).toHaveBeenCalledWith(agent, '证据', signal)
    expect(service.sessionReferences.listCandidates).toHaveBeenCalledWith(agent, '证据', 1, signal)
  })
  it('uses native reference candidates and keeps only owner conversations without host paths', async () => {
    const test = setup()
    const { service, owner, chat, database, agent } = test
    const source = database.createChat({ ownerId: owner.ownerId, sessionId: 'source', selection: {} })
    referenceResolver(test, [
      { sessionId: 'source', label: '案件', cwd: '/workspace/private' },
      { sessionId: 'foreign', label: 'other' },
    ])
    expect(await service.referenceCandidates(owner, chat.id, '案件')).toEqual([
      { sessionId: 'source', chatId: source.id, label: '案件', mention: '@[案件](dsh-session:InNvdXJjZSI)' },
    ])
    expect(service.sessionReferences.listCandidates).toHaveBeenCalledWith(agent, '案件', 2, expect.any(AbortSignal))
    await expect(service.referenceCandidates({ ownerId: 'other' }, chat.id)).rejects.toMatchObject({ status: 404 })
  })
  it('excludes archived native sessions from reference candidates and restores them after unarchiving', async () => {
    const test = setup()
    const { service, owner, chat, database } = test
    const source = database.createChat({ ownerId: owner.ownerId, sessionId: 'source', selection: {} })
    let archivedSessionIds = ['source']
    service.workspaces = { baseline: vi.fn(async () => ({ archivedSessionIds })) }
    service.fileReferences = { list: vi.fn(async () => [{ path: '证据.pdf', kind: 'file' }]) }
    referenceResolver(test, [{ sessionId: 'source', label: '案件' }])
    const signal = new AbortController().signal
    expect(await service.referenceCandidates(owner, chat.id, '', signal)).toEqual([
      { path: '证据.pdf', kind: 'file', group: 'files', label: '证据.pdf' },
    ])
    expect(service.workspaces.baseline).toHaveBeenCalledWith(owner, signal, { includeSchedules: false })
    archivedSessionIds = []
    expect((await service.referenceCandidates(owner, chat.id)).at(-1)).toMatchObject({ chatId: source.id })
  })
  it('hides descendants from picker searches while resolving existing references and excluding archived ancestry', async () => {
    const test = setup()
    const { service, owner, chat } = test
    referenceResolver(test, [{ sessionId: 'child', label: '子任务', cwd: '/workspace/private' }, { sessionId: 'grandchild', label: '孙任务' }, { sessionId: 'foreign-child', label: '外部' }])
    service.sessionQuery.listSessions.mockResolvedValue([
      { header: { id: chat.sessionId } }, { header: { id: 'child', parentSession: chat.sessionId } },
      { header: { id: 'grandchild', parentSession: 'child' } }, { header: { id: 'foreign-child', parentSession: 'foreign' } },
    ])
    expect(await service.referenceCandidates(owner, chat.id)).toEqual([])
    expect(await service.referenceCandidates(owner, chat.id, '子任务')).toEqual([])
    const uri = id => `dsh-session:${Buffer.from(JSON.stringify(id)).toString('base64url')}`
    const child = await service.referenceCandidates(owner, chat.id, uri('child'))
    expect(child).toHaveLength(1)
    expect(child[0]).toMatchObject({ chatId: chat.id, origin: 'subagent', parentSessionId: chat.sessionId })
    expect(child[0]).not.toHaveProperty('cwd')
    expect(await service.referenceCandidates(owner, chat.id, uri('grandchild')))
      .toMatchObject([{ chatId: chat.id, origin: 'subagent', parentSessionId: 'child' }])
    service.workspaces = { baseline: vi.fn(async () => ({ archivedSessionIds: [chat.sessionId] })) }
    expect(await service.referenceCandidates(owner, chat.id)).toEqual([])
    expect(await service.referenceCandidates(owner, chat.id, uri('child'))).toEqual([])
  })
  it('hides native blank sessions in the picker without treating untitled conversations as blank', async () => {
    const test = setup()
    const { service, owner, chat, database } = test
    for (const sessionId of ['empty', 'session-untitled']) database.createChat({ ownerId: owner.ownerId, sessionId, selection: {} })
    const sessions = [{ sessionId: 'empty', blank: true }, { sessionId: 'session-untitled', blank: false }]
    service.workspaces = { baseline: vi.fn(async () => ({ sessions })) }
    service.fileReferences = { list: vi.fn(async () => [{ path: '材料.pdf', kind: 'file' }]) }
    referenceResolver(test, [{ sessionId: 'empty', label: '已命名的空会话' }, { sessionId: 'session-untitled', label: 'session-untitled' }])
    expect((await service.referenceCandidates(owner, chat.id)).map(item => item.sessionId ?? item.path))
      .toEqual(['材料.pdf', 'session-untitled'])
    expect((await service.referenceCandidates(owner, chat.id, 'empty')).some(item => item.sessionId === 'empty')).toBe(false)
    const uri = `dsh-session:${Buffer.from(JSON.stringify('empty')).toString('base64url')}`
    expect(await service.referenceCandidates(owner, chat.id, uri)).toMatchObject([{ sessionId: 'empty' }])
    sessions[0].blank = false
    expect((await service.referenceCandidates(owner, chat.id)).filter(item => item.sessionId)).toHaveLength(2)
  })
  it('applies native candidate limits after archive, ownership and subagent filtering, resolving renamed mentions by native URI', async () => {
    const { service, owner, chat, database, agent } = setup()
    const records = [], archivedSessionIds = [], sessions = []
    const cwd = service.chatDirectory(chat.id)
    for (let index = 0; index < 55; index++) {
      const sessionId = `archived-${index}`
      database.createChat({ ownerId: owner.ownerId, sessionId, selection: {} })
      archivedSessionIds.push(sessionId)
      records.push({ header: { id: sessionId, cwd, createdAt: index } })
    }
    for (let index = 0; index < 55; index++) {
      const sessionId = `blank-${index}`
      database.createChat({ ownerId: owner.ownerId, sessionId, selection: {} })
      sessions.push({ sessionId, blank: true })
      records.push({ header: { id: sessionId, cwd, createdAt: index } })
    }
    for (let index = 0; index < 55; index++) {
      const sessionId = `visible-${index}`
      database.createChat({ ownerId: owner.ownerId, sessionId, selection: {} })
      records.push({ header: { id: sessionId, cwd, createdAt: 55 + index }, projections: { sessionTitle: { title: '新标题' } } })
    }
    for (let index = 0; index < 55; index++)
      records.push({ header: { id: `child-${index}`, parentSession: chat.sessionId, cwd, createdAt: 110 + index } })
    const ctx = new Context()
    try {
      ctx.provide('sessionQuery', { listSessions: vi.fn(async () => records) })
      service.sessionQuery = ctx.sessionQuery
      agent.session = { header: { cwd } }
      service.sessionReferences = new SessionReferences(ctx)
      service.workspaces = { baseline: async () => ({ archivedSessionIds, sessions }) }
      const candidates = await service.referenceCandidates(owner, chat.id)
      expect(candidates).toHaveLength(50)
      expect(candidates.every(item => item.sessionId.startsWith('visible-'))).toBe(true)
      const uri = candidates[0].mention.match(/\]\(([^)]+)\)$/)[1]
      expect(await service.referenceCandidates(owner, chat.id, uri)).toEqual([candidates[0]])
      archivedSessionIds.push(candidates[0].sessionId)
      expect(await service.referenceCandidates(owner, chat.id, uri)).toEqual([])
      await expect(service.referenceCandidates(owner, chat.id, 'dsh-session:invalid')).rejects.toMatchObject({ status: 400 })
    } finally { await ctx.fiber.dispose() }
  })
  it('creates a native workspace session and persists its directory without deleting workspace files', async () => {
    const { service, owner, database, sessionController, fileManager } = setup()
    service.workspaces = { baseline: async () => ({ items: [{ workspaceId: 'ws-cases', path: 'cases' }] }), requireWorkspace: vi.fn(async () => ({ workspaceId: 'ws-cases', path: 'cases' })) }
    const chat = await service.createChat(owner, '/workspace', {}, 'ws-cases')
    expect(service.workspaces.requireWorkspace).toHaveBeenCalledWith(owner, 'ws-cases', true)
    expect(sessionController.create).toHaveBeenCalledWith({ workspaceId: 'ws-cases' })
    expect(database.getChat(owner.ownerId, chat.id).directory).toBe('conversations/cases')
    expect(service.chatDirectory(chat.id, chat.directory)).toBe('/workspace/conversations/cases')
    expect(fileManager.operate).not.toHaveBeenCalled()
    await service.deleteChat(owner, chat.id)
    expect(database.getChat(owner.ownerId, chat.id)).toBeUndefined()
    expect(fileManager.operate).not.toHaveBeenCalled()
  })
  it('rejects unavailable or invalid workspace selection before session creation', async () => {
    const { service, owner, sessionController, fileManager } = setup()
    await expect(service.createChat(owner, '/workspace', {}, 'missing')).rejects.toMatchObject({ status: 503 })
    service.workspaces = { requireWorkspace: vi.fn(async () => { throw Object.assign(new Error('missing'), { status: 404 }) }) }
    await expect(service.createChat(owner, '/workspace', {}, 'missing')).rejects.toMatchObject({ status: 404 })
    expect(sessionController.create).not.toHaveBeenCalled()
    expect(fileManager.operate).not.toHaveBeenCalled()
  })
  it.each(['.', 'cases'])('validates an existing workspace directory without mutating it (%s)', async path => {
    const { service, owner, fileManager } = setup()
    service.workspaces = { requireWorkspace: vi.fn(async () => ({ workspaceId: 'ws', path })) }
    const chat = await service.createChat(owner, '/workspace', {}, 'ws')
    fileManager.operate.mockImplementation(async ({ operation }) => {
      if (operation !== 'list') throw new Error('The workspace root can only be listed')
      return { entries: [] }
    })
    await service.ensureChatSession(owner, chat)
    expect(fileManager.operate).toHaveBeenCalledExactlyOnceWith({ operation: 'list', path: path === '.' ? 'conversations' : 'conversations/cases' })
  })
  it('sends resume from the backend and persists the hidden continuation marker', async () => {
    const { database, owner, chat, service, sessionController, agent } = setup()
    agent.followup = vi.fn()
    const first = await service.submitRun(owner, chat.id, { query: 'task', request_key: 'task' })
    database.transitionRun(owner.ownerId, first.id, 'cancelled')
    const resumed = await service.submitRun(owner, chat.id, { query: '', silent_resume: true, continue_run_id: first.id, request_key: 'resume' })
    expect(resumed).toMatchObject({ query: 'resume', parent_run_id: first.id, is_continuation: true })
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
    expect(agent.followup).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'resume' }], source: { kind: 'workbench-resume', rpcId: resumed.id },
    }))
    expect(service.getChat(owner, chat.id).runs.at(-1).is_continuation).toBe(true)
  })

  it('rejects background Continue without the original task instead of creating a Resume chat', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    await expect(service.submitRun(owner, chat.id, { silent_resume: true, query: 'resume' })).rejects.toMatchObject({ status: 400 })
    expect(database.listRuns(owner.ownerId, chat.id)).toEqual([])
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })

  it('keeps attachment admission on the ordinary prompt path', async () => {
    const { owner, chat, service } = setup()
    await expect(service.submitRun(owner, chat.id, { silent_resume: true, continue_run_id: 'old', files: [{ path: 'file' }] })).rejects.toMatchObject({ status: 400 })
  })

  it('keeps new explicit skill invocations on a human message instead of background Continue', async () => {
    const { owner, chat, service, database, sessionController } = setup()
    await expect(service.submitRun(owner, chat.id, { silent_resume: true, continue_run_id: 'old',
      resource_mentions: { skills: ['manual'] } })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('新增技能引用') })
    expect(database.listRuns(owner.ownerId, chat.id)).toEqual([])
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })

  it('only stops the owning Goal between native rounds', async () => {
    const test = setup()
    const { database, owner, chat, service, sessionController, agent } = test
    const { run: goalRun } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'goal', selection: {} })
    database.setGoalRun(chat.sessionId, goalRun.id)
    activateNative(test, goalRun.id)
    agent.status = 'idle'
    agent.session.snapshotEvents = () => [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1 } }]
    agent.ctx.sessionProjections.stateOf = () => ({ openTurnStartSeq: null, lastTurn: 1 })
    service.goals = { get: () => ({ id: 'goal', revision: 1, phase: 'active', activation: 'armed' }), pause: vi.fn() }
    const { run: stale } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'stale', selection: {} })
    await expect(service.stopRun(owner, stale.id)).rejects.toMatchObject({ status: 409, code: 'STALE_RUN' })
    expect(service.goals.pause).not.toHaveBeenCalled()
    expect(sessionController.cancel).not.toHaveBeenCalled()
    await service.stopRun(owner, goalRun.id)
    expect(service.goals.pause).toHaveBeenCalledOnce()
    expect(sessionController.cancel).toHaveBeenCalledOnce()
  })

  it('rejects a stale stop while another completed root run still owns background work', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const first = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'old', selection: {} }).run
    const second = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'new', selection: {} }).run
    service.executionRun = () => ({ ...second, status: 'running', background: true })
    service.cancelOwned = vi.fn()
    await expect(service.stopRun(owner, first.id)).rejects.toMatchObject({ status: 409, code: 'STALE_RUN' })
    expect(sessionController.cancel).not.toHaveBeenCalled()
    expect(service.cancelOwned).not.toHaveBeenCalled()
  })

  it.each(['queued', 'completed'])('rejects a delayed stop for a %s run while a different run is active', async (status) => {
    const test = setup()
    const { database, owner, chat, service, sessionController, agent } = test
    const { run: target } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'target', selection: {} })
    if (status === 'completed') database.transitionRun(owner.ownerId, target.id, 'completed')
    const { run: active } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'active', selection: {} })
    activateNative(test, active.id, [{ id: 'queued-target', source: { kind: 'user', rpcId: target.id } }])
    service.platformClient = { json: vi.fn() }
    await expect(service.stopRun(owner, target.id)).rejects.toMatchObject({ status: 409, code: 'STALE_RUN' })
    expect(sessionController.cancel).not.toHaveBeenCalled()
    expect(service.platformClient.json).not.toHaveBeenCalled()
    expect(agent.inbox.remove).not.toHaveBeenCalled()
    expect(database.getRun(owner.ownerId, active.id).status).toBe('running')
    expect(database.getRun(owner.ownerId, target.id).status).toBe(status)
  })

  it('reads plan mode from the native projection rather than the Workbench cache', async () => {
    const { service, owner, chat, database } = setup()
    database.updateControlBySession(chat.sessionId, { plan: { active: false, pending: false, objective: 'obsolete' } })
    const dispose = vi.fn()
    service.sessionQuery = { observeSession: vi.fn(async () => ({
      projections: { values: { plan: { active: true, pending: true } } }, [Symbol.dispose]: dispose,
    })) }
    expect((await service.getControl(owner, chat.id)).plan).toEqual({ active: true, pending: true })
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('reads current context pressure from the native surface after compaction and on reload', async () => {
    const { service, owner, chat } = setup()
    let projectedTokens = 90000
    service.sessionQuery = { observeSession: async () => ({ projections: { values: {
      contextPressure: { pressureTokens: 90000, projectedTokens, contextWindow: 100000 },
    } }, events: [] }) }
    expect((await service.getControl(owner, chat.id)).contextPressure.projectedTokens).toBe(90000)
    projectedTokens = 12000
    expect((await service.getControl(owner, chat.id)).contextPressure).toEqual({ pressureTokens: 90000, projectedTokens: 12000, contextWindow: 100000 })
    const restored = new WorkbenchService({ database: service.database, sessionQuery: service.sessionQuery, agents: { get: () => undefined } })
    expect((await restored.getControl(owner, chat.id)).contextPressure.projectedTokens).toBe(12000)
  })
  it('pushes context pressure when a compaction checkpoint replaces the native surface', async () => {
    const { service, owner, chat, sessionController } = setup()
    vi.spyOn(service, 'getControl').mockResolvedValue({ revision: 1, contextPressure: { projectedTokens: 12000, contextWindow: 100000 } })
    sessionController.follow = vi.fn(async function* () {
      yield { type: 'event', event: { seq: 1, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, data: { source: { kind: 'compact-checkpoint' } } } }
    })
    const source = service.followHistory(owner, chat.id, new AbortController().signal)
    expect((await source.next()).value.control.contextPressure.projectedTokens).toBe(12000)
    await source.return()
  })
  it('exposes native context composition on refresh, replacement and cold read without estimating it again', async () => {
    const { service, owner, chat } = setup()
    const dispose = vi.fn()
    let contextBreakdown = { systemTokens: 1700, toolsTokens: 9900, messageTokens: 3400 }
    service.sessionQuery = { observeSession: async () => ({ projections: { values: { contextBreakdown } }, events: [], [Symbol.dispose]: dispose }) }
    expect((await service.getControl(owner, chat.id)).contextBreakdown).toEqual(contextBreakdown)
    contextBreakdown = { ...contextBreakdown, messageTokens: 200 }
    const restored = new WorkbenchService({ database: service.database, sessionQuery: service.sessionQuery, agents: { get: () => undefined } })
    expect((await restored.getControl(owner, chat.id)).contextBreakdown).toEqual(contextBreakdown)
    contextBreakdown = undefined
    expect((await restored.getControl(owner, chat.id)).contextBreakdown).toBeNull()
    expect(dispose).toHaveBeenCalledTimes(3)
  })
  it('persists capacity-waiting tasks without sending them to DSH and allows cancellation', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    service.scheduler = { enqueue: (run, content) => database.saveSubmission(owner.ownerId, run.id, content) }
    const run = await service.submitRun(owner, chat.id, { query: 'wait for capacity' })
    expect(database.submission(owner.ownerId, run.id).dispatched).toBe(false)
    expect(sessionController.prompt).not.toHaveBeenCalled()
    expect(service.chatSummary(owner, chat)).toMatchObject({ has_active_run: true, is_running: true })
    expect(await service.stopRun(owner, run.id)).toMatchObject({ status: 'cancelled' })
    expect(sessionController.cancel).not.toHaveBeenCalled()
  })

  it('direct-sends a locally queued message into the running turn only on explicit steering', async () => {
    const test = setup()
    const { service, owner, chat, database, sessionController, agent } = test
    sessionController.prompt.mockImplementation(async (_request, signal) => signal.throwIfAborted())
    const active = await service.submitRun(owner, chat.id, { query: 'active' })
    database.transitionRun(owner.ownerId, active.id, 'running')
    sessionController.prompt.mockClear()
    service.scheduler = { enqueue: (run, content) => database.saveSubmission(owner.ownerId, run.id, content) }
    const next = await service.submitRun(owner, chat.id, { query: 'supplement' })
    activateNative(test, active.id)
    expect(sessionController.prompt).not.toHaveBeenCalled()
    expect(await service.steer(owner, next.id, active.id)).toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(sessionController.prompt).toHaveBeenCalledWith({ sessionId: chat.sessionId, requestId: next.id, content: [{ type: 'text', text: 'supplement' }], mode: 'steer' }, expect.any(AbortSignal))
    expect(database.submission(owner.ownerId, next.id)).toBeUndefined()
    expect(await service.steer(owner, next.id, active.id)).toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(sessionController.prompt).toHaveBeenCalledOnce()
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('queues normal messages in order and steers only on an explicit request', async () => {
    const test = setup()
    const { service, owner, chat, database, sessionController, agent } = test
    const active = await service.submitRun(owner, chat.id, { query: 'active', request_key: 'active' })
    database.transitionRun(owner.ownerId, active.id, 'running')
    const first = await service.submitRun(owner, chat.id, { query: 'first', request_key: 'first' })
    const second = await service.submitRun(owner, chat.id, { query: 'second', request_key: 'second', parent_run_id: active.id })
    expect(first).toMatchObject({ status: 'queued', parent_run_id: active.id })
    expect(second).toMatchObject({ status: 'queued', parent_run_id: first.id })
    expect(sessionController.prompt.mock.calls.every(([request]) => request.mode === 'queue')).toBe(true)
    expect(sessionController.updateQueue).not.toHaveBeenCalled()
    database.adoptInboxMessage(chat.sessionId, first.id, 'message-first')
    activateNative(test, active.id, [{ id: 'message-first', content: [{ type: 'text', text: 'first' }], source: { kind: 'user', rpcId: first.id } }])
    const direct = await service.steer(owner, first.id, active.id)
    expect(direct).toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(sessionController.updateQueue).toHaveBeenCalledWith({ sessionId: chat.sessionId, itemId: 'message-first', action: { kind: 'steer' } })
    expect(database.getRun(owner.ownerId, second.id).parentRunId).toBe(active.id)
    expect(service.getChat(owner, chat.id).runs.find((run) => run.id === active.id).steering_messages).toMatchObject([{ id: first.id, query: 'first', created_at: first.created_at }])
    expect(service.followups(owner, chat.id, [first.id]).runs.find((run) => run.id === first.id).steer_target_run_id).toBe(active.id)
    await expect(service.steer(owner, first.id, active.id)).resolves.toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(sessionController.updateQueue).toHaveBeenCalledTimes(1)
  })

  it('accepts further queued messages and repairs the chain after deletion', async () => {
    const { service, owner, chat, database } = setup()
    const active = await service.submitRun(owner, chat.id, { query: 'active' })
    database.transitionRun(owner.ownerId, active.id, 'running')
    const first = await service.submitRun(owner, chat.id, { query: 'first' })
    const second = await service.submitRun(owner, chat.id, { query: 'second' })
    await service.submitRun(owner, chat.id, { query: 'third' })
    await expect(service.submitRun(owner, chat.id, { query: 'fourth' })).resolves.toMatchObject({ status: 'queued' })
    database.adoptInboxMessage(chat.sessionId, first.id, 'message-first')
    await service.removeQueued(owner, first.id)
    expect(database.getRun(owner.ownerId, second.id).parentRunId).toBe(active.id)
    await expect(service.submitRun(owner, chat.id, { query: 'replacement' })).resolves.toMatchObject({ status: 'queued' })
  })

  it('keeps the starting task separate from native queued follow-ups', async () => {
    const { service, owner, chat, sessionController } = setup()
    const first = await service.submitRun(owner, chat.id, { query: 'starting' })
    for (const query of ['one', 'two', 'three']) await service.submitRun(owner, chat.id, { query })
    await expect(service.submitRun(owner, chat.id, { query: 'four' })).resolves.toMatchObject({ status: 'queued' })
    await expect(service.steer(owner, first.id, first.id)).rejects.toMatchObject({ status: 409 })
    expect(sessionController.updateQueue).not.toHaveBeenCalled()
  })
  it('creates each sandbox conversation directory before creating its DSH session', async () => {
    const { service, owner, fileManager, sessionController } = setup()
    sessionController.create.mockResolvedValueOnce({ sessionId: 'first' }).mockResolvedValueOnce({ sessionId: 'second' })
    const first = await service.createChat(owner, '/workspace', {})
    const second = await service.createChat(owner, '/workspace', {})
    expect(first.id).not.toBe(second.id)
    for (const chat of [first, second]) {
      expect(chat.directory).toMatch(/^conversations\/\d{4}-\d{2}-\d{2}\/new-chat(?:-\d+)?$/)
      expect(fileManager.operate).toHaveBeenCalledWith({ operation: 'mkdir', path: first.directory, unique: true })
      expect(sessionController.create).toHaveBeenCalledWith({ cwd: `/workspace/${chat.directory}` })
    }
    expect(second.directory).toBe(first.directory+'-2')
    expect(fileManager.operate.mock.invocationCallOrder[0]).toBeLessThan(sessionController.create.mock.invocationCallOrder[0])
  })

  it('groups default task directories by the Shanghai calendar date at midnight', async () => {
    const { service, owner, sessionController } = setup()
    sessionController.create.mockImplementation(async ({ cwd }) => ({ sessionId: cwd }))
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-11T15:59:59Z'))
      expect((await service.createChat(owner, '/workspace', {})).directory).toMatch(/^conversations\/2026-10-11\//)
      vi.setSystemTime(new Date('2026-10-11T16:00:00Z'))
      expect((await service.createChat(owner, '/workspace', {})).directory).toMatch(/^conversations\/2026-10-12\//)
    } finally { vi.useRealTimers() }
  })

  it('rejects a mismatched session directory without migrating history', async () => {
    const { service, owner, chat, agents, database, sessionController } = setup()
    agents.get.mockReturnValue({ session: { header: { cwd: '/workspace' } } })
    await expect(service.submitRun(owner, chat.id, { query: 'continue' })).rejects.toMatchObject({ status: 409 })
    expect(database.getChat(owner.ownerId, chat.id).sessionId).toBe(chat.sessionId)
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })

  it('does not switch a running legacy conversation to another session', async () => {
    const { service, owner, chat, agents, database, sessionController } = setup()
    agents.get.mockReturnValue({ session: { header: { cwd: '/workspace' } } })
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'active', selection: {} })
    database.transitionRun(owner.ownerId, run.id, 'running')
    await expect(service.submitRun(owner, chat.id, { query: 'next' })).rejects.toMatchObject({ status: 409 })
    expect(database.getChat(owner.ownerId, chat.id).sessionId).toBe(chat.sessionId)
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })
  it('persists a skipped-question supplement and deduplicates retries after a failed dispatch', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: { model: 'p/m', tools: [] } })
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'question', payload: { request_id: 'question', tool_name: 'ask_user_question', questions: [{ id: 'q', question: 'Question' }] }, deadlineAt: null })
    database.settlePendingInput(owner.ownerId, run.id, 'question', 'skipped')
    database.transitionRun(owner.ownerId, run.id, 'completed')
    const body = { request_id: 'question', answers: [{ id: 'q', selected: [], custom: 'answer' }] }
    sessionController.prompt.mockRejectedValueOnce(new Error('temporary dispatch failure'))
    await expect(service.supplement(owner, run.id, body)).rejects.toThrow('temporary dispatch failure')
    const accepted = await service.supplement(owner, run.id, body)
    const repeated = await service.supplement(owner, run.id, body)
    expect(repeated.id).toBe(accepted.id)
    await expect(service.supplement(owner, run.id, { ...body,
      answers: [{ id: 'q', selected: [], custom: 'different answer' }],
    })).rejects.toMatchObject({ status: 409 })
    expect(accepted.input_supplement).toEqual([{ question: 'Question', answer: 'answer' }])
    expect(sessionController.prompt).toHaveBeenCalledTimes(2)
    expect(sessionController.prompt.mock.calls[0][0].requestId).toBe(sessionController.prompt.mock.calls[1][0].requestId)
    expect(service.getRun(owner, run.id).human_input_history).toMatchObject([
      { request_id: 'question', status: 'submitted', answers: [{ id: 'q', selected: [], custom: 'answer' }], supplement_run_id: accepted.id },
    ])
    await expect(service.supplement(owner, run.id, { ...body, request_id: 'missing' })).rejects.toMatchObject({ status: 404 })
    await expect(service.supplement(owner, run.id, { ...body, request_id: undefined })).rejects.toMatchObject({ status: 404 })
    await expect(service.supplement(owner, run.id, { ...body, request_id: null })).rejects.toMatchObject({ status: 404 })
  })
  it('preserves all answered question labels in live, reloaded and legacy supplement history', async () => {
    const { database, owner, chat, service } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: '任务', selection: {} })
    const questions = [{ id: 'format', question: '文件格式', options: [{ label: 'Word' }] },
      { id: 'focus', question: '报告重点', multiSelect: true, options: [{ label: '证据' }, { label: '时间线' }] },
      { id: 'empty', question: '未补答' }]
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'late', payload: { tool_name: 'ask_user_question', questions }, deadlineAt: null })
    database.settlePendingInput(owner.ownerId, run.id, 'late', 'timeout')
    const accepted = await service.supplement(owner, run.id, { request_id: 'late', answers: [
      { id: 'format', selected: ['Word'] }, { id: 'focus', selected: ['证据', '时间线'], custom: '简洁' }, { id: 'empty', selected: [] },
    ] })
    const expected = [{ question: '文件格式', answer: 'Word' }, { question: '报告重点', answer: '证据；时间线；简洁' }]
    expect(accepted.input_supplement).toEqual(expected)
    database.appendEvent(owner.ownerId, run.id, { event: 'workbench_steering', steering_id: accepted.id, query: accepted.query })
    expect(service.getRun(owner, run.id).steering_messages[0].input_supplement).toEqual(expected)
    const saved = database.getRun(owner.ownerId, accepted.id)
    const { input_supplement, ...selection } = saved.selection
    database.updateRunResources(saved, selection, [])
    expect(service.getRun(owner, accepted.id).input_supplement).toEqual(expected)
    expect(service.getRun(owner, run.id).steering_messages[0].input_supplement).toEqual(expected)
  })

  it('deduplicates reordered supplements both after failed dispatch and after acceptance', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    const questions = [{ id: 'a', question: 'A', multiSelect: true, options: [{ label: 'one' }, { label: 'two' }] }, { id: 'b', question: 'B' }]
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'order', payload: { tool_name: 'ask_user_question', questions } })
    database.settlePendingInput(owner.ownerId, run.id, 'order', 'skipped')
    database.transitionRun(owner.ownerId, run.id, 'completed')
    const answers = [{ id: 'a', selected: ['two', 'one'] }, { id: 'b', selected: [], custom: 'text' }]
    sessionController.prompt.mockRejectedValueOnce(new Error('dispatch unavailable'))
    await expect(service.supplement(owner, run.id, { request_id: 'order', answers })).rejects.toThrow('dispatch unavailable')
    const reversed = [answers[1], { id: 'a', selected: ['one', 'two'] }]
    const accepted = await service.supplement(owner, run.id, { request_id: 'order', answers: reversed })
    expect((await service.supplement(owner, run.id, { request_id: 'order', answers })).id).toBe(accepted.id)
    expect(sessionController.prompt).toHaveBeenCalledTimes(2)
  })

  it('unblocks every pending native question before steering a historical supplement', async () => {
    const test = setup()
    const { database, owner, chat, service } = test
    const { run: source } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: '原任务', selection: {} })
    database.createPendingInput(owner.ownerId, source.id, { requestId: 'old', payload: { tool_name: 'ask_user_question', questions: [{ id: 'old', question: '旧问题' }] } })
    database.settlePendingInput(owner.ownerId, source.id, 'old', 'timeout')
    database.transitionRun(owner.ownerId, source.id, 'completed')
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: '后续任务', selection: {} })
    activateNative(test, run.id)
    const bridge = new HumanInputBridge({ database })
    service.humanInput = bridge
    service.scheduler = { hasAdmission: () => true, tick: vi.fn(async () => {}) }
    const pending = ['a', 'b'].map(id => bridge.handleRequest({ agent: { session: { id: chat.sessionId } }, questions: [{ id, question: id }] }, vi.fn()))
    try {
      await service.supplement(owner, source.id, { request_id: 'old', answers: [{ id: 'old', selected: [], custom: '补答' }] })
      expect(database.listPendingInputs(owner.ownerId, run.id).map(input => input.status)).toEqual(['skipped', 'skipped'])
      expect(await Promise.all(pending)).toEqual(['a', 'b'].map(id => ({ answers: [{ id, selected: [] }] })))
      expect(test.sessionController.prompt).toHaveBeenCalledWith(expect.objectContaining({ mode: 'steer' }), expect.any(AbortSignal))
    } finally {
      for (const input of database.listPendingInputs(owner.ownerId, run.id))
        if (input.status === 'pending') bridge.skip(owner.ownerId, run.id, input.requestId)
      await Promise.all(pending)
    }
  })

  it.each(['running', 'completed'])('admits a historical answer through native prompt when the task is %s', async (status) => {
    const test = setup()
    const { database, owner, chat, service, sessionController, agent } = test
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: '任务', selection: {} })
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'late-answer', payload: { tool_name: 'ask_user_question', questions: [{ id: 'format', question: '交付格式？' }] }, deadlineAt: null })
    database.settlePendingInput(owner.ownerId, run.id, 'late-answer', 'skipped')
    if (status === 'running') activateNative(test, run.id)
    else database.transitionRun(owner.ownerId, run.id, status)
    const tick = vi.fn(async () => {})
    service.scheduler = { hasAdmission: () => true, tick }
    const body = { request_id: 'late-answer', answers: [{ id: 'format', selected: [], custom: 'Word' }] }
    const result = await service.supplement(owner, run.id, body)
    const accepted = database.getRun(owner.ownerId, result.id)
    const content = status === 'running' ? sessionController.prompt.mock.calls[0][0].content : database.submission(owner.ownerId, result.id).content
    expect(content[0].text).toContain('交付格式？')
    expect(content[0].text).toContain('Word')
    expect(accepted.selection.prompt_mode).toBe('steer')
    expect(result.status).toBe(status === 'running' ? 'steered' : 'queued')
    expect(result.input_supplement).toEqual([{ question: '交付格式？', answer: 'Word' }])
    await service.supplement(owner, run.id, body)
    if (status === 'running') {
      expect(agent.steer).not.toHaveBeenCalled()
      expect(sessionController.prompt).toHaveBeenCalledOnce()
      expect(tick).not.toHaveBeenCalled()
    } else {
      expect(tick).toHaveBeenCalledOnce()
      expect(sessionController.prompt).not.toHaveBeenCalled()
    }
  })

  it('selects the next model during execution while retaining the active run snapshot', async () => {
    const test = setup()
    const { database, owner, chat, service, sessionController } = test
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: '任务', selection: { ...chat.selection, model: 'p/m' } })
    activateNative(test, run.id)
    const result = await service.updateConfig(owner, chat.id, { version: chat.version, selection: { ...chat.selection, model_parameters: { reasoning_effort: 'high' } } })
    expect(sessionController.selectModel).toHaveBeenCalled()
    expect(result.selection.model_parameters.reasoning_effort).toBe('high')
    expect(database.getRun(owner.ownerId, run.id).selection.model_parameters).not.toEqual({ reasoning_effort: 'high' })
  })

  it.each(['ask_user_question', 'exit_plan_mode'])('keeps %s visible across followup refreshes and preserves settled history', (toolName) => {
    const { database, owner, chat, service } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    const payload = { request_id: 'first', tool_call_id: 'first', tool_name: toolName, questions: [{ id: 'q', question: 'Question' }] }
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'first', payload, deadlineAt: Date.now() + 60000 })
    const detail = service.getRun(owner, run.id)
    const polled = service.followups(owner, chat.id, [run.id]).runs.find((value) => value.id === run.id)
    expect({ ...detail, ...polled }).toMatchObject({ status: 'waiting_input', pending: payload, human_input: { request_id: 'first', interacted: false } })
    database.touchPendingInput(owner.ownerId, run.id, 'first')
    expect(service.followups(owner, chat.id, [run.id]).runs[0].human_input).toMatchObject({ interacted: true, deadline_at: null })
    database.settlePendingInput(owner.ownerId, run.id, 'first', 'skipped')
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'second', payload: { ...payload, request_id: 'second' }, deadlineAt: null })
    database.settlePendingInput(owner.ownerId, run.id, 'second', 'submitted', { answers: [{ id: 'q', selected: [], custom: 'answer' }] })
    const refreshed = service.getRun(owner, run.id)
    expect(refreshed.pending).toBeNull()
    expect(refreshed.human_input_history).toMatchObject([
      { request_id: 'first', status: 'skipped', answers: [] },
      { request_id: 'second', status: 'submitted', answers: [{ id: 'q', selected: [], custom: 'answer' }] },
    ])
    expect(service.followups(owner, chat.id, [run.id]).runs[0].human_input_history).toEqual(refreshed.human_input_history)
    expect(() => database.listPendingInputs('other:user', run.id)).toThrow('任务不存在')
  })
  it('aggregates personal skills and MCP while keeping global skills readonly', async () => {
    const { service, fileManager, skills } = setup()
    fileManager.personalResources.mockResolvedValueOnce({
      memory: { content: 'm', version: 'v' }, warnings: [], order_version: 'skill-order',
      skills: [{ id: 'demo', content: '---\nname: demo\ndescription: Demo skill\n---\nBody', enabled: true, path: '/workspace/skills/demo', version: 's1' }],
    })
    fileManager.personalMcp.mockResolvedValueOnce({ mcp: [{ id: 'server', status: 'ready' }], warnings: [], order_version: 'mcp-order' })
    skills.list.mockResolvedValueOnce([{ name: 'global', description: 'Global', path: '/global/SKILL.md', source: 'custom', provider: 'gxzs' }])
    await expect(service.resources()).resolves.toMatchObject({
      skills: [{ id: 'demo', name: 'demo', description: 'Demo skill', scope: 'personal', readonly: false }],
      mcp: [{ id: 'server', status: 'ready' }],
      skill_order_version: 'skill-order', mcp_order_version: 'mcp-order',
      global: { skills: [{ id: 'global', scope: 'global', readonly: true }] },
    })
  })

  it('surfaces existing global skill conflicts and prevents enabling the personal collision', async () => {
    const { service, fileManager, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'demo', description: 'Global', provider: 'gxzs-filesystem' }])
    fileManager.personalResources.mockResolvedValue({ skills: [{ id: 'demo', enabled: true,
      content: '---\nname: demo\ndescription: Personal\n---\nBody' }] })
    fileManager.personalMcp.mockResolvedValue({ mcp: [] })
    const resources = await service.resources()
    expect(resources.skills[0].error).toContain('与全局技能冲突')
    expect(resources.warnings).toContain(resources.skills[0].error)
    expect(resources.global.skills[0].name).toBe('demo')
    fileManager.personalResources.mockClear()
    await expect(service.mutateResource({ operation: 'skill_toggle', name: 'demo', enabled: true })).rejects.toMatchObject({ status: 409 })
    expect(fileManager.personalResources).not.toHaveBeenCalled()
  })

  it('forwards validated resource mutations to fixed manager actions', async () => {
    const { service, fileManager } = setup()
    await service.mutateResource({ operation: 'skill_toggle', name: 'demo', enabled: false })
    await service.mutateResource({ operation: 'mcp_reorder', order: ['server'], order_version: null })
    expect(fileManager.personalResources).toHaveBeenCalledWith({ operation: 'skill_toggle', name: 'demo', enabled: false })
    expect(fileManager.personalMcp).toHaveBeenCalledWith({ operation: 'mcp_reorder', order: ['server'], order_version: null }, undefined)
    fileManager.personalResources
      .mockResolvedValueOnce({ content: '---\nname: demo\ndescription: Demo\n---\nBody' })
      .mockResolvedValueOnce({ skills: [{ id: 'demo', version: 'v1' }] })
    await expect(service.mutateResource({ operation: 'skill_inspect', files: [] })).resolves.toEqual({ name: 'demo', displayName: 'demo', version: 'v1' })
  })

  it('rejects removed memory writes and malformed skill imports before persistence', async () => {
    const { service, fileManager } = setup()
    await expect(service.mutateResource({ operation: 'memory_update', content: 'old' })).rejects.toMatchObject({ status: 400 })
    expect(fileManager.personalResources).not.toHaveBeenCalled()
    fileManager.personalResources.mockResolvedValueOnce({ content: 'invalid' })
    await expect(service.mutateResource({ operation: 'skill_import', files: [] })).rejects.toMatchObject({ status: 400 })
    expect(fileManager.personalResources).toHaveBeenCalledTimes(1)
  })

  it('derives import names from safely inspected package metadata', async () => {
    const { service, fileManager } = setup()
    fileManager.personalResources
      .mockImplementationOnce(async body => ({ import_id: body.import_id, content: '---\nname: demo\ndescription: Demo\n---\nBody' }))
      .mockResolvedValueOnce({ name: 'demo', version: null })
      .mockResolvedValueOnce({ status: 'ready' })
      .mockResolvedValueOnce({ content: '---\nname: demo\ndescription: Demo\n---\nBody' })
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'completed', id: 'demo', version: 'v2' })
    const payload = { operation: 'skill_import', archive: 'safe-package', version: null }
    await expect(service.mutateResource(payload)).resolves.toEqual({ id: 'demo', version: 'v2' })
    const calls = fileManager.personalResources.mock.calls.map(call => call[0])
    expect(calls.filter(call => call.archive)).toHaveLength(1)
    expect(calls[0]).toMatchObject({ ...payload, operation: 'skill_stage', import_id: expect.stringMatching(/^[a-f0-9]{32}$/) })
    expect(calls.find(call => call.operation === 'skill_import')).toMatchObject({ name: 'demo', version: null })
  })

  it('transfers a staged package once and validates its manifest before binding the target', async () => {
    const { service, fileManager } = setup()
    const import_id = 'a'.repeat(32), signal = new AbortController().signal
    const send = vi.fn(async () => ({ import_id, content: '---\nname: demo\ndescription: Demo\n---\nBody' }))
    fileManager.personalResources.mockResolvedValueOnce({ import_id, name: 'demo', version: 'v1' })
    const body = { operation: 'skill_stage', import_id, files: [{ path: 'demo.zip', size: 100 }] }
    await expect(service.mutateResource(body, undefined, send, signal)).resolves.toMatchObject({ import_id, name: 'demo', version: 'v1' })
    expect(send).toHaveBeenCalledExactlyOnceWith(body)
    expect(fileManager.personalResources).toHaveBeenCalledExactlyOnceWith({ operation: 'skill_prepare', import_id, name: 'demo' }, signal)
  })

  it('keeps legacy missing-version imports from overwriting an existing skill', async () => {
    const { service, fileManager } = setup()
    fileManager.personalResources
      .mockImplementationOnce(async body => ({ import_id: body.import_id, content: '---\nname: demo\ndescription: Demo\n---\nBody' }))
      .mockResolvedValueOnce({ conflict: true })
      .mockResolvedValueOnce({ status: 'cancelled' })
    await expect(service.mutateResource({ operation: 'skill_import', files: [] })).resolves.toEqual({ conflict: true })
    const calls = fileManager.personalResources.mock.calls.map(call => call[0])
    expect(calls.map(call => call.operation)).toEqual(['skill_stage', 'skill_prepare', 'skill_import_cancel'])
    expect(calls[1]).toMatchObject({ name: 'demo', version: null })
  })

  it.each([['failed', 400, 'SKILL_IMPORT_FAILED'], ['cancelled', 409, 'SKILL_IMPORT_CANCELLED']])
    ('preserves a confirmed legacy %s receipt without another cancellation', async (status, httpStatus, code) => {
      const { service, fileManager } = setup()
      fileManager.personalResources
        .mockImplementationOnce(async body => ({ import_id: body.import_id, content: '---\nname: demo\ndescription: Demo\n---\nBody' }))
        .mockResolvedValueOnce({ name: 'demo', version: null })
        .mockResolvedValueOnce({ status: 'ready' })
        .mockResolvedValueOnce({ content: '---\nname: demo\ndescription: Demo\n---\nBody' })
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ status, error: 'confirmed ' + status })
      await expect(service.mutateResource({ operation: 'skill_import', files: [], version: null }))
        .rejects.toMatchObject({ status: httpStatus, code })
      expect(fileManager.personalResources.mock.calls.some(([body]) => body.operation === 'skill_import_cancel')).toBe(false)
    })

  it('rechecks staged metadata and global collisions without retransferring package bytes', async () => {
    const { service, fileManager } = setup()
    const import_id = 'b'.repeat(32), signal = new AbortController().signal
    fileManager.personalResources
      .mockResolvedValueOnce({ status: 'ready' })
      .mockResolvedValueOnce({ content: '---\nname: demo\ndescription: Demo\n---\nBody' })
      .mockResolvedValueOnce({ status: 'completed', id: 'demo', version: 'v2' })
    const send = vi.fn()
    await expect(service.mutateResource({ operation: 'skill_import', import_id, name: 'forged', version: 'v1' }, undefined, send, signal))
      .resolves.toMatchObject({ status: 'completed' })
    expect(send).not.toHaveBeenCalled()
    expect(fileManager.personalResources).toHaveBeenLastCalledWith({ operation: 'skill_import', import_id, name: 'demo', version: 'v1' }, signal)
  })

  it('returns completed import receipts without another validation or publication', async () => {
    const { service, fileManager } = setup()
    fileManager.personalResources.mockResolvedValueOnce({ status: 'completed', id: 'demo', version: 'v2' })
    await expect(service.mutateResource({ operation: 'skill_import', import_id: 'c'.repeat(32), version: null }))
      .resolves.toMatchObject({ status: 'completed' })
    expect(fileManager.personalResources).toHaveBeenCalledOnce()
  })

  it('accepts a skill rename only when SKILL.md matches the requested call name', async () => {
    const { service, fileManager } = setup()
    const content = '---\nname: evidence-review\ndescription: Review evidence\nmetadata:\n  display-name: 证据审查\n---\n# Work'
    const payload = { operation: 'skill_update', name: 'case-evidence', new_name: 'evidence-review', version: 'v1', content }
    fileManager.personalResources.mockResolvedValueOnce({ id: 'evidence-review', version: 'v2' })
    await expect(service.mutateResource(payload)).resolves.toMatchObject({ id: 'evidence-review', version: 'v2' })
    expect(fileManager.personalResources).toHaveBeenCalledWith(payload)
    await expect(service.mutateResource({ ...payload, new_name: 'different' })).rejects.toMatchObject({ status: 400 })
  })

  it.each([502, 503, 504])('does not report an empty successful catalog on platform MCP status %s', async (status) => {
    const { service, platformClient } = setup()
    const error = Object.assign(new Error('unavailable'), { status })
    platformClient.json.mockRejectedValue(error)
    await expect(service.mcpCatalog({ ownerId: 'tenant:user' })).rejects.toMatchObject({ status: 503, code: 'MCP_CATALOG_UNAVAILABLE' })
    await expect(service.mcpCatalog({ ownerId: 'tenant:user' }, { required: true })).rejects.toMatchObject({ status: 503, code: 'MCP_CATALOG_UNAVAILABLE' })
  })

  it('uses the platform catalog retry deadline without replaying an exhausted read', async () => {
    const { service, platformClient, owner } = setup()
    service.platformClient.mcpPolicy = { catalog_timeout_seconds: 321 }
    const tool = { id: 'personal:mcp:gaode:maps_geo', runtime_name: 'maps_geo', version: 'v1',
      scope: 'personal', server_id: 'gaode', tool_name: 'maps_geo', description: 'Geocode',
      inputSchema: { type: 'object' } }
    platformClient.json.mockResolvedValueOnce({ data: { tools: [tool] } })
    await expect(service.freezeMcpTools(owner, [tool.id])).resolves.toMatchObject([{ id: tool.id }])
    expect(platformClient.json).toHaveBeenLastCalledWith(expect.objectContaining({ route: 'mcp/catalog', timeoutMs: 321_000 }))
    platformClient.json.mockRejectedValueOnce(Object.assign(new Error('temporary'), { status: 502 }))
    await expect(service.freezeMcpTools(owner, [tool.id])).rejects.toMatchObject({ code: 'MCP_CATALOG_UNAVAILABLE' })
    expect(platformClient.json).toHaveBeenCalledTimes(2)
  })

  it('freezes definitions after native registration refresh without a second divergent catalog read', async () => {
    const { service, platformClient, owner } = setup()
    const tool = { id: 'personal:mcp:demo:lookup', runtime_name: 'lookup', version: 'v1',
      scope: 'personal', server_id: 'demo', tool_name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }
    let ready
    service.refreshMcpCatalog = vi.fn(() => new Promise(resolve => { ready = resolve }))
    const frozen = service.freezeMcpTools(owner, [tool.id])
    expect(service.refreshMcpCatalog).toHaveBeenCalledWith(owner)
    expect(platformClient.json).not.toHaveBeenCalled()
    ready([{ ...tool, internalDiagnostic: 'must not persist' }])
    const resources = await frozen
    expect(resources).toMatchObject([tool])
    expect(resources[0]).not.toHaveProperty('internalDiagnostic')
    service.refreshMcpCatalog.mockRejectedValueOnce(Object.assign(new Error('not ready'), { code: 'MCP_CATALOG_UNAVAILABLE' }))
    await expect(service.freezeMcpTools(owner, [tool.id])).rejects.toMatchObject({ code: 'MCP_CATALOG_UNAVAILABLE' })
    expect(platformClient.json).not.toHaveBeenCalled()
  })

  it.each(['TimeoutError', 'TypeError'])('makes catalog %s explicit without leaking upstream error details', async (name) => {
    const { service, platformClient } = setup()
    platformClient.json.mockRejectedValue(Object.assign(new Error('secret upstream address'), { name }))
    await expect(service.mcpCatalog({ ownerId: 'tenant:user' })).rejects.toMatchObject({
      status: 503, code: 'MCP_CATALOG_UNAVAILABLE', message: 'MCP 工具目录暂不可用，请稍后重试',
    })
  })

  it('freezes selected global and personal MCP tool revisions on each run', async () => {
    const { database, owner, chat, service, platformClient } = setup()
    const tools = [
      { id: 'global:court:search', runtime_name: 'global_court_search', version: 'g1', scope: 'global', server_id: 'court', tool_name: 'search', description: 'Search', inputSchema: { type: 'object' } },
      { id: 'personal:mine:lookup', runtime_name: 'personal_mine_lookup', version: 'p1', scope: 'personal', server_id: 'mine', tool_name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } },
    ]
    platformClient.json.mockResolvedValue({ tools })
    await service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m', tools: tools.map((tool) => tool.id) } })
    const run = await service.submitRun(owner, chat.id, { query: 'q', request_key: 'mcp-run', version: 2 })
    expect(database.getRun(owner.ownerId, run.id).mcpTools).toEqual(tools.map((tool) => expect.objectContaining({ ...tool, runtime_name: platformToolName(tool) })))
    platformClient.json.mockResolvedValue({ tools: [{ ...tools[0], version: 'g2' }] })
    expect(database.getRun(owner.ownerId, run.id).mcpTools.map((tool) => tool.version)).toEqual(['g1', 'p1'])
  })

  it('exposes all enabled global and personal MCP tools without a manual selection', async () => {
    const { database, owner, chat, service, platformClient } = setup()
    const tools = [
      { id: 'global:mcp:legal:search', runtime_name: 'global_legal_search', version: 'g1', scope: 'global', server_id: 'legal', tool_name: 'search', description: 'Search', inputSchema: { type: 'object' } },
      { id: 'personal:mcp:gaode:maps_geo', runtime_name: 'personal_gaode_maps_geo', version: 'p1', scope: 'personal', server_id: 'gaode', tool_name: 'maps_geo', description: 'Geocode', inputSchema: { type: 'object' } },
    ]
    platformClient.json.mockResolvedValue({ tools })
    const run = await service.submitRun(owner, chat.id, { query: '驾车从徐州到襄城' })
    expect(database.getRun(owner.ownerId, run.id).mcpTools.map(tool => tool.id)).toEqual(tools.map(tool => tool.id))
    expect(database.getChat(owner.ownerId, chat.id).selection.tools ?? []).toEqual([])
  })

  it('preserves MCP provider identity for plugin grouping', async () => {
    const { service, platformClient, owner } = setup()
    platformClient.json.mockResolvedValue({ tools: [{
      id: 'global:mcp:web-search:search', runtime_name: 'global_mcp_search', version: '1',
      scope: 'global', group: 'mcp', provider: 'global:mcp:web-search', provider_name: '联网搜索',
      server_id: 'web-search', tool_name: 'search', description: 'Search', inputSchema: { type: 'object' },
    }] })
    await expect(service.mcpCatalog(owner)).resolves.toMatchObject([{
      group: 'mcp', provider: 'global:mcp:web-search', provider_name: '联网搜索',
    }])
  })

  it('keeps original display names and matches the registered aliases for duplicate providers', async () => {
    const { service, platformClient, owner } = setup()
    const tools = ['global', 'personal'].map(scope => ({
      id: `${scope}:mcp:court:search`, runtime_name: `${scope}_court_search`, version: '1', manifest_version: 'm1',
      scope, server_id: 'court', tool_name: 'search', description: 'Search', inputSchema: { type: 'object' },
    }))
    platformClient.json.mockResolvedValue({ tools })
    const catalog = await service.mcpCatalog(owner)
    const names = platformToolNames(tools)
    expect(catalog.map(tool => tool.name)).toEqual(['search', 'search'])
    expect(catalog.map(tool => tool.display_name)).toEqual(['search', 'search'])
    expect(catalog.map(tool => tool.runtime_name)).toEqual(tools.map(tool => names.get(tool.id)))
    expect(new Set(catalog.map(tool => tool.runtime_name)).size).toBe(2)
    expect((await service.freezeMcpTools(owner, [tools[1].id])).find(tool => tool.id === tools[1].id)).toMatchObject({ id: tools[1].id, version: '1', manifest_version: 'm1', runtime_name: names.get(tools[1].id) })
  })

  it('does not let stale legacy chat selections block a model update or a new run', async () => {
    const { database, owner, chat, service, platformClient } = setup()
    platformClient.json.mockResolvedValue({ tools: [] })
    await service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m', tools: ['personal:missing:x'] } })
    const run = await service.submitRun(owner, chat.id, { query: '正常继续', version: 2 })
    expect(database.getRun(owner.ownerId, run.id).mcpTools).toEqual([])
    expect(database.getChat(owner.ownerId, chat.id).version).toBe(2)
  })

  it('keeps pin and favorite independent and synchronizes accepted titles', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    await service.updateChat(owner, chat.id, { pinned: true, favorited: false, title: '调查任务' })
    expect(database.getChat(owner.ownerId, chat.id)).toMatchObject({ title: '调查任务', pinned: true, favorited: false })
    await service.updateChat(owner, chat.id, { favorited: true })
    expect(database.getChat(owner.ownerId, chat.id)).toMatchObject({ pinned: true, favorited: true })
    expect(sessionController.rename).toHaveBeenCalledWith({ sessionId: chat.sessionId, title: '调查任务' })
  })

  it('does not change a title when DSH rename fails', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    sessionController.rename.mockRejectedValueOnce(new Error('unavailable'))
    await expect(service.updateChat(owner, chat.id, { title: 'new' })).rejects.toThrow('unavailable')
    expect(database.getChat(owner.ownerId, chat.id).title).toBe('新会话')
  })

  it('commits configuration only after DSH model selection succeeds', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const body = { version: 1, selection: { model: 'p/m', model_parameters: { reasoning_effort: 'high' } } }
    sessionController.selectModel.mockRejectedValueOnce(new Error('no route'))
    await expect(service.updateConfig(owner, chat.id, body)).rejects.toThrow('no route')
    expect(database.getChat(owner.ownerId, chat.id).version).toBe(1)
    const result = await service.updateConfig(owner, chat.id, body)
    expect(result).toMatchObject({ version: 2, selection: { model: 'p/m' } })
    expect(sessionController.selectModel).toHaveBeenLastCalledWith({ sessionId: chat.sessionId, provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('coalesces two identical configuration writes against the same version', async () => {
    const { owner, chat, service, sessionController } = setup()
    const results = await Promise.allSettled([
      service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m' } }),
      service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m' } }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(results.map((result) => result.status === 'fulfilled' && result.value.version)).toEqual([2, 2])
    expect(sessionController.selectModel).toHaveBeenCalledOnce()
  })

  it('accepts a stale retry when its normalized selection already matches', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const selection = { model: 'p/m', tools: [], skills: [], knowledge: [], model_parameters: {}, tool_parameters: {} }
    await service.updateConfig(owner, chat.id, { version: 1, selection })
    sessionController.selectModel.mockClear()
    await expect(service.updateConfig(owner, chat.id, { version: 1, selection })).resolves.toMatchObject({
      version: 2, selection,
    })
    expect(database.getChat(owner.ownerId, chat.id).version).toBe(2)
    expect(sessionController.selectModel).not.toHaveBeenCalled()
  })

  it('serializes run admission behind configuration selection', async () => {
    const { owner, chat, service, sessionController } = setup()
    let release
    sessionController.selectModel.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const configuration = service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m' } })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const admission = service.submitRun(owner, chat.id, { version: 1, query: 'old version', request_key: 'old' })
    const assertion = expect(admission).rejects.toMatchObject({ status: 409 })
    release({ selected: { provider: 'p', model: 'm' } })
    await configuration
    await assertion
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })




  it('stores feedback locally without telemetry and enforces owner access', () => {
    const { database, owner, chat, service } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    expect(service.feedback(owner, run.id, 'like').feedback).toBe('like')
    expect(service.feedback(owner, run.id, 'dislike').feedback).toBe('dislike')
    expect(service.feedback(owner, run.id, null).feedback).toBeNull()
    expect(() => service.feedback({ ownerId: 'other:user' }, run.id, 'like')).toThrow('任务不存在')
  })

  it('returns reasoning parameter rules and permanently deletes chats and runs', async () => {
    const { database, owner, chat, service } = setup()
    expect(await service.modelParameters('p/m')).toMatchObject({ reasoning_effort: { options: ['low', 'high'], default: 'low' } })
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    database.transitionRun(owner.ownerId, run.id, 'completed')
    await service.deleteChat(owner, chat.id)
    expect(service.listChats(owner)).toEqual([])
    expect(() => service.getRun(owner, run.id)).toThrow('任务不存在')
    expect(database.db.prepare('SELECT id FROM chats WHERE id = ?').get(chat.id)).toBeUndefined()
    expect(database.db.prepare('SELECT id FROM runs WHERE id = ?').get(run.id)).toBeUndefined()
    await service.deleteChat(owner, chat.id)
  })

  it.each([false, true])('preserves a retained nested workspace during deletion, pending=%s', async pending => {
    const { database, owner, chat, service, fileManager } = setup()
    const directory = `conversations/${chat.id}`
    if (pending) database.beginChatDeletion(owner.ownerId, chat.id, [chat.sessionId], { path: directory, version: 'old' })
    const retained = database.createChat({ ownerId: owner.ownerId, sessionId: 'retained', selection: {}, directory: `${directory}/sub/../nested` })
    await service.deleteChat(owner, chat.id)
    expect(fileManager.operate).not.toHaveBeenCalled()
    expect(database.chatDeletion(owner.ownerId, chat.id).completedAt).toEqual(expect.any(Number))
    expect(database.getChat(owner.ownerId, retained.id)).toBeDefined()
  })

  it('does not confuse a neighboring directory prefix with a shared workspace', async () => {
    const { database, owner, chat, service, fileManager } = setup()
    const directory = `conversations/${chat.id}`
    database.createChat({ ownerId: owner.ownerId, sessionId: 'retained', selection: {}, directory: `${directory}-other` })
    await service.deleteChat(owner, chat.id)
    expect(fileManager.operate).toHaveBeenCalledWith({ operation: 'delete', path: directory, version: 'tree-v1' })
  })

  it('keeps a retry receipt after native erasure fails and never reports successful deletion early', async () => {
    const { database, owner, chat, service } = setup()
    service.permanentDeletion.erase.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(service.deleteChat(owner, chat.id)).rejects.toThrow('storage unavailable')
    expect(database.chatDeletion(owner.ownerId, chat.id).completedAt).toBeNull()
    expect(database.deletionChat(owner.ownerId, chat.id)).toBeDefined()
    await service.deleteChat(owner, chat.id)
    expect(database.chatDeletion(owner.ownerId, chat.id).completedAt).toEqual(expect.any(Number))
    expect(database.deletionChat(owner.ownerId, chat.id)).toBeUndefined()
    await expect(service.deleteChat({ ownerId: 'another' }, chat.id)).rejects.toMatchObject({ status: 404 })
  })

  it.each(['running', 'waiting_input', 'stopping', 'queued', 'completed'])('permanently deletes a legacy hidden %s run and releases its ticket without exposing it', async status => {
    const { database, owner, chat, service, agent } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'private', selection: {} })
    database.transitionRun(owner.ownerId, run.id, status)
    database.saveSubmission(owner.ownerId, run.id, [])
    database.dispatchSubmission(owner.ownerId, run.id)
    database.db.prepare('UPDATE chats SET deleted_at=1 WHERE id=?').run(chat.id)
    service.scheduler = { deletingChats: new Set(), request: vi.fn(async () => {
      expect(service.listChats(owner)).toEqual([])
      expect(database.getRun(owner.ownerId, run.id)).toBeUndefined()
    }) }
    await expect(service.deleteChat({ ownerId: 'another' }, chat.id)).rejects.toMatchObject({ status: 404 })
    await service.deleteChat(owner, chat.id)
    expect(agent.cancel).toHaveBeenCalled()
    expect(service.scheduler.request).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }), 'release')
    expect(database.deletionChat(owner.ownerId, chat.id)).toBeUndefined()
    expect(database.submission(owner.ownerId, run.id)).toBeUndefined()
    expect(database.chatDeletion(owner.ownerId, chat.id).completedAt).toEqual(expect.any(Number))
  })

  it('retains a durable deletion for retry on a directory conflict', async () => {
    const { database, owner, chat, service, fileManager } = setup()
    fileManager.operate.mockResolvedValueOnce({ kind: 'directory', version: 'tree-v2' })
      .mockResolvedValueOnce({ kind: 'directory', version: 'tree-v2' })
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }))
    await expect(service.deleteChat(owner, chat.id)).rejects.toMatchObject({ status: 409 })
    expect(fileManager.operate).toHaveBeenLastCalledWith({ operation: 'delete', path: `conversations/${chat.id}`, version: 'tree-v2' })
    expect(database.chatDeletion(owner.ownerId, chat.id).completedAt).toBeNull()
    expect(service.permanentDeletion.erase).not.toHaveBeenCalled()
    fileManager.operate.mockResolvedValueOnce({ kind: 'missing' })
    await service.deleteChat(owner, chat.id)
    expect(service.listChats(owner)).toHaveLength(0)
  })

  it('cancels a running chat and its inbox before deleting files', async () => {
    const { database, owner, chat, service, fileManager, agent } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    database.transitionRun(owner.ownerId, run.id, 'running')
    let finish
    agent.whenIdle.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const deleting = service.deleteChat(owner, chat.id)
    await vi.waitFor(() => expect(agent.whenIdle).toHaveBeenCalled())
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: false })
    expect(fileManager.operate).not.toHaveBeenCalled()
    finish()
    await deleting
    expect(service.listChats(owner)).toEqual([])
  })

  it('preserves the conversation and files when native cancellation fails', async () => {
    const { owner, chat, service, fileManager, agent } = setup()
    agent.cancel.mockImplementation(() => { throw new Error('cancel failed') })
    await expect(service.deleteChat(owner, chat.id)).rejects.toThrow('cancel failed')
    expect(fileManager.operate).not.toHaveBeenCalled()
    expect(service.listChats(owner)).toHaveLength(1)
  })

  it('stops native background activity and terminals before removing the chat directory', async () => {
    const { owner, chat, service, fileManager } = setup()
    const actions = []
    service.workspaces = { baseline: async () => ({ items: [] }), controller: { archiveSession: vi.fn(async request => actions.push(['archive', request])) } }
    service.closeTerminals = vi.fn(async sessionId => actions.push(['terminals', sessionId]))
    let settled
    const unwinding=new Promise(resolve=>{settled=resolve})
    service.waitSessionActivity = vi.fn(async sessionId => {await unwinding;actions.push(['settled', sessionId])})
    fileManager.operate.mockImplementation(async request => {
      actions.push([request.operation])
      return request.operation === 'stat' ? { kind: 'directory', version: 'v1' } : { deleted: true }
    })
    const deletion=service.deleteChat(owner, chat.id)
    await vi.waitFor(()=>expect(service.waitSessionActivity).toHaveBeenCalledWith(chat.sessionId))
    expect(fileManager.operate).not.toHaveBeenCalled()
    settled();await deletion
    expect(actions).toEqual([['archive', { sessionId: chat.sessionId, stopActivity: true }], ['terminals', chat.sessionId], ['settled', chat.sessionId], ['stat'], ['stat'], ['delete']])
    expect(service.listChats(owner)).toEqual([])
  })

  it('keeps files and the chat when the native background stop fails', async () => {
    const { owner, chat, service, fileManager } = setup()
    service.workspaces = { controller: { archiveSession: vi.fn(async () => { throw new Error('stop failed') }) } }
    service.closeTerminals = vi.fn()
    await expect(service.deleteChat(owner, chat.id)).rejects.toThrow('stop failed')
    expect(fileManager.operate).not.toHaveBeenCalled()
    expect(service.closeTerminals).not.toHaveBeenCalled()
    expect(service.listChats(owner)).toHaveLength(1)
  })

  it('waits for admission and releases all scheduling tickets before deleting', async () => {
    const { database, owner, chat, service, agent, fileManager } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'queued', selection: {} })
    database.saveSubmission(owner.ownerId, run.id, [])
    let finishAdmission
    service.scheduler = {
      deletingChats: new Set(),
      pendingTick: new Promise((resolve) => { finishAdmission = resolve }),
      request: vi.fn(async () => ({ state: 'released' })),
    }
    const deleting = service.deleteChat(owner, chat.id)
    await vi.waitFor(() => expect(service.scheduler.deletingChats.has(chat.id)).toBe(true))
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(fileManager.operate).not.toHaveBeenCalled()
    finishAdmission()
    await deleting
    expect(service.scheduler.request).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }), 'release')
    expect(database.submissions(owner.ownerId)).toEqual([])
    expect(service.scheduler.deletingChats.has(chat.id)).toBe(false)
  })

  it('retains the conversation for retry if releasing its ticket fails', async () => {
    const { database, owner, chat, service, fileManager } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'queued', selection: {} })
    database.saveSubmission(owner.ownerId, run.id, [])
    service.scheduler = { deletingChats: new Set(), request: vi.fn(async () => { throw new Error('offline') }) }
    await expect(service.deleteChat(owner, chat.id)).rejects.toThrow('offline')
    expect(service.listChats(owner)).toHaveLength(1)
    expect(fileManager.operate).not.toHaveBeenCalled()
    expect(service.scheduler.deletingChats.has(chat.id)).toBe(false)
  })

  it('admits verified sandbox images natively and carries non-image paths as data', async () => {
    const { owner, chat, service, sessionController, fileManager } = setup()
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    fileManager.operate
      .mockResolvedValueOnce({ name: 'evidence.png', version: 'v1', data: png.toString('base64') })
      .mockResolvedValueOnce({ name: 'notes.txt', version: 'v2', data: Buffer.from('notes').toString('base64') })
    const run = await service.submitRun(owner, chat.id, {
      query: '分析附件', request_key: 'attachments', files: [
        { path: 'case/evidence.png', version: 'v1' }, { path: 'case/notes.txt', version: 'v2' },
      ],
    })
    expect(run.attachments).toEqual([
      { name: 'evidence.png', path: 'case/evidence.png', version: 'v1' },
      { name: 'notes.txt', path: 'case/notes.txt', version: 'v2' },
    ])
    const content = sessionController.prompt.mock.calls[0][0].content
    expect(content[0].text).toContain('/workspace/case/notes.txt')
    expect(content[1]).toMatchObject({ type: 'image', mediaType: 'image/png', name: 'evidence.png' })
    expect(service.getChat(owner, chat.id).title).toBe('新会话')
  })

  it.each(['1.png', 'notes.txt'])('uses the full workspace path for a textless %s first message', async (name) => {
    const { database, owner, chat, service, fileManager, sessionController } = setup()
    const bytes = name.endsWith('.png') ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]) : Buffer.from('notes')
    fileManager.operate.mockResolvedValue({ name, version: 'v1', data: bytes.toString('base64') })
    const run = await service.submitRun(owner, chat.id, { query: '', files: [{ path: `conversations/${chat.id}/${name}`, version: 'v1' }] })
    const title = `/workspace/conversations/${chat.id}/${name}`
    expect(service.getChat(owner, chat.id).title).toBe('新会话')
    expect(sessionController.prompt.mock.calls[0][0].content[0]).toEqual(name.endsWith('.png') ? expect.objectContaining({ type: 'image', name }) : { type: 'text', text: title })
    expect(database.allEvents(owner.ownerId, run.id)).not.toContainEqual(expect.objectContaining({ event: 'workbench_chat_title' }))
    await service.submitRun(owner, chat.id, { query: '后续消息' })
    expect(service.getChat(owner, chat.id).title).toBe('新会话')
  })

  it('leaves automatic naming to DSH when admitting human messages', async () => {
    const { owner, chat, service, sessionController } = setup()
    await service.submitRun(owner, chat.id, { query: '检索资料，核对结论' })
    expect(service.getChat(owner, chat.id).title).toBe('新会话')
    expect(sessionController.rename).not.toHaveBeenCalled()
    await service.submitRun(owner, chat.id, { query: '再检查一下' })
    expect(service.getChat(owner, chat.id).title).toBe('新会话')
  })

  it('rejects changed attachments before creating or prompting a run', async () => {
    const { database, owner, chat, service, sessionController, fileManager } = setup()
    fileManager.operate.mockResolvedValueOnce({ name: 'a.txt', version: 'new', data: Buffer.from('x').toString('base64') })
    await expect(service.submitRun(owner, chat.id, { query: 'q', request_key: 'stale', files: [{ path: 'a.txt', version: 'old' }] }))
      .rejects.toMatchObject({ status: 409 })
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(0)
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })

  it('keeps failed submission receipts immutable and gives an explicit retry a new native identity', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    sessionController.prompt.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ accepted: true })
    const body = { query: 'retry', request_key: 'retry-key' }
    const first = await service.submitRun(owner, chat.id, body)
    expect(first).toMatchObject({ status: 'failed', error: expect.stringContaining('temporary') })
    const second = await service.submitRun(owner, chat.id, body)
    expect(second).toMatchObject({ id: first.id, status: 'failed', error: first.error })
    expect(sessionController.prompt.mock.calls.map(([request]) => request.requestId)).toEqual([first.id])
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
    await expect(service.submitRun(owner, chat.id, { request_key: body.request_key, version: -1 })).resolves.toMatchObject({ id: first.id, status: 'failed' })
    const retried = await service.submitRun(owner, chat.id, { ...body, request_key: 'retry-next', retry_of: first.id })
    expect(retried.id).not.toBe(first.id)
    expect(retried.parent_run_id).toBe(first.id)
    expect(sessionController.prompt.mock.calls.map(([request]) => request.requestId)).toEqual([first.id, retried.id])
  })

  it('uses durable DSH message ids for queue deletion', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'queued', selection: {} })
    database.bindRunMessage(chat.sessionId, run.id, 2, 'message-2')
    const result = await service.removeQueued(owner, run.id)
    expect(sessionController.updateQueue).toHaveBeenCalledWith({ sessionId: chat.sessionId, itemId: 'message-2', action: { kind: 'remove' } })
    expect(result.status).toBe('discarded')
    sessionController.updateQueue.mockRejectedValue(new Error('already removed'))
    await expect(service.removeQueued(owner, run.id)).resolves.toMatchObject({ status: 'discarded' })
    expect(sessionController.updateQueue).toHaveBeenCalledOnce()
  })

  it.each(['running', 'completed'])('rejects queue deletion for a %s run without touching native state', async (status) => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    database.transitionRun(owner.ownerId, run.id, status)
    await expect(service.removeQueued(owner, run.id)).rejects.toMatchObject({ status: 409, code: 'STALE_RUN' })
    expect(sessionController.updateQueue).not.toHaveBeenCalled()
  })

  it('steers a queued message through the native queue controller', async () => {
    const test = setup()
    const { database, owner, chat, service, agent } = test
    const { run: active } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'active', selection: {} })
    database.transitionRun(owner.ownerId, active.id, 'running')
    const { run: queued } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'queued', selection: {} })
    database.bindRunMessage(chat.sessionId, queued.id, 2, 'message-2')
    activateNative(test, active.id, [{ id: 'message-2', source: { kind: 'user', rpcId: queued.id }, content: [{ type: 'text', text: 'queued' }] }])
    const result = await service.steer(owner, queued.id, active.id)
    expect(test.sessionController.updateQueue).toHaveBeenCalledWith({ sessionId: chat.sessionId, itemId: 'message-2', action: { kind: 'steer' } })
    expect(agent.inbox.remove).not.toHaveBeenCalled()
    expect(result.status).toBe('steered')
  })

  it('merges concurrent commands with the same request key', async () => {
    const { owner, chat, service, commands } = setup()
    await Promise.all([
      service.issueCommand(owner, chat.id, { command: '/goal pause', expected_revision: 0, request_key: 'same' }),
      service.issueCommand(owner, chat.id, { command: '/goal pause', expected_revision: 0, request_key: 'same' }),
    ])
    expect(commands.execute).toHaveBeenCalledOnce()
  })

  it('cancels an active run through the synchronous DSH cancel method', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'active', selection: {} })
    database.transitionRun(owner.ownerId, run.id, 'running')
    expect(await service.stopRun(owner, run.id)).toMatchObject({ status: 'running' })
    expect(sessionController.cancel).toHaveBeenCalledWith({ sessionId: chat.sessionId })
  })

  it.each(['/plan off', '/plan  off', '/goal', '/goal pause', '/goal resume', '/goal clear', '/goal edit', '/goal PAUSE'])('rejects sandbox attachments on %s before changing native state', async command => {
    const { owner, chat, service, commands, fileManager, database } = setup()
    await expect(service.issueCommand(owner, chat.id, { command, request_key: 'control-file',
      files: [{ path: 'evidence.txt', version: 'v1' }] })).rejects.toMatchObject({ status: 400 })
    expect(commands.execute).not.toHaveBeenCalled()
    expect(fileManager.operate).not.toHaveBeenCalled()
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(0)
  })

  it.each(['pause after reviewing evidence', 'clear the evidence backlog'])('associates the native objective "%s" with an admitted run', async objective => {
    const { owner, chat, service, commands, database } = setup()
    const result = await service.issueCommand(owner, chat.id, { command: `/goal ${objective}`, request_key: 'objective-prefix' })
    expect(result.run.query).toBe(objective)
    expect(database.goalRun(chat.sessionId).id).toBe(result.run.id)
    expect(commands.execute.mock.calls[0][1]).toBe(`/goal ${objective}`)
  })

  it.each(['pause', 'PAUSE', 'clear', 'CLEAR', 'edit', 'EDIT', 'EDIT revised objective'])('does not create a new run for native goal control %s', async control => {
    const { owner, chat, service, database } = setup()
    await service.issueCommand(owner, chat.id, { command: `/goal ${control}`, request_key: 'goal-control' })
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(0)
  })

  it.each(['resume', 'RESUME'])('preserves the goal resource snapshot with native %s', async control => {
    const { owner, chat, service, database, commands, agent, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'evidence', invocation: { userInvocable: true, modelInvocable: false } }])
    const selection = { command: 'goal', resource_context: 'Use the selected evidence skill and sandbox file.',
      resource_mentions: { skills: ['evidence'], tools: [] }, mentioned_resources: [{ kind: 'skills', name: '旧展示名' }] }
    const attachments = [{ name: 'evidence.txt', path: 'evidence.txt', version: 'v1' }]
    const mcpTools = [{ name: 'lookup', inputSchema: { type: 'object' } }]
    const previous = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: 'Review evidence', selection, attachments, mcpTools }).run
    database.transitionRun(owner.ownerId, previous.id, 'completed')
    database.setGoalRun(chat.sessionId, previous.id)
    service.goals = { get: () => ({ id: 'goal', revision: 2, phase: 'active', objective: previous.query }) }
    const freeze = vi.spyOn(service, 'freezeMcpTools')
    const result = await service.issueCommand(owner, chat.id, { command: `/goal ${control}`, request_key: 'resume-command' })
    const resumed = database.getRun(owner.ownerId, result.run.id)
    expect(resumed.id).not.toBe(previous.id)
    expect(resumed.selection).toEqual({ ...previous.selection, model: chat.selection.model, model_parameters: {}, silent_resume: false, is_continuation: true,
      skill_invocations: [{ name: 'evidence' }] })
    expect(result.run).toMatchObject({ is_continuation: true, parent_run_id: previous.id })
    expect(resumed.attachments).toEqual(attachments)
    expect(resumed.mcpTools).toEqual(mcpTools)
    expect(freeze).not.toHaveBeenCalled()
    expect(commands.execute).toHaveBeenCalledWith(agent, `/goal ${control}`, [], expect.any(AbortSignal))
  })

  it.each([undefined, {}, { skills: [], tools: [], knowledge: [] }, { skills: ['evidence'] }])('resumes the stored selection with compatible control input %j', async resource_mentions => {
    const { owner, chat, service, database, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'evidence', invocation: { userInvocable: true, modelInvocable: false } }])
    const previous = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: 'Review evidence', selection: { command: 'goal', resource_mentions: { skills: ['evidence'] } }, mcpTools: [] }).run
    database.setGoalRun(chat.sessionId, previous.id)
    service.goals = { get: () => ({ id: 'g', revision: 2, phase: 'paused', objective: previous.query }) }
    const result = await service.issueCommand(owner, chat.id, { command: '/goal resume', request_key: 'resume', resource_mentions })
    expect(result.run.resource_mentions.skills).toEqual(['evidence'])
  })

  it('rejects a changed nonempty selection on goal resume before native mutation or a new receipt', async () => {
    const { owner, chat, service, database, commands } = setup()
    const previous = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: 'Review evidence', selection: { command: 'goal', resource_mentions: { skills: ['evidence'] } }, mcpTools: [] }).run
    database.setGoalRun(chat.sessionId, previous.id)
    service.goals = { get: () => ({ id: 'g', revision: 2, phase: 'paused', objective: previous.query }) }
    await expect(service.issueCommand(owner, chat.id, { command: '/goal resume', request_key: 'resume',
      resource_mentions: { skills: ['other'] } })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('沿用原资源引用') })
    expect(commands.execute).not.toHaveBeenCalled()
    expect(database.goalRun(chat.sessionId).id).toBe(previous.id)
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
  })

  it('shows provider rejection in historical Goal state and resumes with current model preferences', async () => {
    const { owner, chat, service, database } = setup()
    const raw = '400 data: {"error":{"code":"data_inspection_failed","message":"Input text data may contain inappropriate content."}}'
    const previous = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: 'Report', selection: { command: 'goal', model: 'old/model', resource_context: 'Original evidence' }, mcpTools: [] }).run
    database.setGoalRun(chat.sessionId, previous.id)
    database.transitionRun(owner.ownerId, previous.id, 'failed', raw)
    database.appendEvent(owner.ownerId, previous.id, { event: 'workbench_end', status: 'failed', error: raw })
    const goal = { id: 'g1', revision: 1, objective: 'Report', phase: 'active', activation: 'disarmed' }
    service.goals = { get: () => goal, resume: vi.fn() }
    expect((await service.getControl(owner, chat.id)).goal.reason).toContain('模型服务拒绝')
    const dto = service.getRun(owner, previous.id, true)
    expect(dto.error).toContain('相同上下文')
    expect(dto.events[0]).toMatchObject({ error_code: 'data_inspection_failed', error: dto.error })
    expect(database.getRun(owner.ownerId, previous.id).error).toBe(raw)
    const result = await service.mutateGoal(owner, chat.id, 'resume', { ref: { id: goal.id, revision: goal.revision } })
    expect(service.goals.resume).toHaveBeenCalledExactlyOnceWith(expect.anything(), { id: goal.id, revision: goal.revision })
    expect(result.run).toMatchObject({ is_continuation: true, parent_run_id: previous.id })
    expect(database.getRun(owner.ownerId, result.run.id).selection).toMatchObject({ model: 'p/m', resource_context: 'Original evidence' })
  })

  it('resumes a cold DSH session before executing a control command', async () => {
    const { owner, chat, service, sessionController, agents, commands, agent } = setup()
    agents.get.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined).mockReturnValue(agent)
    await expect(service.issueCommand(owner, chat.id, {
      command: '/goal pause', expected_revision: 0, request_key: 'cold-goal',
    })).resolves.toMatchObject({ message: 'ok' })
    expect(sessionController.create).toHaveBeenCalledWith({ sessionId: chat.sessionId, cwd: `/workspace/conversations/${chat.id}` })
    expect(commands.execute).toHaveBeenCalledWith(agent, '/goal pause', [], expect.any(AbortSignal))
  })

  it('does not infer plan state from command text', async () => {
    const { owner, chat, service } = setup()
    await expect(service.issueCommand(owner, chat.id, {
      command: '/plan 调查证据', expected_revision: 0, request_key: 'plan-objective',
    })).resolves.toMatchObject({ state: { plan: { active: false, pending: false } } })
  })

  it('admits a plan task once and persists its mode, title and resource labels', async () => {
    const { owner, chat, service, database, commands, sessionController, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'evidence', displayName: '证据整理', description: '整理材料', invocation: { userInvocable: true, modelInvocable: false } }])
    const body = { command: '/plan 调查证据', request_key: 'one-plan', resource_mentions: { skills: ['evidence'] }, mention_positions: [{ kind: 'skills', id: 'evidence', offset: 2 }] }
    const first = await service.issueCommand(owner, chat.id, body)
    const replay = await service.issueCommand(owner, chat.id, body)
    expect(replay.run.id).toBe(first.run.id)
    expect(commands.execute).toHaveBeenCalledOnce()
    expect(commands.execute.mock.calls[0][1]).toBe('/plan 调查证据\n/evidence')
    expect(sessionController.prompt).not.toHaveBeenCalled()
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
    expect(database.getChat(owner.ownerId, chat.id).title).toBe('新会话')
    expect(first.run).toMatchObject({ command: 'plan', query: '调查证据', mentioned_resources: [{ name: '证据整理', kind: 'skills', offset: 2 }] })
    skills.list.mockResolvedValue([{ name: 'evidence', displayName: '新名字' }])
    expect(service.getRun(owner, first.run.id).mentioned_resources[0].name).toBe('证据整理')
  })

  it.each(['image.png', 'evidence.txt'])('submits an attachment-only native plan once for %s', async (name) => {
    const { owner, chat, service, database, commands, fileManager, sessionController } = setup()
    const data = name.endsWith('.png') ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from('evidence')
    fileManager.operate.mockResolvedValue({ kind: 'file', version: 'v1', data: data.toString('base64') })
    const body = { command: '/plan', request_key: 'attachment-plan', files: [{ path: name, version: 'v1' }] }
    const result = await service.issueCommand(owner, chat.id, body)
    await service.issueCommand(owner, chat.id, body)
    expect(commands.execute).toHaveBeenCalledOnce()
    expect(commands.execute.mock.calls[0][1]).toBe(name.endsWith('.png') ? '/plan' : '/plan /workspace/evidence.txt')
    expect(commands.execute.mock.calls[0][2]).toEqual(name.endsWith('.png')
      ? [expect.objectContaining({ type: 'image', name })] : [])
    expect(result.run.attachments).toEqual([{ name, path: name, version: 'v1' }])
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })

  it('waits for native plan events after command admission', async () => {
    const { owner, chat, service } = setup()
    const entered = await service.issueCommand(owner, chat.id, {
      command: '/plan 调查证据', expected_revision: 0, request_key: 'plan-enter',
    })
    await expect(service.issueCommand(owner, chat.id, {
      command: '/plan off', expected_revision: entered.state.revision, request_key: 'plan-exit',
    })).resolves.toMatchObject({ state: { plan: { active: false, pending: false } } })
  })

  it('executes only supported native DSH commands with revision CAS', async () => {
    const { owner, chat, service, commands, agent } = setup()
    await expect(service.issueCommand(owner, chat.id, { command: '/goal pause', expected_revision: 0, request_key: 'goal-1' })).resolves.toMatchObject({ message: 'ok' })
    expect(commands.execute).toHaveBeenCalledWith(agent, '/goal pause', [], expect.any(AbortSignal))
    await expect(service.issueCommand(owner, chat.id, { command: '/unknown', expected_revision: 0, request_key: 'unknown-1' })).rejects.toMatchObject({ status: 400 })
    await expect(service.issueCommand(owner, chat.id, { command: '/plan', expected_revision: 9, request_key: 'plan-1' })).rejects.toMatchObject({ status: 409 })
  })
})


describe('explicit resource mentions', () => {
  const inlineTool = { id: 'personal:mcp:douyin:lookup', runtime_name: 'personal_douyin_lookup',
    version: 'v1', scope: 'personal', provider: 'personal:mcp:douyin', provider_name: '抖音',
    provider_call_name: 'douyin', server_id: 'douyin', tool_name: 'lookup',
    description: '查询视频', inputSchema: { type: 'object', properties: {} } }

  it.each(['queue', 'steer'])('preserves inline plugin binding through native %s, receipt replay and retry', async mode => {
    const { service, owner, chat, platformClient, sessionController, database } = setup()
    platformClient.json.mockResolvedValue({ tools: [inlineTool] })
    sessionController.prompt.mockRejectedValueOnce(new Error('offline'))
    const body = { query: '请搜索视频', mode, request_key: `inline-${mode}`,
      resource_mentions: { plugins: ['douyin'] }, mention_positions: [{ kind: 'tools', id: 'douyin', offset: 1 }] }
    const failed = await service.submitRun(owner, chat.id, body)
    expect(failed.status).toBe('failed')
    expect(sessionController.prompt.mock.calls[0][0].content[0].text).toBe('请【插件：douyin】搜索视频')
    expect(database.getRun(owner.ownerId, failed.id).query).toBe(body.query)
    await service.submitRun(owner, chat.id, body)
    expect(sessionController.prompt).toHaveBeenCalledOnce()
    await service.submitRun(owner, chat.id, { ...body, request_key: 'retry-inline', retry_of: failed.id })
    expect(sessionController.prompt.mock.calls[1][0].content).toEqual(sessionController.prompt.mock.calls[0][0].content)
  })

  it.each(['plan', 'goal'])('places the plugin beside the requested action in native %s commands', async command => {
    const { service, owner, chat, platformClient, commands, database } = setup()
    platformClient.json.mockResolvedValue({ tools: [inlineTool] })
    const result = await service.issueCommand(owner, chat.id, { command: `/${command} 请搜索视频`, request_key: `inline-${command}`,
      resource_mentions: { plugins: ['douyin'] }, mention_positions: [{ kind: 'tools', id: 'douyin', offset: 1 }] })
    expect(commands.execute.mock.calls[0][1]).toContain(command === 'goal' ? '/goal 请搜索视频' : '/plan 请【插件：douyin】搜索视频')
    const run = database.getRun(owner.ownerId, result.run.id)
    expect(run.query).toBe('请搜索视频')
    expect(run.selection.resource_context).toContain('douyin')
  })

  it('updates inline queue positions only after native acceptance and removes stale offsets', async () => {
    const { service, owner, chat, platformClient, sessionController, database } = setup()
    platformClient.json.mockResolvedValue({ tools: [inlineTool] })
    const run = await service.submitRun(owner, chat.id, { query: '请搜索视频',
      resource_mentions: { plugins: ['douyin'] }, mention_positions: [{ kind: 'tools', id: 'douyin', offset: 1 }] })
    database.adoptInboxMessage(chat.sessionId, run.id, 'native-inline')
    const edit = { content: [{ type: 'text', text: '请先搜索视频' }], mention_positions: [{ kind: 'tools', id: 'douyin', offset: 2 }] }
    sessionController.updateQueue.mockRejectedValueOnce(new Error('already claimed'))
    await expect(service.editQueued(owner, run.id, edit)).rejects.toThrow('already claimed')
    expect(service.getRun(owner, run.id).mentioned_resources[0].offset).toBe(1)
    await service.editQueued(owner, run.id, edit)
    expect(sessionController.updateQueue.mock.calls.at(-1)[0].action.content[0].text).toBe('请先【插件：douyin】搜索视频')
    expect(service.getRun(owner, run.id).mentioned_resources[0].offset).toBe(2)
    await service.editQueued(owner, run.id, { content: [{ type: 'text', text: '搜索其他视频' }] })
    expect(sessionController.updateQueue.mock.calls.at(-1)[0].action.content[0].text).toBe('搜索其他视频')
    expect(service.getRun(owner, run.id).mentioned_resources[0].offset).toBeUndefined()
  })

  it('passes an explicitly mentioned plugin name as a preference without changing availability', async () => {
    const { service, owner, chat, platformClient, sessionController, database } = setup()
    const tool = { id: 'personal:mcp:gaode:maps_direction_bicycling', runtime_name: 'personal_gaode_maps_direction_bicycling',
      version: 'v1', scope: 'personal', provider: 'personal:mcp:gaode', provider_name: '高德地图', server_id: 'gaode', tool_name: 'maps_direction_bicycling',
      description: 'Route by bicycle', inputSchema: { type: 'object', properties: {} } }
    platformClient.json.mockResolvedValue({ tools: [tool] })
    const run = await service.submitRun(owner, chat.id, {
      query: '规划骑行路线', resource_mentions: { tools: [tool.id] },
    })
    const frozen = database.getRun(owner.ownerId, run.id).mcpTools
    expect(frozen).toHaveLength(1)
    expect(frozen[0].id).toBe(tool.id)
    expect(sessionController.prompt.mock.calls[0][0].content[1].text).toContain('高德地图')
    expect(sessionController.prompt.mock.calls[0][0].content[1].text).not.toContain('maps_direction_bicycling')
    expect(database.getChat(owner.ownerId, chat.id).selection.tools ?? []).toEqual([])
  })

  it('mentions a plugin with multiple child tools only once by its top-level name', async () => {
    const { service, owner, chat, platformClient, sessionController, database } = setup()
    const tools = ['maps_geo', 'maps_direction_driving'].map(toolName => ({
      id: `personal:mcp:gaode:${toolName}`, runtime_name: `personal_gaode_${toolName}`,
      version: 'v1', scope: 'personal', provider: 'personal:mcp:gaode', provider_name: '高德地图',
      server_id: 'gaode', tool_name: toolName, description: toolName, inputSchema: { type: 'object' },
    }))
    platformClient.json.mockResolvedValue({ tools })
    const run = await service.submitRun(owner, chat.id, {
      query: '开车怎么走', resource_mentions: { tools: tools.map(tool => tool.id) },
    })
    expect(database.getRun(owner.ownerId, run.id).mcpTools).toHaveLength(2)
    const hint = sessionController.prompt.mock.calls[0][0].content[1].text
    expect(hint.match(/高德地图/g)).toHaveLength(1)
    expect(hint).not.toContain('maps_geo')
    expect(hint).not.toContain('maps_direction_driving')
  })

  it('sends a native skill gesture only when the skill is user-invocable', async () => {
    const { service, owner, chat, sessionController, skills, agent } = setup()
    skills.list.mockResolvedValue([{ name: 'manual', invocation: { modelInvocable: false, userInvocable: true } }])
    await service.submitRun(owner, chat.id, { query: 'run', resource_mentions: { skills: ['manual'] } })
    expect(sessionController.prompt.mock.calls[0][0].content.at(-1).text).toBe('/manual')
    expect(skills.list).toHaveBeenCalledWith(expect.objectContaining({ scope: agent, cwd: '/workspace/current' }))
    skills.list.mockResolvedValue([{ name: 'manual', invocation: { modelInvocable: true, userInvocable: false } }])
    await expect(service.submitRun(owner, chat.id, { query: 'run again', resource_mentions: { skills: ['manual'] } })).rejects.toMatchObject({ status: 409 })
  })

  it('delivers selected plugin and skill instructions without changing user text or title, and retains them on fork', async () => {
    const { service, owner, chat, database, sessionController, skills } = setup()
    const tool = { id: 'law', runtime_name: 'global_law_search', provider: 'global:mcp:law', provider_name: '法律检索', name: '检索' }
    vi.spyOn(service, 'freezeMcpCatalog').mockResolvedValue({ tools: [tool], servers: [] })
    skills.list.mockResolvedValue([{ name: 'legal-review', description: '审查', invocation: { userInvocable: true, modelInvocable: true } }])
    const mentions = { tools: ['law'], plugins: [], skills: ['legal-review'], knowledge: [] }
    const run = await service.submitRun(owner, chat.id, { query: '融资租赁', resource_mentions: mentions })
    expect(run.query).toBe('融资租赁')
    expect(run.resource_mentions).toEqual(mentions)
    expect(database.getChat(owner.ownerId, chat.id).title).toBe('新会话')
    const content = sessionController.prompt.mock.calls[0][0].content
    expect(content[0].text).toBe('融资租赁')
    expect(content[1].text).toContain('法律检索')
    expect(content[2].text).toBe('/legal-review')
    expect(content[1].text).not.toContain('global_law_search')
    expect(content).toHaveLength(3)
    database.bindRunMessage(chat.sessionId, run.id, 1, 'm1')
    database.transitionRun(owner.ownerId, run.id, 'completed')
    database.setRunSourceSeq(owner.ownerId, run.id, 'source_end_seq', 9)
    const child = await service.fork(owner, run.id, { request_key: 'resource-fork' })
    expect(child.runs[0].resource_mentions).toEqual(mentions)
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
  })

  it('returns the original mentions on receipt replay and preserves them on an explicit retry', async () => {
    const { service, owner, chat, sessionController, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'legal-review', invocation: { userInvocable: true, modelInvocable: true } }])
    sessionController.prompt.mockRejectedValueOnce(new Error('offline'))
    const body = { query: '核对', request_key: 'mention-retry', resource_mentions: { skills: ['legal-review'] } }
    const failed = await service.submitRun(owner, chat.id, body)
    expect(failed.status).toBe('failed')
    await expect(service.submitRun(owner, chat.id, { ...body, resource_mentions: {} })).resolves.toMatchObject({ id: failed.id, status: 'failed' })
    const retried = await service.submitRun(owner, chat.id, body)
    expect(retried.id).toBe(failed.id)
    expect(retried.status).toBe('failed')
    await service.submitRun(owner, chat.id, { ...body, request_key: 'retry-next', retry_of: failed.id })
    expect(sessionController.prompt.mock.calls[1][0].content).toEqual(sessionController.prompt.mock.calls[0][0].content)
    expect(service.getRun(owner, retried.id).resource_mentions.skills).toEqual(['legal-review'])
  })

  it('does not turn available resources into explicit requests and rejects unavailable mentions', async () => {
    const { service, owner, chat, sessionController } = setup()
    const ordinary = await service.submitRun(owner, chat.id, { query: '你好' })
    expect(ordinary.resource_mentions).toEqual({ tools: [], plugins: [], skills: [], knowledge: [] })
    expect(sessionController.prompt.mock.calls[0][0].content).toEqual([{ type: 'text', text: '你好' }])
    await expect(service.submitRun(owner, chat.id, { query: '检索', resource_mentions: { tools: ['missing'] } })).rejects.toMatchObject({ status: 409 })
    await expect(service.submitRun(owner, chat.id, { query: '审查', resource_mentions: { skills: ['missing'] } })).rejects.toMatchObject({ status: 409 })
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
  })
})


describe('submission cancellation', () => {
  it.each([
    ['unsettled native bash', 'bash', undefined, true],
    ['unsettled native tool', 'write', undefined, true],
    ['text only', undefined, undefined, false],
    ['completed native bash', 'bash', {}, false],
    ['skipped before dispatch', 'bash', { name: 'AbortError', code: 'TOOL_ABORTED_BEFORE_DISPATCH' }, false],
  ])('reports native uncertainty for %s', async (_label, toolName, resultError, uncertain) => {
    const test = setup()
    const { service, owner, chat, database } = test
    const run = await service.submitRun(owner, chat.id, { query: 'active' })
    activateNative(test, run.id)
    if (toolName) projectSessionEvent(database, chat.sessionId, { type: 'tool/call', data: { turn: 1, callId: 'native-call', name: toolName, arguments: {} } })
    if (resultError) projectSessionEvent(database, chat.sessionId, { type: 'tool/result', data: {
      turn: 1, error: resultError.code ? resultError : undefined,
      message: { source: { callId: 'native-call' }, content: [{ toolCallId: 'native-call', content: [{ type: 'text', text: 'settled' }] }] },
    } })
    // A worker count is not evidence of a dispatched native tool.
    service.platformClient = { json: async () => ({ data: { fenced: true, uncertain: false, stopped: 9 } }) }
    const confirmation = { fenced: true, uncertain }
    await expect(service.stopRun(owner, run.id)).resolves.toMatchObject({ stop_confirmation: confirmation })
    expect(service.getRun(owner, run.id).stop_confirmation).toEqual(confirmation)
    expect(database.allEvents(owner.ownerId, run.id)).toContainEqual(expect.objectContaining({ event: 'workbench_stop_confirmation', stop_confirmation: confirmation }))
  })

  it('checks native settlement after the external fence finishes', async () => {
    const test = setup()
    const { service, owner, chat, database } = test
    const run = await service.submitRun(owner, chat.id, { query: 'active' })
    activateNative(test, run.id)
    projectSessionEvent(database, chat.sessionId, { type: 'tool/call', data: { turn: 1, callId: 'native-call', name: 'bash', arguments: {} } })
    let confirm
    service.platformClient = { json: () => new Promise(resolve => { confirm = resolve }) }
    const stopping = service.stopRun(owner, run.id)
    projectSessionEvent(database, chat.sessionId, { type: 'tool/result', data: {
      turn: 1, message: { source: { callId: 'native-call' }, content: [{ toolCallId: 'native-call', content: [{ type: 'text', text: 'done' }] }] },
    } })
    confirm({ data: { fenced: true, uncertain: false } })
    await expect(stopping).resolves.toMatchObject({ stop_confirmation: { fenced: true, uncertain: false } })
  })

  it('cancels native execution immediately and waits for the MCP fence confirmation', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const run = await service.submitRun(owner, chat.id, { query: 'active' })
    database.transitionRun(owner.ownerId, run.id, 'running')
    let confirm
    const requests = []
    service.platformClient = { json: request => {
      requests.push(request)
      return new Promise(resolve => { confirm = resolve })
    } }
    let completed = false
    const stopping = service.stopRun(owner, run.id).then(result => { completed = true; return result })
    expect(sessionController.cancel).toHaveBeenCalledWith({ sessionId: chat.sessionId })
    expect(completed).toBe(false)
    expect(requests[0].route).toBe('mcp/cancel')
    expect(JSON.parse(requests[0].body)).toEqual({ run_id: run.id })
    confirm({ data: { fenced: true, uncertain: true } })
    await expect(stopping).resolves.toMatchObject({ stop_confirmation: { fenced: true, uncertain: true } })
    expect(service.getRun(owner, run.id).stop_confirmation).toEqual({ fenced: true, uncertain: true })
    expect(service.followups(owner, chat.id, [run.id]).runs[0].stop_confirmation).toEqual({ fenced: true, uncertain: true })
    expect(database.allEvents(owner.ownerId, run.id)).toContainEqual(expect.objectContaining({ event: 'workbench_stop_confirmation', stop_confirmation: { fenced: true, uncertain: true } }))
    database.confirmRunFence(owner.ownerId, run.id, { fenced: true, uncertain: false })
    expect(service.getRun(owner, run.id).stop_confirmation.uncertain).toBe(true)
  })

  it('reports an unconfirmed external cancellation and permits retrying the fence', async () => {
    const { service, owner, chat, database } = setup()
    const run = await service.submitRun(owner, chat.id, { query: 'active' })
    database.transitionRun(owner.ownerId, run.id, 'running')
    service.platformClient = { json: vi.fn().mockRejectedValueOnce(new Error('manager offline')).mockResolvedValue({ data: { fenced: true } }) }
    await expect(service.stopRun(owner, run.id)).rejects.toMatchObject({ status: 503, code: 'CANCEL_UNCONFIRMED' })
    await expect(service.stopRun(owner, run.id)).resolves.toMatchObject({ stop_confirmation: { fenced: true } })
  })

  it('keeps the conversation when fencing fails even if its native agent is absent', async () => {
    const { service, owner, chat, database, agents, fileManager } = setup()
    const run = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'crashed', selection: {} }).run
    database.transitionRun(owner.ownerId, run.id, 'running')
    database.saveSubmission(owner.ownerId, run.id, [])
    database.dispatchSubmission(owner.ownerId, run.id)
    agents.get.mockReturnValue(undefined)
    service.platformClient = { json: vi.fn().mockRejectedValue(new Error('manager unavailable')) }
    await expect(service.deleteChat(owner, chat.id)).rejects.toMatchObject({ status: 503, code: 'CANCEL_UNCONFIRMED' })
    expect(database.getChat(owner.ownerId, chat.id)).toBeDefined()
    expect(database.pendingRunFences(owner.ownerId).map(value => value.id)).toContain(run.id)
    expect(fileManager.operate.mock.calls.some(([request]) => request.operation === 'delete')).toBe(false)
  })

  it('cancels the native Session despite a stale terminal cache and retains its inbox', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const run = await service.submitRun(owner, chat.id, { query: 'active', request_key: 'native' })
    database.transitionRun(owner.ownerId, run.id, 'completed')
    await service.stopSubmission(owner, chat.id, 'native')
    expect(sessionController.cancel).toHaveBeenCalledWith({ sessionId: chat.sessionId })
    expect(sessionController.updateQueue).not.toHaveBeenCalled()
    expect(database.getCommandReceipt(owner.ownerId, chat.id, 'run-stop:native')).toBeUndefined()
    expect(database.getRun(owner.ownerId, run.id).status).toBe('completed')
  })
  it('persists cancellation before admission and checks ownership', async () => {
    const { service, owner, chat, sessionController } = setup()
    await expect(service.stopSubmission({ ...owner, ownerId: 'other:user' }, chat.id, 'request-a')).rejects.toMatchObject({ status: 404 })
    await expect(service.stopSubmission(owner, chat.id, 'request-a')).resolves.toMatchObject({ accepted: true })
    await expect(service.submitRun(owner, chat.id, { query: 'late', request_key: 'request-a' })).rejects.toMatchObject({ status: 409 })
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })
  it('cancels during slow tool discovery before any prompt is dispatched', async () => {
    const { service, owner, chat, sessionController } = setup()
    let release
    service.freezeMcpCatalog = vi.fn(() => new Promise(resolve => { release = () => resolve({ tools: [], servers: [] }) }))
    const submission = service.submitRun(owner, chat.id, { query: 'slow', request_key: 'slow-key' })
    const rejected = expect(submission).rejects.toMatchObject({ status: 409 })
    await vi.waitFor(() => expect(service.freezeMcpCatalog).toHaveBeenCalled())
    await service.stopSubmission(owner, chat.id, 'slow-key')
    release([])
    await rejected
    expect(sessionController.prompt).not.toHaveBeenCalled()
  })
  it('does not report cancelled when the engine refuses the stop', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const run = await service.submitRun(owner, chat.id, { query: 'active' })
    database.transitionRun(owner.ownerId, run.id, 'running')
    sessionController.cancel.mockImplementationOnce(() => { throw new Error('unavailable') })
    await expect(service.stopRun(owner, run.id)).rejects.toThrow()
    expect(service.getRun(owner, run.id).status).toBe('running')
    expect((await service.stopRun(owner, run.id)).status).toBe('running')
  })
})


describe('forked conversations', () => {
  it('keeps historical tool names across paged forks without inheriting pending execution', async () => {
    const { service, owner, database, second, sessionController } = history()
    database.startToolCall(owner.ownerId, second.id, 'split-call', 'ask_user_question')
    const child = await service.fork(owner, second.id, { request_key: 'tool-page' })
    const childSession = database.getChat(owner.ownerId, child.id).sessionId
    const records = [{ type: 'event', event: { seq: 18, type: 'tool/result', data: { turn: 2,
      message: { source: { callId: 'split-call' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '{"answers":[]}' }] }] },
    } } }]
    sessionController.page = vi.fn(async () => ({ records, hasMore: false }))
    const page = await service.historyPage(owner, child.id, { sessionId: childSession, throughSeq: 19, beforeSeq: 19 }, new AbortController().signal)
    expect(page.runs[0].events[0].data.tool_name).toBe('ask_user_question')
    expect(database.db.prepare('SELECT status FROM tool_calls WHERE run_id=? AND call_id=?')
      .get(child.runs[1].id, 'split-call').status).toBe('finished')
    expect(database.db.prepare('SELECT status FROM tool_calls WHERE run_id=? AND call_id=?')
      .get(second.id, 'split-call').status).toBe('started')
  })
  function history() {
    const context = setup()
    const { database, owner, chat } = context
    const make = (query, parent, turn, end) => {
      const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query, selection: { model: 'p/m' }, parentRunId: parent?.id, now: turn * 10000 })
      database.bindRunMessage(chat.sessionId, run.id, turn, `message-${turn}`)
      database.setRunSourceSeq(owner.ownerId, run.id, 'source_end_seq', end)
      database.appendEvent(owner.ownerId, run.id, { event: 'workbench_status', status: 'running' }, turn * 10000 + 1000)
      database.appendEvent(owner.ownerId, run.id, { event: 'message', answer: `answer ${query}` }, turn * 10000 + 2000)
      database.transitionRun(owner.ownerId, run.id, 'completed', undefined, turn * 10000 + 6000)
      database.appendEvent(owner.ownerId, run.id, { event: 'workbench_end', status: 'completed' }, turn * 10000 + 6000)
      return run
    }
    const first = make('first', null, 1, 9)
    const second = make('second', first, 2, 19)
    const third = make('third', second, 3, 29)
    return { ...context, first, second, third }
  }

  it('forks at the selected answer, preserves history and continues in the new session', async () => {
    const { service, owner, chat, database, sessionController, second } = history()
    const original = service.getChat(owner, chat.id)
    const child = await service.fork(owner, second.id, { request_key: 'fork-1' })
    expect(sessionController.fork).toHaveBeenCalledWith({ sessionId: chat.sessionId, atSeq: 19 })
    expect(child.id).not.toBe(chat.id)
    expect(child.runs.map(run => run.query)).toEqual(['first', 'second'])
    expect(child.runs[1].parent_run_id).toBe(child.runs[0].id)
    expect(child.runs[1].events).toEqual([])
    expect(service.getRun(owner, child.runs[1].id, true).events).toEqual(expect.arrayContaining([expect.objectContaining({ answer: 'answer second' })]))
    expect(service.getChat(owner, chat.id)).toEqual(original)
    expect(database.getChat(owner.ownerId, chat.id).sessionId).toBe('session-1')
    const followup = await service.submitRun(owner, child.id, { query: 'followup' })
    expect(followup.parent_run_id).toBe(child.runs[1].id)
    expect(sessionController.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-fork', requestId: followup.id }), expect.any(AbortSignal))
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
    const retry = await service.fork(owner, second.id, { request_key: 'fork-1' })
    expect(retry.id).toBe(child.id)
    expect(sessionController.fork).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['xxx', 'xxx (1)'],
    ['xxx (1)', 'xxx (2)'],
    ['xxx（9）', 'xxx（10）'],
    ['xxx (9007199254740992)', 'xxx (9007199254740993)'],
  ])('uses the DSH fork title rule for %s', async (title, expected) => {
    const { service, owner, chat, database, sessionController, second } = history()
    database.updateChat(owner.ownerId, chat.id, { title })
    const child = await service.fork(owner, second.id, { request_key: 'title-fork' })
    expect(child.title).toBe(expected)
    expect(sessionController.rename).toHaveBeenCalledWith({ sessionId: 'session-fork', title: expected })
    expect(service.getChat(owner, chat.id).title).toBe(title)
  })

  it('returns a small fork receipt while preserving large historical tool output for paged reads', async () => {
    const { service, owner, database, second } = history()
    database.appendEvent(owner.ownerId, second.id, { event: 'workbench_activity', data: { kind: 'tool', output: 'x'.repeat(4 * 1024 * 1024) } })
    const child = await service.fork(owner, second.id, { request_key: 'large-history' })
    expect(Buffer.byteLength(JSON.stringify(child))).toBeLessThan(64 * 1024)
    expect(child.runs.every(run => run.events.length === 0 && run.history_complete === false)).toBe(true)
    expect(service.getRun(owner, child.runs[1].id, true).events.some(event => event.data?.output?.length === 4 * 1024 * 1024)).toBe(true)
    expect(await service.fork(owner, second.id, { request_key: 'large-history' })).toEqual(child)
  })

  it('uses native fork even with sessionQuery and inherits the source directory', async () => {
    const { service, owner, chat, agents, second, sessionController } = history()
    const events = [{ seq: 0 }, { seq: 19 }, { seq: 20 }]
    const dispose = vi.fn()
    service.sessionQuery = { observeSession: vi.fn(async () => ({ header: { agentPreset: 'standard', cwd: `/workspace/conversations/${chat.id}` }, events, [Symbol.dispose]: dispose })) }
    service.agentPresets = { resolve: vi.fn(async () => ({ id: 'standard' })), mount: vi.fn() }
    service.agentDefaultModel = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    agents.create = vi.fn()
    const child = await service.fork(owner, second.id, { request_key: 'seed' })
    expect(agents.create).not.toHaveBeenCalled()
    expect(sessionController.fork).toHaveBeenCalledWith({ sessionId: chat.sessionId, atSeq: 19 })
    expect(child.file_directory).toBe(`conversations/${chat.id}`)
    const childChat = service.requireChat(owner, child.id)
    agents.get.mockReturnValue({ session: { header: { cwd: `/workspace/conversations/${chat.id}` } } })
    await service.ensureChatSession(owner, childChat)
    expect(agents.create).not.toHaveBeenCalled()
    expect(sessionController.prompt).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not delete a workspace still referenced by a native fork', async () => {
    const { service, owner, chat, second, fileManager } = history()
    const child = await service.fork(owner, second.id, { request_key: 'shared' })
    fileManager.operate.mockClear()
    await service.deleteChat(owner, chat.id)
    expect(fileManager.operate).not.toHaveBeenCalled()
    expect(service.getChat(owner, child.id).file_directory).toBe(`conversations/${chat.id}`)
  })

  it.each(['conversations/2026-10-18/original', 'conversations/案件材料'])('keeps %s for every fork and its following prompt', async directory => {
    const { service, owner, chat, database, agents, second, sessionController } = history()
    database.updateChat(owner.ownerId, chat.id, { directory })
    const cwd = `/workspace/${directory}`
    service.sessionQuery = { observeSession: vi.fn(async () => ({ header: { cwd }, [Symbol.dispose]() {} })) }
    sessionController.fork.mockResolvedValueOnce({ sessionId: 'fork-a' }).mockResolvedValueOnce({ sessionId: 'fork-b' })
    const first = await service.fork(owner, second.id, { request_key: 'first' })
    const next = await service.fork(owner, first.runs[1].id, { request_key: 'next' })
    expect(first.file_directory).toBe(directory)
    expect(next.file_directory).toBe(directory)
    agents.get.mockReturnValue({ session: { header: { cwd } } })
    await service.submitRun(owner, next.id, { query: '继续处理同一目录' })
    expect(sessionController.prompt).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'fork-b' }), expect.any(AbortSignal))
    expect(service.fileManager.operate).toHaveBeenCalledWith({ operation: 'list', path: directory })
    expect(service.requireChat(owner, next.id).directory).toBe(directory)
  })

  it('hides cached change announcements in existing fork history without losing files or new comparisons', async () => {
    const { service, owner, database, second, sessionController } = history()
    database.appendEvent(owner.ownerId, second.id, { event: 'workbench_changes', turn: 2, source_seq: 18 })
    database.appendEvent(owner.ownerId, second.id, { event: 'workbench_presented', files: [{ path: 'report.md' }] })
    sessionController.fork.mockResolvedValueOnce({ sessionId: 'fork-a' }).mockResolvedValueOnce({ sessionId: 'fork-b' })
    const first = await service.fork(owner, second.id, { request_key: 'first' })
    const next = await service.fork(owner, first.runs[1].id, { request_key: 'next' })
    for (const inherited of [first.runs[1], next.runs[1]]) {
      // Exercise old durable rows as well as newly forked conversations.
      expect(database.allEvents(owner.ownerId, inherited.id).some(event => event.event === 'workbench_changes')).toBe(true)
      const events = service.getRun(owner, inherited.id, true).events
      expect(events.some(event => event.event === 'workbench_changes')).toBe(false)
      expect(events.some(event => event.event === 'workbench_presented')).toBe(true)
    }
    expect(service.getRun(owner, second.id, true).events.some(event => event.event === 'workbench_changes')).toBe(true)
    const own = await service.submitRun(owner, next.id, { query: '新的修改' })
    database.appendEvent(owner.ownerId, own.id, { event: 'workbench_changes', turn: 3, source_seq: 30 })
    expect(service.getRun(owner, own.id, true).events.some(event => event.event === 'workbench_changes')).toBe(true)
  })

  it('can fork inherited answers again and keeps original event boundaries', async () => {
    const { service, owner, second, sessionController } = history()
    sessionController.fork.mockResolvedValueOnce({ sessionId: 'child-1' }).mockResolvedValueOnce({ sessionId: 'child-2' })
    const child = await service.fork(owner, second.id, { request_key: 'a' })
    const grandchild = await service.fork(owner, child.runs[0].id, { request_key: 'b' })
    expect(grandchild.runs.map(run => run.query)).toEqual(['first'])
    expect(sessionController.fork).toHaveBeenLastCalledWith({ sessionId: 'child-1', atSeq: 9 })
  })

  it('reforks the current session after the original was deleted and the fork moved workspace', async () => {
    const { service, owner, chat, database, second, sessionController } = history()
    sessionController.fork.mockResolvedValueOnce({ sessionId: 'child-1' }).mockResolvedValueOnce({ sessionId: 'child-2' })
    const first = await service.fork(owner, second.id, { request_key: 'a' })
    database.db.prepare('UPDATE chats SET deleted_at = 1 WHERE id = ?').run(chat.id)
    database.updateChat(owner.ownerId, first.id, { directory: 'cases/moved' })
    service.sessionQuery = { observeSession: vi.fn(async id => {
      if (id !== 'child-1') throw new Error('original session unavailable')
      return { header: { cwd: '/workspace/cases/moved' }, [Symbol.dispose]() {} }
    }) }
    const next = await service.fork(owner, first.runs[0].id, { request_key: 'b' })
    expect(next.file_directory).toBe('cases/moved')
    expect(next.runs.map(run => run.query)).toEqual(['first'])
    expect(sessionController.fork).toHaveBeenLastCalledWith({ sessionId: 'child-1', atSeq: 9 })
  })

  it('remaps platform identities without rewriting literal message text or question answers', async () => {
    const { service, owner, database, first, second } = history()
    database.appendEvent(owner.ownerId, second.id, { event: 'message', answer: first.id })
    database.appendEvent(owner.ownerId, second.id, { event: 'workbench_activity', data: {
      workbench_run_id: second.id, kind: 'tool', input: { request_id: first.id }, output: first.id,
    } })
    database.createPendingInput(owner.ownerId, second.id, { requestId: 'literal-answer', payload: { tool_name: 'ask_user_question', questions: [{ id: 'q', question: first.id }] } })
    database.settlePendingInput(owner.ownerId, second.id, 'literal-answer', 'submitted', { answers: [{ id: 'q', selected: [], custom: first.id }] })
    database.transitionRun(owner.ownerId, second.id, 'completed')
    const child = await service.fork(owner, second.id, { request_key: 'literal-ids' })
    const copy = service.getRun(owner, child.runs[1].id, true)
    expect(copy.events).toContainEqual(expect.objectContaining({ event: 'message', answer: first.id }))
    expect(copy.events).toContainEqual(expect.objectContaining({ data: {
      workbench_run_id: copy.id, kind: 'tool', input: { request_id: first.id }, output: first.id,
    } }))
    const [input] = database.listPendingInputs(owner.ownerId, copy.id)
    expect(input.payload.questions[0].question).toBe(first.id)
    expect(input.answer.answers[0].custom).toBe(first.id)
  })

  it('revalidates a source that resumed while waiting for the conversation lock', async () => {
    const { service, owner, database, chat, second, sessionController } = history()
    let release
    const held = service.withChatMutation(chat.id, () => new Promise(resolve => { release = resolve }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const pending = service.fork(owner, second.id, { request_key: 'changed-source' })
    database.transitionRun(owner.ownerId, second.id, 'running')
    release()
    await held
    await expect(pending).rejects.toMatchObject({ status: 409 })
    expect(sessionController.fork).not.toHaveBeenCalled()
  })

  it.each(['submitted', 'skipped', 'timeout', 'aborted'])('preserves settled %s question history when forking', async status => {
    const { service, owner, database, second } = history()
    const answer = status === 'submitted' ? { answers: [{ id: 'question', selected: ['yes'], custom: '保留这份答复' }] } : null
    database.createPendingInput(owner.ownerId, second.id, { requestId: 'question-request', payload: { tool_name: 'ask_user_question', questions: [{ id: 'question', question: '继续吗' }] } })
    database.settlePendingInput(owner.ownerId, second.id, 'question-request', status, answer)
    database.transitionRun(owner.ownerId, second.id, 'completed')
    const child = await service.fork(owner, second.id, { request_key: 'question' })
    const copied = database.listPendingInputs(owner.ownerId, child.runs[1].id)
    expect(copied).toHaveLength(1)
    expect(copied[0]).toMatchObject({ status, answer })
    expect(copied[0].requestId).not.toBe('question-request')
  })

  it('does not carry source turn execution flags into the fork conversation or its next prompt', async () => {
    const { service, owner, database, second } = history()
    const selected = { model: 'p/m', tools: [], skills: [], knowledge: [], model_parameters: {}, tool_parameters: {} }
    database.updateRunResources(second, { ...selected, command: 'goal', is_continuation: true, native_notice: true,
      native_source: 'schedule', schedule_titles: ['原定时任务'], prompt_mode: 'steer', silent_resume: true }, [])
    const child = await service.fork(owner, second.id, { request_key: 'fresh-flags' })
    expect(child.selection).toEqual(selected)
    const own = await service.submitRun(owner, child.id, { query: '新的普通消息' })
    expect(own.command).toBeUndefined()
    expect(own.is_continuation).toBeUndefined()
    expect(own.source).toBeUndefined()
    expect(child.runs[1]).toMatchObject({ command: 'goal', is_continuation: true, source: { kind: 'schedule' } })
  })

  it.each([false, true])('retains a late question supplement only when its turn is inside the fork (included=%s)', async included => {
    const { service, owner, database, first, second } = history()
    database.createPendingInput(owner.ownerId, first.id, { requestId: 'question', payload: { tool_name: 'ask_user_question' } })
    database.settlePendingInput(owner.ownerId, first.id, 'question', 'skipped', null)
    database.transitionRun(owner.ownerId, first.id, 'completed')
    database.recordInputSupplement(owner.ownerId, first.id, 'question', { supplement_run_id: second.id, answers: ['保留的补答'] })
    const child = await service.fork(owner, included ? second.id : first.id, { request_key: 'supplement-cut' })
    const [question] = database.listPendingInputs(owner.ownerId, child.runs[0].id)
    expect(question.status).toBe(included ? 'submitted' : 'skipped')
    expect(question.answer).toEqual(included ? { supplement_run_id: child.runs[1].id, answers: ['保留的补答'] } : null)
    expect(database.getPendingInput(owner.ownerId, first.id).answer.supplement_run_id).toBe(second.id)
  })

  it('closes inherited unresolved question controls without changing the source', async () => {
    const { service, owner, database, second } = history()
    database.createPendingInput(owner.ownerId, second.id, { requestId: 'pending-question', payload: { tool_name: 'ask_user_question' } })
    database.transitionRun(owner.ownerId, second.id, 'interrupted')
    const child = await service.fork(owner, second.id, { request_key: 'pending-cut' })
    expect(database.getPendingInput(owner.ownerId, child.runs[1].id)).toMatchObject({ status: 'skipped', answer: null })
    expect(database.getPendingInput(owner.ownerId, second.id).status).toBe('pending')
  })

  it('keeps intervening turns when a child reply points back to an earlier spawning run', async () => {
    const { service, owner, database, chat, first } = history()
    const { run: notice } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: '子智能体回复', selection: { model: 'p/m', native_notice: true, is_continuation: true }, parentRunId: first.id, now: 40000 })
    database.bindRunMessage(chat.sessionId, notice.id, 4, 'notice-message')
    database.setRunSourceSeq(owner.ownerId, notice.id, 'source_end_seq', 39)
    database.transitionRun(owner.ownerId, notice.id, 'completed')
    const child = await service.fork(owner, notice.id, { request_key: 'notice-prefix' })
    expect(child.runs.map(run => run.query)).toEqual(['first', 'second', 'third', '子智能体回复'])
    expect(child.runs[3].parent_run_id).toBe(child.runs[0].id)
  })

  it('preserves reply text and attachment paths without adopting the original child as a new task', async () => {
    const { service, owner, database, chat, second } = history()
    database.updateRunResources(second, { ...second.selection, subagent_ids: ['child-session'] }, [])
    database.appendEvent(owner.ownerId, second.id, { event: 'workbench_agent_message', sender_session_id: 'child-session', sender_type: 'child', query: '原子智能体回复' })
    const files = [{ name: '材料.pdf', path: `conversations/${chat.id}/材料.pdf` }]
    database.db.prepare('UPDATE runs SET attachments_json=? WHERE id=?').run(JSON.stringify(files), second.id)
    const child = await service.fork(owner, second.id, { request_key: 'child-reply' })
    const inherited = service.getRun(owner, child.runs[1].id, true)
    expect(inherited.attachments).toEqual(files)
    expect(inherited.events).toContainEqual(expect.objectContaining({ event: 'workbench_agent_message', sender_session_id: 'child-session', query: '原子智能体回复' }))
    expect(child.selection.subagent_ids).toBeUndefined()
    const own = await service.submitRun(owner, child.id, { query: '新的工作' })
    expect(database.getRun(owner.ownerId, own.id).selection.subagent_ids).toBeUndefined()
  })

  it('serializes duplicate fork requests into one native session', async () => {
    const { service, owner, second, sessionController } = history()
    const [first, retry] = await Promise.all([
      service.fork(owner, second.id, { request_key: 'concurrent' }),
      service.fork(owner, second.id, { request_key: 'concurrent' }),
    ])
    expect(first.id).toBe(retry.id)
    expect(sessionController.fork).toHaveBeenCalledOnce()
  })

  it('leaves the source and database intact when native fork rejects the selected cut', async () => {
    const { service, owner, database, chat, second, sessionController } = history()
    const original = service.getChat(owner, chat.id)
    sessionController.fork.mockRejectedValueOnce(new Error('source unavailable'))
    await expect(service.fork(owner, second.id, { request_key: 'failed' })).rejects.toThrow('source unavailable')
    expect(database.listChats(owner.ownerId)).toHaveLength(1)
    expect(service.getChat(owner, chat.id)).toEqual(original)
    expect(sessionController.rename).not.toHaveBeenCalled()
    expect((await service.fork(owner, second.id, { request_key: 'failed' })).runs).toHaveLength(2)
  })

  it.each(['rename', 'database'])('reuses the native child when %s fails after creation', async stage => {
    const { service, owner, database, second, sessionController } = history()
    if (stage === 'rename') sessionController.rename.mockRejectedValueOnce(new Error('temporary failure'))
    else vi.spyOn(database, 'importChat').mockImplementationOnce(() => { throw new Error('temporary failure') })
    await expect(service.fork(owner, second.id, { request_key: 'recover' })).rejects.toThrow('temporary failure')
    const child = await service.fork(owner, second.id, { request_key: 'recover' })
    expect(child.runs).toHaveLength(2)
    expect(database.listChats(owner.ownerId)).toHaveLength(2)
    expect(sessionController.fork).toHaveBeenCalledOnce()
  })

  it('does not combine a prepared native cut with a later version of the source answer', async () => {
    const { service, owner, database, second, sessionController } = history()
    sessionController.rename.mockRejectedValueOnce(new Error('rename failed'))
    await expect(service.fork(owner, second.id, { request_key: 'old-cut' })).rejects.toThrow('rename failed')
    database.setRunSourceSeq(owner.ownerId, second.id, 'source_end_seq', 29)
    await expect(service.fork(owner, second.id, { request_key: 'old-cut' })).rejects.toMatchObject({ status: 409 })
    expect(sessionController.fork).toHaveBeenCalledOnce()
  })

  it('rejects a source directory outside the owner workspace before native creation', async () => {
    const { service, owner, second, sessionController } = history()
    service.sessionQuery = { observeSession: vi.fn(async () => ({ header: { cwd: '/another-owner' }, [Symbol.dispose]() {} })) }
    await expect(service.fork(owner, second.id, { request_key: 'outside' })).rejects.toMatchObject({ status: 403 })
    expect(sessionController.fork).not.toHaveBeenCalled()
  })

  it('rejects other owners, unfinished answers and deleted chats', async () => {
    const { service, database, owner, chat, second, sessionController } = history()
    await expect(service.fork({ ownerId: 'other' }, second.id, { request_key: 'x' })).rejects.toMatchObject({ status: 404 })
    database.transitionRun(owner.ownerId, second.id, 'running')
    await expect(service.fork(owner, second.id, { request_key: 'x' })).rejects.toMatchObject({ status: 409 })
    database.transitionRun(owner.ownerId, second.id, 'completed')
    database.db.prepare('UPDATE chats SET deleted_at = 1 WHERE id = ?').run(chat.id)
    await expect(service.fork(owner, second.id, { request_key: 'x' })).rejects.toMatchObject({ status: 404 })
    expect(sessionController.fork).not.toHaveBeenCalled()
  })

  it('reports execution duration without queue delay or later feedback edits', () => {
    const { service, database, owner, second } = history()
    const before = service.getRun(owner, second.id)
    expect(before).toMatchObject({ created_at: 20, started_at: 21, completed_at: 26, elapsed_seconds: 5, can_fork: true })
    database.setFeedback(owner.ownerId, second.id, 'like', 99000)
    expect(service.getRun(owner, second.id)).toMatchObject({ created_at: 20, completed_at: 26, elapsed_seconds: 5 })
  })
})

describe('native queue edit', () => {
  it('rebuilds native skill gestures when editing text with selected resources', async () => {
    const { service, database, owner, chat, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'selected', invocation: { userInvocable: true, modelInvocable: false } }])
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'before', selection: { resource_mentions: { skills: ['selected'] } } })
    const hint = { type: 'text', text: '/selected' }
    database.saveSubmission(owner.ownerId, run.id, [{ type: 'text', text: 'before' }, hint])
    await service.editQueued(owner, run.id, { content: [{ type: 'text', text: 'after' }] })
    expect(database.submission(owner.ownerId, run.id).content).toEqual([{ type: 'text', text: 'after' }, hint])
    await service.editQueued(owner, run.id, { content: [{ type: 'text', text: 'after /selected' }] })
    expect(database.submission(owner.ownerId, run.id).content).toEqual([{ type: 'text', text: 'after /selected' }])
    skills.list.mockResolvedValue([{ name: 'selected', invocation: { userInvocable: false, modelInvocable: true } }])
    await expect(service.editQueued(owner, run.id, { content: [{ type: 'text', text: 'rejected' }] })).rejects.toMatchObject({ status: 409 })
    expect(database.getRun(owner.ownerId, run.id).query).toBe('after /selected')
  })
  it('edits durable admission content before the native inbox exists and retains the ticket', async () => {
    const { service, database, owner, chat, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'before', selection: {} })
    database.saveSubmission(owner.ownerId, run.id, [{ type: 'text', text: 'before' }])
    const ticketId = database.submission(owner.ownerId, run.id).ticketId
    await service.editQueued(owner, run.id, { content: [{ type: 'text', text: 'after' }] })
    expect(database.submission(owner.ownerId, run.id)).toMatchObject({ ticketId, dispatched: false, content: [{ type: 'text', text: 'after' }] })
    expect(database.getRun(owner.ownerId, run.id).query).toBe('after')
    expect(sessionController.updateQueue).not.toHaveBeenCalled()
  })
  it('edits in place using the native inbox identity without changing ordering', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const run = await service.submitRun(owner, chat.id, { query: 'before' })
    database.adoptInboxMessage(chat.sessionId, run.id, 'native-inbox-id')
    const content = [{ type: 'text', text: 'after' }]
    const edited = await service.editQueued(owner, run.id, { content })
    expect(sessionController.updateQueue).toHaveBeenCalledWith({ sessionId: chat.sessionId, itemId: 'native-inbox-id', action: { kind: 'edit', content } })
    expect(edited).toMatchObject({ id: run.id, query: 'after', queue_order: run.queue_order })
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
  })
  it('does not update the cache when DSH says the message has already been claimed', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const run = await service.submitRun(owner, chat.id, { query: 'before' })
    database.adoptInboxMessage(chat.sessionId, run.id, 'native-inbox-id')
    sessionController.updateQueue.mockRejectedValue(new Error('session/queue-item-not-found'))
    await expect(service.editQueued(owner, run.id, { content: [{ type: 'text', text: 'after' }] })).rejects.toThrow('session/queue-item-not-found')
    expect(database.getRun(owner.ownerId, run.id).query).toBe('before')
    await expect(service.editQueued({ ownerId: 'foreign' }, run.id, { content: [] })).rejects.toMatchObject({ status: 404 })
  })
})

it('serves only the owning session native summary and strips host metadata',async()=>{
  const {service,owner,chat}=setup()
  const summary={turn:1,files:[],total:0,added:0,deleted:0,cwd:'/private',snapshot:{before:'a',after:'b'}}
  service.workspaceChanges={summary:vi.fn(()=>summary),diff:vi.fn(async()=>({kind:'text',hunks:[]}))}
  expect(await service.changes(owner,chat.id,'10',null)).toEqual({turn:1,files:[],total:0,added:0,deleted:0})
  expect(service.workspaceChanges.summary).toHaveBeenCalledWith(chat.sessionId,10)
  const signal=new AbortController().signal
  await service.changes(owner,chat.id,'10','0',signal)
  expect(service.workspaceChanges.diff).toHaveBeenCalledWith(chat.sessionId,10,0,signal)
  await expect(service.changes({...owner,ownerId:'other'},chat.id,'10',null)).rejects.toMatchObject({status:404})
  await expect(service.changes(owner,chat.id,'1e2',null)).rejects.toMatchObject({status:400})
  service.workspaceChanges.summary.mockReturnValue(undefined)
  expect(await service.changes(owner,chat.id,'10',null)).toBeNull()
  service.workspaceChanges.diff.mockResolvedValue(undefined)
  await expect(service.changes(owner,chat.id,'10','0',signal)).rejects.toMatchObject({status:404})
  service.workspaceChanges=undefined
  await expect(service.changes(owner,chat.id,'10',null)).rejects.toMatchObject({status:503})
})

it('resolves review file open paths against the recorded cwd inside the owner workspace',async()=>{
  const {service,owner,chat}=setup();
  service.workspaceChanges={summary:()=>({turn:1,cwd:'/workspace/conversations/original',total:4,added:1,deleted:0,files:[
    {path:'a.ts',display:'a.ts',added:1,deleted:0},
    {path:'../shared.txt',display:'../shared.txt',added:0,deleted:0},
    {path:'/workspace/cloud/file.pdf',display:'/workspace/cloud/file.pdf',added:0,deleted:0},
    {path:'/outside/private.txt',display:'/outside/private.txt',added:0,deleted:0},
  ]})};
  const result=await service.changes(owner,chat.id,'10',null);
  expect(result.files.map(file=>file.workspacePath)).toEqual(['conversations/original/a.ts','conversations/shared.txt','cloud/file.pdf',undefined]);
  expect(result).not.toHaveProperty('cwd');
  await expect(service.changes({...owner,ownerId:'foreign'},chat.id,'10',null)).rejects.toMatchObject({status:404});
});

it('saves global skill capabilities and submits only the explicitly mentioned skill', async () => {
  const { service, database, owner, chat, skills, sessionController } = setup()
  const names = ['docx', 'xlsx', 'pptx', 'pdf', 'skill-creator', 'official-docx', 'humanizer-zh', 'legal-research', 'case-analysis', 'contract-review']
  skills.list.mockResolvedValue(names.map(name => ({ name, description: name, provider: 'gxzs-filesystem', source: 'custom', invocation: { modelInvocable: true, userInvocable: true } })))
  const configured = await service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m', skills: names } })
  expect(configured.selection.skills).toEqual(names)
  const run = await service.submitRun(owner, chat.id, { query: '润色这段文字', request_key: 'selected-global-skill', version: configured.version, resource_mentions: { skills: ['humanizer-zh'] } })
  expect(database.getRun(owner.ownerId, run.id).selection.skills).toEqual(names)
  expect(run.resource_mentions.skills).toEqual(['humanizer-zh'])
  const prompt = sessionController.prompt.mock.calls.at(-1)[0]
  expect(prompt.content).toContainEqual({ type: 'text', text: '/humanizer-zh' })
  expect(prompt.content.map(block => block.text ?? '').join('\n')).not.toContain('/docx')
})

it('rejects unsupported knowledge independently of configured skills', async () => {
  const { service, owner, chat, sessionController } = setup()
  await expect(service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m', skills: ['docx'], knowledge: ['library'] } }))
    .rejects.toMatchObject({ status: 501, message: '知识库选择尚未接入此版本' })
  expect(sessionController.selectModel).not.toHaveBeenCalled()
  await expect(service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m', skills: [123] } }))
    .rejects.toMatchObject({ status: 400 })
})


it('streams durable file references into command receipts for plan and goal admission', async () => {
  const { service, agent } = setup()
  const storedFile = { attachmentId: 'sha256:fixture', name: 'evidence.txt', bytes: 8 }
  service.attachments = { readFileStream: async function* (ref) {
    expect(ref).toEqual(storedFile)
    yield Buffer.from('evidence')
  } }
  service.fileUploads = { uploadStream: vi.fn(async ({ sessionId, data }) => {
    expect(sessionId).toBe(agent.id)
    const chunks = []; for await (const chunk of data) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('evidence')
    return { receiptId: 'command-file' }
  }) }
  expect(await service.commandAttachments(agent, [{ type: 'text', text: 'query' },
    { type: 'file', storedFile, name: 'evidence.txt' }])).toEqual([{ type: 'file', receiptId: 'command-file' }])
  expect(service.fileUploads.uploadStream).toHaveBeenCalledOnce()
})
