import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchService } from '../src/service.js'

const opened = []
afterEach(() => opened.splice(0).forEach((database) => database.close()))

function setup() {
  const database = new WorkbenchDatabase(':memory:')
  opened.push(database)
  const owner = { ownerId: 'tenant:user', tenantId: 'tenant', userId: 'user' }
  const chat = database.createChat({ ownerId: owner.ownerId, sessionId: 'session-1', selection: {} })
  const sessionController = {
    updateQueue: vi.fn(async () => ({ accepted: true })), prompt: vi.fn(async () => ({ accepted: true })), cancel: vi.fn(() => ({ accepted: true })),
    rename: vi.fn(async ({ title }) => ({ title, seq: 1 })), selectModel: vi.fn(async () => ({ selected: {} })),
    create: vi.fn(async () => ({ sessionId: 'session-new' })), fork: vi.fn(async () => ({ sessionId: 'session-fork' })),
    modelCatalog: vi.fn(async () => ({ groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }] }] })),
  }
  const agent = { id: chat.sessionId }
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
  const service = new WorkbenchService({ database, sessionController, agents, commands, skills, fileManager, platformClient, workspace: '/workspace' })
  return { database, owner, chat, service, sessionController, agents, commands, skills, fileManager, platformClient, agent }
}

describe('followup and control service', () => {
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
    const { service, owner, chat, database, sessionController } = setup()
    const active = await service.submitRun(owner, chat.id, { query: 'active' })
    database.transitionRun(owner.ownerId, active.id, 'running')
    sessionController.prompt.mockClear()
    service.scheduler = { enqueue: (run, content) => database.saveSubmission(owner.ownerId, run.id, content) }
    const next = await service.submitRun(owner, chat.id, { query: 'supplement' })
    expect(sessionController.prompt).not.toHaveBeenCalled()
    expect(await service.steer(owner, next.id, active.id)).toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(sessionController.prompt.mock.calls[0][0]).toMatchObject({ mode: 'steer', requestId: next.id })
  })

  it('queues normal messages in order and steers only on an explicit request', async () => {
    const { service, owner, chat, database, sessionController } = setup()
    const active = await service.submitRun(owner, chat.id, { query: 'active', request_key: 'active' })
    database.transitionRun(owner.ownerId, active.id, 'running')
    const first = await service.submitRun(owner, chat.id, { query: 'first', request_key: 'first' })
    const second = await service.submitRun(owner, chat.id, { query: 'second', request_key: 'second', parent_run_id: active.id })
    expect(first).toMatchObject({ status: 'queued', parent_run_id: active.id })
    expect(second).toMatchObject({ status: 'queued', parent_run_id: first.id })
    expect(sessionController.prompt.mock.calls.every(([request]) => request.mode === 'queue')).toBe(true)
    expect(sessionController.updateQueue).not.toHaveBeenCalled()
    database.adoptInboxMessage(chat.sessionId, first.id, 'message-first')
    const direct = await service.steer(owner, first.id, active.id)
    expect(direct).toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(sessionController.updateQueue).toHaveBeenCalledWith({ sessionId: chat.sessionId, itemId: 'message-first', action: { kind: 'steer' } })
    expect(database.getRun(owner.ownerId, second.id).parentRunId).toBe(active.id)
    expect(service.getChat(owner, chat.id).runs.find((run) => run.id === active.id).steering_messages).toMatchObject([{ id: first.id, query: 'first' }])
    expect(service.followups(owner, chat.id, [first.id]).runs.find((run) => run.id === first.id).steer_target_run_id).toBe(active.id)
    await expect(service.steer(owner, first.id, active.id)).resolves.toMatchObject({ status: 'steered', steer_target_run_id: active.id })
    expect(sessionController.updateQueue).toHaveBeenCalledTimes(1)
  })

  it('enforces queue capacity and repairs the message chain after deleting a queued message', async () => {
    const { service, owner, chat, database } = setup()
    const active = await service.submitRun(owner, chat.id, { query: 'active' })
    database.transitionRun(owner.ownerId, active.id, 'running')
    const first = await service.submitRun(owner, chat.id, { query: 'first' })
    const second = await service.submitRun(owner, chat.id, { query: 'second' })
    await service.submitRun(owner, chat.id, { query: 'third' })
    await expect(service.submitRun(owner, chat.id, { query: 'fourth' })).rejects.toMatchObject({ status: 409 })
    database.adoptInboxMessage(chat.sessionId, first.id, 'message-first')
    await service.removeQueued(owner, first.id)
    expect(database.getRun(owner.ownerId, second.id).parentRunId).toBe(active.id)
    await expect(service.submitRun(owner, chat.id, { query: 'replacement' })).resolves.toMatchObject({ status: 'queued' })
  })

  it('reserves the starting task separately from three queued follow-ups', async () => {
    const { service, owner, chat, sessionController } = setup()
    const first = await service.submitRun(owner, chat.id, { query: 'starting' })
    for (const query of ['one', 'two', 'three']) await service.submitRun(owner, chat.id, { query })
    await expect(service.submitRun(owner, chat.id, { query: 'four' })).rejects.toMatchObject({ status: 409 })
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

  it('moves an idle legacy session to its conversation directory with history intact', async () => {
    const { service, owner, chat, agents, database, sessionController } = setup()
    const history = [{ seq: 0, type: 'example', data: { text: 'preserved' } }]
    const dispose = vi.fn()
    service.sessionQuery = { observeSession: vi.fn(async () => ({ header: { cwd: '/workspace' }, events: history, projections: { values: { agentPreset: 'standard' } }, [Symbol.dispose]: dispose })) }
    service.agentPresets = { resolve: vi.fn(async () => ({ id: 'standard' })), mount: vi.fn() }
    service.agentDefaultModel = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    agents.get.mockReturnValue({ session: { header: { cwd: '/workspace' } } })
    agents.create = vi.fn(async () => ({}))
    const run = await service.submitRun(owner, chat.id, { query: 'continue' })
    const created = agents.create.mock.calls[0][0]
    expect(created).toMatchObject({ seed: history, inheritedEventCount: 1, meta: { cwd: `/workspace/conversations/${chat.id}`, parentSession: chat.sessionId, isSeeded: true } })
    expect(database.getChat(owner.ownerId, chat.id).sessionId).toBe(created.sessionId)
    expect(sessionController.prompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: created.sessionId, requestId: run.id }), expect.any(AbortSignal))
    expect(dispose).toHaveBeenCalledOnce()
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
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'question', payload: { request_id: 'question', tool_name: 'ask_user_question', args: { fields: [{ name: 'q', label: 'Question' }] } }, deadlineAt: null })
    database.settlePendingInput(owner.ownerId, run.id, 'question', 'skipped')
    const body = { request_id: 'question', values: { q: 'answer' }, custom_fields: ['q'] }
    sessionController.prompt.mockRejectedValueOnce(new Error('temporary dispatch failure'))
    await expect(service.supplement(owner, run.id, body)).rejects.toThrow('temporary dispatch failure')
    const accepted = await service.supplement(owner, run.id, body)
    const repeated = await service.supplement(owner, run.id, body)
    expect(repeated.id).toBe(accepted.id)
    expect(sessionController.prompt).toHaveBeenCalledTimes(2)
    expect(sessionController.prompt.mock.calls[0][0].requestId).toBe(sessionController.prompt.mock.calls[1][0].requestId)
    expect(service.getRun(owner, run.id).human_input_history).toMatchObject([
      { request_id: 'question', status: 'submitted', values: { q: 'answer' }, custom_fields: ['q'], supplement_run_id: accepted.id },
    ])
    await expect(service.supplement(owner, run.id, { ...body, request_id: 'missing' })).rejects.toMatchObject({ status: 404 })
  })
  it.each(['running', 'completed'])('sends a historical answer as an interruption or followup when the task is %s', async (status) => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: '任务', selection: {} })
    database.createPendingInput(owner.ownerId, run.id, { requestId: 'late-answer', payload: { tool_name: 'ask_user_question', args: { fields: [{ name: 'format', label: '交付格式？' }] } }, deadlineAt: null })
    database.settlePendingInput(owner.ownerId, run.id, 'late-answer', 'skipped')
    database.transitionRun(owner.ownerId, run.id, status)
    const body = { request_id: 'late-answer', values: { format: 'Word' } }
    const result = await service.supplement(owner, run.id, body)
    expect(sessionController.prompt.mock.calls[0][0]).toMatchObject({ mode: status === 'running' ? 'steer' : 'queue' })
    const text = sessionController.prompt.mock.calls[0][0].content[0].text
    expect(text).toContain('交付格式？')
    expect(text).toContain('Word')
    expect(result.status).toBe(status === 'running' ? 'steered' : 'queued')
    if (status === 'running') {
      expect(result.steer_target_run_id).toBe(run.id)
      expect(service.getRun(owner, run.id).steering_messages).toMatchObject([{ query: 'Word' }])
    }
    await service.supplement(owner, run.id, body)
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
  })

  it.each(['ask_user_question', 'exit_plan_mode'])('keeps %s visible across followup refreshes and preserves settled history', (toolName) => {
    const { database, owner, chat, service } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    const payload = { request_id: 'first', tool_call_id: 'first', tool_name: toolName, args: { fields: [{ name: 'q', label: 'Question', type: 'paragraph' }] } }
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
      { request_id: 'first', status: 'skipped', skipped_fields: ['q'] },
      { request_id: 'second', status: 'submitted', values: { q: 'answer' }, custom_fields: ['q'] },
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
    await expect(service.mutateResource({ operation: 'skill_inspect', files: [] })).resolves.toEqual({ name: 'demo', version: 'v1' })
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
    expect(database.getRun(owner.ownerId, run.id).mcpTools).toEqual(tools.map((tool) => expect.objectContaining(tool)))
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

  it('rejects deleting an active chat before accessing its files', async () => {
    const { database, owner, chat, service, fileManager } = setup()
    database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    await expect(service.deleteChat(owner, chat.id)).rejects.toMatchObject({ status: 409 })
    expect(fileManager.operate).not.toHaveBeenCalled()
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
    expect(sessionController.prompt.mock.calls[0][0].content[0]).toEqual({ type: 'text', text: title })
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

  it('retries a failed prompt admission with the same idempotent run identity', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    sessionController.prompt.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ accepted: true })
    const body = { query: 'retry', request_key: 'retry-key' }
    const first = await service.submitRun(owner, chat.id, body)
    expect(first).toMatchObject({ status: 'failed', error: expect.stringContaining('temporary') })
    const second = await service.submitRun(owner, chat.id, body)
    expect(second).toMatchObject({ id: first.id, status: 'queued', error: undefined })
    expect(sessionController.prompt.mock.calls.map(([request]) => request.requestId)).toEqual([first.id, first.id])
    expect(database.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
  })

  it('uses durable DSH message ids for queue deletion', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'queued', selection: {} })
    database.bindRunMessage(chat.sessionId, run.id, 2, 'message-2')
    const result = await service.removeQueued(owner, run.id)
    expect(sessionController.updateQueue).toHaveBeenCalledWith({ sessionId: chat.sessionId, itemId: 'message-2', action: { kind: 'remove' } })
    expect(result.status).toBe('discarded')
  })

  it('steers a queued message through DSH updateQueue', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run: active } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'active', selection: {} })
    database.transitionRun(owner.ownerId, active.id, 'running')
    const { run: queued } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'queued', selection: {} })
    database.bindRunMessage(chat.sessionId, queued.id, 2, 'message-2')
    const result = await service.steer(owner, queued.id, active.id)
    expect(sessionController.updateQueue).toHaveBeenCalledWith({ sessionId: chat.sessionId, itemId: 'message-2', action: { kind: 'steer' } })
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
    expect(await service.stopRun(owner, run.id)).toMatchObject({ status: 'stopping' })
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

  it('persists the accepted plan objective in control state', async () => {
    const { owner, chat, service } = setup()
    await expect(service.issueCommand(owner, chat.id, {
      command: '/plan 调查证据', expected_revision: 0, request_key: 'plan-objective',
    })).resolves.toMatchObject({ state: { plan: { objective: '调查证据' } } })
  })

  it('returns an immediate pending inactive state for a queued plan exit', async () => {
    const { owner, chat, service } = setup()
    const entered = await service.issueCommand(owner, chat.id, {
      command: '/plan 调查证据', expected_revision: 0, request_key: 'plan-enter',
    })
    await expect(service.issueCommand(owner, chat.id, {
      command: '/plan off', expected_revision: entered.state.revision, request_key: 'plan-exit',
    })).resolves.toMatchObject({ state: { plan: { active: false, pending: true } } })
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
    expect(content[1].text).toContain('legal-review')
    expect(content[1].text).toContain('不要把插件当作技能加载')
    database.bindRunMessage(chat.sessionId, run.id, 1, 'm1')
    database.transitionRun(owner.ownerId, run.id, 'completed')
    database.setRunSourceSeq(owner.ownerId, run.id, 'source_end_seq', 9)
    const child = await service.fork(owner, run.id, { request_key: 'resource-fork' })
    expect(child.runs[0].resource_mentions).toEqual(mentions)
    expect(sessionController.prompt).toHaveBeenCalledTimes(1)
  })

  it('preserves explicit mentions on failed-send retry and rejects a changed retry payload', async () => {
    const { service, owner, chat, sessionController, skills } = setup()
    skills.list.mockResolvedValue([{ name: 'legal-review' }])
    sessionController.prompt.mockRejectedValueOnce(new Error('offline'))
    const body = { query: '核对', request_key: 'mention-retry', resource_mentions: { skills: ['legal-review'] } }
    const failed = await service.submitRun(owner, chat.id, body)
    expect(failed.status).toBe('failed')
    await expect(service.submitRun(owner, chat.id, { ...body, resource_mentions: {} })).rejects.toMatchObject({ status: 409 })
    const retried = await service.submitRun(owner, chat.id, body)
    expect(retried.id).toBe(failed.id)
    expect(retried.status).toBe('queued')
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
    expect(() => service.stopRun(owner, run.id)).toThrow()
    expect(service.getRun(owner, run.id).status).toBe('running')
    expect(service.stopRun(owner, run.id).status).toBe('stopping')
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

  it('seeds only events through the selected turn and assigns a new output directory', async () => {
    const { service, owner, chat, agents, second, sessionController } = history()
    const events = [{ seq: 0 }, { seq: 19 }, { seq: 20 }]
    const dispose = vi.fn()
    service.sessionQuery = { observeSession: vi.fn(async () => ({ header: { agentPreset: 'standard' }, events, [Symbol.dispose]: dispose })) }
    service.agentPresets = { resolve: vi.fn(async () => ({ id: 'standard' })), mount: vi.fn() }
    service.agentDefaultModel = { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    agents.create = vi.fn()
    const child = await service.fork(owner, second.id, { request_key: 'seed' })
    expect(agents.create).toHaveBeenCalledWith(expect.objectContaining({ seed: events.slice(0, 2), inheritedEventCount: 2, meta: expect.objectContaining({ cwd: `/workspace/conversations/${child.id}`, parentSession: chat.sessionId }) }))
    expect(sessionController.prompt).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
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
    expect(before).toMatchObject({ created_at: 20, completed_at: 26, elapsed_seconds: 5, can_fork: true })
    database.setFeedback(owner.ownerId, second.id, 'like', 99000)
    expect(service.getRun(owner, second.id)).toMatchObject({ created_at: 20, completed_at: 26, elapsed_seconds: 5 })
  })
})
