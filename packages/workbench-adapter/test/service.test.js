import { platformToolName } from '../../workbench-mcp-tools/src/names.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchService } from '../src/service.js'
import { projectSessionEvent } from '../src/projection.js'
import { publishedModels } from './model-fixture.js'

const opened = []
afterEach(() => opened.splice(0).forEach((database) => database.close()))

function setup() {
  const database = new WorkbenchDatabase(':memory:')
  opened.push(database)
  const owner = { ownerId: 'tenant:user', tenantId: 'tenant', userId: 'user' }
  const chat = database.createChat({ ownerId: owner.ownerId, sessionId: 'session-1', selection: { model: 'p/m' } })
  const sessionController = {
    updateQueue: vi.fn(async () => ({ accepted: true })), prompt: vi.fn(async () => ({ accepted: true })), cancel: vi.fn(() => ({ accepted: true })),
    rename: vi.fn(async ({ title }) => ({ title, seq: 1 })), selectModel: vi.fn(async () => ({ selected: {} })),
    create: vi.fn(async () => ({ sessionId: 'session-new' })), fork: vi.fn(async () => ({ sessionId: 'session-fork' })),
    modelCatalog: vi.fn(async () => ({ groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }] }] })),
  }
  const agent = { id: chat.sessionId, cancel: vi.fn(), whenIdle: vi.fn(async () => {}) }
  const agents = { get: vi.fn(() => agent) }
  const commands = { execute: vi.fn(async () => ({ result: { text: 'ok' }, commandId: 'c1' })) }
  const fileManager = {
    operate: vi.fn(async ({ operation }) => {
      if (operation === 'stat') return { kind: 'directory', version: 'tree-v1' }
      if (operation === 'delete' || operation === 'mkdir') return { deleted: true }
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
  return { database, owner, chat, service, sessionController, agents, commands, skills, fileManager, platformClient, agent }
}

function activateNative(test, runId, queued = []) {
  const { agent, database, chat, owner, service } = test
  database.bindRunMessage(chat.sessionId, runId, 1, `message-${runId}`)
  database.transitionRun(owner.ownerId, runId, 'running')
  agent.status = 'running'
  agent.session = { snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }] }
  agent.inbox = { nextTurn: queued, nextStep: [], remove: vi.fn(id => {
    const index = agent.inbox.nextTurn.findIndex(message => message.id === id)
    if (index < 0) return false
    agent.inbox.nextTurn.splice(index, 1)
    return true
  }) }
  agent.steer = vi.fn(message => agent.inbox.nextStep.push(message))
  service.scheduler = { ...service.scheduler, hasAdmission: () => true }
}

describe('followup and control service', () => {
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
  it('persists capacity-waiting tasks without sending them to DSH and allows cancellation', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    service.scheduler = { enqueue: (run, content) => database.saveSubmission(owner.ownerId, run.id, content) }
    const run = await service.submitRun(owner, chat.id, { query: 'wait for capacity' })
    expect(database.submission(owner.ownerId, run.id).dispatched).toBe(false)
    expect(sessionController.prompt).not.toHaveBeenCalled()
    expect(service.chatSummary(owner, chat)).toMatchObject({ has_active_run: true, is_running: false })
    expect(await service.stopRun(owner, run.id)).toMatchObject({ status: 'cancelled' })
    expect(sessionController.cancel).not.toHaveBeenCalled()
  })

  it('direct-sends a locally queued message into the running turn only on explicit steering', async () => {
    const test = setup()
    const { service, owner, chat, database, sessionController, agent } = test
    const active = await service.submitRun(owner, chat.id, { query: 'active' })
    database.transitionRun(owner.ownerId, active.id, 'running')
    sessionController.prompt.mockClear()
    service.scheduler = { enqueue: (run, content) => database.saveSubmission(owner.ownerId, run.id, content) }
    const next = await service.submitRun(owner, chat.id, { query: 'supplement' })
    activateNative(test, active.id)
    expect(sessionController.prompt).not.toHaveBeenCalled()
    expect(await service.steer(owner, next.id, active.id)).toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(agent.steer).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'user', rpcId: next.id } }))
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
    expect(agent.inbox.remove).toHaveBeenCalledWith('message-first')
    expect(database.getRun(owner.ownerId, second.id).parentRunId).toBe(active.id)
    expect(service.getChat(owner, chat.id).runs.find((run) => run.id === active.id).steering_messages).toMatchObject([{ id: first.id, query: 'first' }])
    expect(service.followups(owner, chat.id, [first.id]).runs.find((run) => run.id === first.id).steer_target_run_id).toBe(active.id)
    await expect(service.steer(owner, first.id, active.id)).resolves.toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(agent.steer).toHaveBeenCalledTimes(1)
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
      expect(fileManager.operate).toHaveBeenCalledWith({ operation: 'mkdir', path: `conversations/${chat.id}` })
      expect(sessionController.create).toHaveBeenCalledWith({ cwd: `/workspace/conversations/${chat.id}` })
    }
    expect(fileManager.operate.mock.invocationCallOrder[0]).toBeLessThan(sessionController.create.mock.invocationCallOrder[0])
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
    const body = { request_id: 'question', answers: [{ id: 'q', selected: [], custom: 'answer' }] }
    sessionController.prompt.mockRejectedValueOnce(new Error('temporary dispatch failure'))
    await expect(service.supplement(owner, run.id, body)).rejects.toThrow('temporary dispatch failure')
    const accepted = await service.supplement(owner, run.id, body)
    const repeated = await service.supplement(owner, run.id, body)
    expect(repeated.id).toBe(accepted.id)
    expect(sessionController.prompt).toHaveBeenCalledTimes(2)
    expect(sessionController.prompt.mock.calls[0][0].requestId).toBe(sessionController.prompt.mock.calls[1][0].requestId)
    expect(service.getRun(owner, run.id).human_input_history).toMatchObject([
      { request_id: 'question', status: 'submitted', answers: [{ id: 'q', selected: [], custom: 'answer' }], supplement_run_id: accepted.id },
    ])
    await expect(service.supplement(owner, run.id, { ...body, request_id: 'missing' })).rejects.toMatchObject({ status: 404 })
  })
  it.each(['running', 'completed'])('sends a historical answer as an interruption or followup when the task is %s', async (status) => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: '任务', selection: {} })
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'late-answer', payload: { tool_name: 'ask_user_question', questions: [{ id: 'format', question: '交付格式？' }] }, deadlineAt: null })
    database.settlePendingInput(owner.ownerId, run.id, 'late-answer', 'skipped')
    database.transitionRun(owner.ownerId, run.id, status)
    const body = { request_id: 'late-answer', answers: [{ id: 'format', selected: [], custom: 'Word' }] }
    const result = await service.supplement(owner, run.id, body)
    expect(sessionController.prompt.mock.calls[0][0]).toMatchObject({ mode: 'queue' })
    const text = sessionController.prompt.mock.calls[0][0].content[0].text
    expect(text).toContain('交付格式？')
    expect(text).toContain('Word')
    expect(result.status).toBe('queued')
    await service.supplement(owner, run.id, body)
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
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
      memory: { content: 'm', version: 'v' }, warnings: [],
      skills: [{ id: 'demo', content: '---\nname: demo\ndescription: Demo skill\n---\nBody', enabled: true, pinned: false, path: '/workspace/skills/demo', version: 's1' }],
    })
    fileManager.personalMcp.mockResolvedValueOnce({ mcp: [{ id: 'server', status: 'ready' }], warnings: [] })
    skills.list.mockResolvedValueOnce([{ name: 'global', description: 'Global', path: '/global/SKILL.md', source: 'custom', provider: 'gxzs' }])
    await expect(service.resources()).resolves.toMatchObject({
      skills: [{ id: 'demo', name: 'demo', description: 'Demo skill', scope: 'personal', readonly: false }],
      mcp: [{ id: 'server', status: 'ready' }],
      global: { skills: [{ id: 'global', scope: 'global', readonly: true }] },
    })
  })

  it('forwards validated resource mutations to fixed manager actions', async () => {
    const { service, fileManager } = setup()
    await service.mutateResource({ operation: 'skill_toggle', name: 'demo', enabled: false })
    await service.mutateResource({ operation: 'mcp_pin', name: 'server', pinned: true })
    expect(fileManager.personalResources).toHaveBeenCalledWith({ operation: 'skill_toggle', name: 'demo', enabled: false })
    expect(fileManager.personalMcp).toHaveBeenCalledWith({ operation: 'mcp_pin', name: 'server', pinned: true })
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
      .mockResolvedValueOnce({ content: '---\nname: demo\ndescription: Demo\n---\nBody' })
      .mockResolvedValueOnce({ id: 'demo', version: 'v2' })
    const payload = { operation: 'skill_import', archive: 'safe-package', version: null }
    await expect(service.mutateResource(payload)).resolves.toEqual({ id: 'demo', version: 'v2' })
    expect(fileManager.personalResources).toHaveBeenLastCalledWith({ ...payload, name: 'demo' })
  })

  it.each([502, 503])('handles temporary platform MCP status %s by request criticality', async (status) => {
    const { service, platformClient } = setup()
    const error = Object.assign(new Error('unavailable'), { status })
    platformClient.json.mockRejectedValue(error)
    await expect(service.mcpCatalog({ ownerId: 'tenant:user' })).resolves.toEqual([])
    await expect(service.mcpCatalog({ ownerId: 'tenant:user' }, { required: true })).rejects.toBe(error)
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

  it('rejects unavailable MCP selections before committing chat configuration', async () => {
    const { database, owner, chat, service, platformClient } = setup()
    platformClient.json.mockResolvedValue({ tools: [] })
    await expect(service.updateConfig(owner, chat.id, { version: 1, selection: { model: 'p/m', tools: ['personal:missing:x'] } })).rejects.toMatchObject({ status: 409 })
    expect(database.getChat(owner.ownerId, chat.id).version).toBe(1)
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

  it('returns reasoning parameter rules and hides soft-deleted chats and runs', async () => {
    const { database, owner, chat, service } = setup()
    expect(await service.modelParameters('p/m')).toMatchObject({ reasoning_effort: { options: ['low', 'high'], default: 'low' } })
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    database.transitionRun(owner.ownerId, run.id, 'completed')
    await service.deleteChat(owner, chat.id)
    expect(service.listChats(owner)).toEqual([])
    expect(() => service.getRun(owner, run.id)).toThrow('任务不存在')
  })

  it('deletes the checked directory version and preserves chat on a conflict', async () => {
    const { owner, chat, service, fileManager } = setup()
    fileManager.operate.mockResolvedValueOnce({ kind: 'directory', version: 'tree-v2' })
      .mockRejectedValueOnce(Object.assign(new Error('changed'), { status: 409 }))
    await expect(service.deleteChat(owner, chat.id)).rejects.toMatchObject({ status: 409 })
    expect(fileManager.operate).toHaveBeenLastCalledWith({ operation: 'delete', path: `conversations/${chat.id}`, version: 'tree-v2' })
    expect(service.listChats(owner)).toHaveLength(1)
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
    expect(service.getChat(owner, chat.id).title).toBe('分析附件')
  })

  it.each(['1.png', 'notes.txt'])('uses the full workspace path for a textless %s first message', async (name) => {
    const { database, owner, chat, service, fileManager, sessionController } = setup()
    const bytes = name.endsWith('.png') ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]) : Buffer.from('notes')
    fileManager.operate.mockResolvedValue({ name, version: 'v1', data: bytes.toString('base64') })
    const run = await service.submitRun(owner, chat.id, { query: '', files: [{ path: `conversations/${chat.id}/${name}`, version: 'v1' }] })
    const title = `/workspace/conversations/${chat.id}/${name}`
    expect(service.getChat(owner, chat.id).title).toBe(title)
    expect(sessionController.prompt.mock.calls[0][0].content[0]).toEqual(name.endsWith('.png') ? expect.objectContaining({ type: 'image', name }) : { type: 'text', text: title })
    expect(database.allEvents(owner.ownerId, run.id)).toContainEqual(expect.objectContaining({ event: 'workbench_chat_title', title }))
    await service.submitRun(owner, chat.id, { query: '后续消息' })
    expect(service.getChat(owner, chat.id).title).toBe(title)
  })

  it('uses the first human text verbatim and preserves explicit names', async () => {
    const { owner, chat, service, sessionController } = setup()
    await service.submitRun(owner, chat.id, { query: '检索资料，核对结论' })
    expect(service.getChat(owner, chat.id).title).toBe('检索资料，核对结论')
    expect(sessionController.rename).not.toHaveBeenCalled()
    await service.submitRun(owner, chat.id, { query: '再检查一下' })
    expect(service.getChat(owner, chat.id).title).toBe('检索资料，核对结论')
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
  })

  it('steers a queued message through the synchronous native inbox facade', async () => {
    const test = setup()
    const { database, owner, chat, service, agent } = test
    const { run: active } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'active', selection: {} })
    database.transitionRun(owner.ownerId, active.id, 'running')
    const { run: queued } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'queued', selection: {} })
    database.bindRunMessage(chat.sessionId, queued.id, 2, 'message-2')
    activateNative(test, active.id, [{ id: 'message-2', source: { kind: 'user', rpcId: queued.id }, content: [{ type: 'text', text: 'queued' }] }])
    const result = await service.steer(owner, queued.id, active.id)
    expect(agent.inbox.remove).toHaveBeenCalledWith('message-2')
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

  it('resumes a cold DSH session before executing a control command', async () => {
    const { owner, chat, service, sessionController, agents, commands, agent } = setup()
    agents.get.mockReturnValueOnce(undefined).mockReturnValue(agent)
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
  it('uses native user invocation even for model-disabled skills and rejects user-disabled skills', async () => {
    const { service, owner, chat, sessionController, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'manual', invocation: { modelInvocable: false, userInvocable: true } }])
    await service.submitRun(owner, chat.id, { query: 'run', resource_mentions: { skills: ['manual'] } })
    expect(sessionController.prompt.mock.calls[0][0].content.at(-1)).toEqual({ type: 'text', text: '/manual' })
    skills.list.mockResolvedValue([{ name: 'manual', invocation: { modelInvocable: true, userInvocable: false } }])
    await expect(service.submitRun(owner, chat.id, { query: 'run again', resource_mentions: { skills: ['manual'] } })).rejects.toMatchObject({ status: 409 })
  })

  it('delivers selected plugin and skill instructions without changing user text or title, and retains them on fork', async () => {
    const { service, owner, chat, database, sessionController, skills } = setup()
    const tool = { id: 'law', runtime_name: 'global_law_search', provider_name: '法律检索', name: '检索' }
    vi.spyOn(service, 'freezeMcpTools').mockResolvedValue([tool])
    skills.list.mockResolvedValue([{ name: 'legal-review', description: '审查' }])
    const mentions = { tools: ['law'], skills: ['legal-review'], knowledge: [] }
    const run = await service.submitRun(owner, chat.id, { query: '融资租赁', resource_mentions: mentions })
    expect(run.query).toBe('融资租赁')
    expect(run.resource_mentions).toEqual(mentions)
    expect(database.getChat(owner.ownerId, chat.id).title).toBe('融资租赁')
    const content = sessionController.prompt.mock.calls[0][0].content
    expect(content[0].text).toBe('融资租赁')
    expect(content[1].text).toContain('global_law_search')
    expect(content[2]).toEqual({ type: 'text', text: '/legal-review' })
    expect(content[1].text).toBe('用户选择的 MCP 工具：\n["global_law_search"]')
    database.bindRunMessage(chat.sessionId, run.id, 1, 'm1')
    database.transitionRun(owner.ownerId, run.id, 'completed')
    database.setRunSourceSeq(owner.ownerId, run.id, 'source_end_seq', 9)
    const child = await service.fork(owner, run.id, { request_key: 'resource-fork' })
    expect(child.runs[0].resource_mentions).toEqual(mentions)
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
  })

  it('returns the original mentions on receipt replay and preserves them on an explicit retry', async () => {
    const { service, owner, chat, sessionController, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'legal-review' }])
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
    expect(ordinary.resource_mentions).toEqual({ tools: [], skills: [], knowledge: [] })
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
    service.freezeMcpTools = vi.fn(() => new Promise(resolve => { release = resolve }))
    const submission = service.submitRun(owner, chat.id, { query: 'slow', request_key: 'slow-key' })
    const rejected = expect(submission).rejects.toMatchObject({ status: 409 })
    await vi.waitFor(() => expect(service.freezeMcpTools).toHaveBeenCalled())
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
    expect(child.runs[1].events).toEqual(expect.arrayContaining([expect.objectContaining({ answer: 'answer second' })]))
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

  it('can fork inherited answers again and keeps original event boundaries', async () => {
    const { service, owner, second, sessionController } = history()
    sessionController.fork.mockResolvedValueOnce({ sessionId: 'child-1' }).mockResolvedValueOnce({ sessionId: 'child-2' })
    const child = await service.fork(owner, second.id, { request_key: 'a' })
    const grandchild = await service.fork(owner, child.runs[0].id, { request_key: 'b' })
    expect(grandchild.runs.map(run => run.query)).toEqual(['first'])
    expect(sessionController.fork).toHaveBeenLastCalledWith({ sessionId: 'session-1', atSeq: 9 })
  })

  it('rejects other owners, unfinished answers and deleted chats', async () => {
    const { service, database, owner, chat, second, sessionController } = history()
    await expect(service.fork({ ownerId: 'other' }, second.id, { request_key: 'x' })).rejects.toMatchObject({ status: 404 })
    database.transitionRun(owner.ownerId, second.id, 'running')
    await expect(service.fork(owner, second.id, { request_key: 'x' })).rejects.toMatchObject({ status: 409 })
    database.transitionRun(owner.ownerId, second.id, 'completed')
    database.deleteChat(owner.ownerId, chat.id)
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
