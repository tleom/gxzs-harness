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

  it('regenerates a first turn in a fresh session without inheriting its answer', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run: source } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'original', selection: {} })
    database.bindRunMessage(chat.sessionId, source.id, 1, 'm1')
    database.setRunSourceSeq(owner.ownerId, source.id, 'source_start_seq', 1)
    database.setRunSourceSeq(owner.ownerId, source.id, 'source_end_seq', 9)
    database.transitionRun(owner.ownerId, source.id, 'completed')
    const regenerated = await service.regenerate(owner, source.id, { request_key: 'regen-1', query: 'edited' })
    expect(sessionController.create).toHaveBeenCalledWith({ cwd: '/workspace' })
    expect(sessionController.fork).not.toHaveBeenCalled()
    expect(regenerated).toMatchObject({ parent_run_id: source.id, query: 'edited', status: 'queued' })
    expect(database.getChat(owner.ownerId, chat.id).sessionId).toBe('session-new')
  })

  it('forks regeneration after the preceding completed turn', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run: previous } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'previous', selection: {} })
    database.bindRunMessage(chat.sessionId, previous.id, 1, 'm1')
    database.setRunSourceSeq(owner.ownerId, previous.id, 'source_end_seq', 9)
    database.transitionRun(owner.ownerId, previous.id, 'completed')
    const { run: source } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'source', selection: {} })
    database.bindRunMessage(chat.sessionId, source.id, 2, 'm2')
    database.setRunSourceSeq(owner.ownerId, source.id, 'source_end_seq', 19)
    database.transitionRun(owner.ownerId, source.id, 'completed')
    const regenerated = await service.regenerate(owner, source.id, { request_key: 'regen-2' })
    expect(sessionController.fork).toHaveBeenCalledWith({ sessionId: chat.sessionId, atSeq: 9 })
    expect(regenerated.parent_run_id).toBe(source.id)
    expect(database.getChat(owner.ownerId, chat.id).sessionId).toBe('session-fork')
  })

  it('retries failed regeneration on the same child session and run', async () => {
    const { database, owner, chat, service, sessionController } = setup()
    const { run: source } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'source', selection: {} })
    database.bindRunMessage(chat.sessionId, source.id, 1, 'm1')
    database.transitionRun(owner.ownerId, source.id, 'completed')
    sessionController.prompt.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ accepted: true })
    const first = await service.regenerate(owner, source.id, { request_key: 'regen-retry' })
    expect(first.status).toBe('failed')
    const second = await service.regenerate(owner, source.id, { request_key: 'regen-retry' })
    expect(second).toMatchObject({ id: first.id, status: 'queued' })
    expect(sessionController.create).toHaveBeenCalledOnce()
    expect(sessionController.prompt.mock.calls.map(([request]) => request.requestId)).toEqual([first.id, first.id])
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
    expect(sessionController.create).toHaveBeenCalledWith({ sessionId: chat.sessionId, cwd: '/workspace' })
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
