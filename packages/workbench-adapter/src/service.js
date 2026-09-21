import yaml from 'js-yaml'
import { randomUUID } from 'node:crypto'
import { admitSandboxAttachments } from './attachments.js'
import { normalizeResourceMentions, appendResourceInstructions } from './resource-mentions.js'
import { httpError } from './http.js'
import { resolveWorkspacePath } from './paths.js'
import { copySessionDirectory } from './session-directory.js'
import { forkChat } from './fork-chat.js'

export class WorkbenchService {
  constructor({ database, sessionController, agents, commands, skills, fileManager, platformClient, workspace, sessionQuery, agentPresets, agentDefaultModel, scheduler }) {
    this.database = database
    this.sessions = sessionController
    this.agents = agents
    this.commands = commands
    this.skills = skills
    this.fileManager = fileManager
    this.platformClient = platformClient
    this.workspace = workspace
    this.sessionQuery = sessionQuery
    this.agentPresets = agentPresets
    this.agentDefaultModel = agentDefaultModel
    this.inflightCommands = new Map()
    this.chatMutations = new Map()
    this.scheduler = scheduler
  }

  async createChat(owner, workspace, selection) {
    const id = randomUUID()
    await this.fileManager.operate({ operation: 'mkdir', path: `conversations/${id}` })
    const created = await this.sessions.create({ cwd: this.chatDirectory(id) })
    const chat = this.database.createChat({ id, ownerId: owner.ownerId, sessionId: created.sessionId, selection })
    return chat
  }

  chatDirectory(chatId) { return resolveWorkspacePath(this.workspace, `conversations/${chatId}`) }

  async ensureChatSession(owner, chat, { allowActive = false } = {}) {
    await this.ensureChatDirectory(owner, chat.id)
    const cwd = this.chatDirectory(chat.id)
    const live = this.agents.get(chat.sessionId)
    let header = live?.session?.header
    if (!header && this.sessionQuery) {
      try {
        const observed = await this.sessionQuery.observeSession(chat.sessionId)
        try { header = observed.header } finally { observed[Symbol.dispose]?.() }
      } catch (error) {
        if (error?.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }
    if (header && header.cwd !== cwd) {
      if (this.database.activeRun(owner.ownerId, chat.id)) {
        if (allowActive) return chat
        throw httpError(409, '当前任务结束后才能更新对话工作目录')
      }
      const child = await copySessionDirectory(this, chat.sessionId, cwd)
      this.database.switchChatSession(owner.ownerId, chat.id, chat.sessionId, child.sessionId)
      return this.requireChat(owner, chat.id)
    }
    if (!live) await this.sessions.create({ sessionId: chat.sessionId, cwd })
    return chat
  }

  async ensureChatDirectory(owner, chatId) {
    this.requireChat(owner, chatId)
    await this.fileManager.operate({ operation: 'mkdir', path: `conversations/${chatId}` })
  }

  async updateChat(owner, chatId, body) {
    return this.withChatMutation(chatId, async () => {
      const chat = this.requireChat(owner, chatId)
      const patch = {}
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200) throw httpError(400, '会话标题无效')
        const renamed = await this.sessions.rename({ sessionId: chat.sessionId, title: body.title.trim() })
        patch.title = renamed.title
      }
      for (const field of ['pinned', 'favorited']) {
        if (body[field] !== undefined && typeof body[field] !== 'boolean') throw httpError(400, `${field} 必须是布尔值`)
        if (body[field] !== undefined) patch[field] = body[field]
      }
      const updated = this.database.updateChat(
        owner.ownerId,
        chatId,
        patch,
        body.title === undefined ? chat.updatedAt : undefined,
      )
      return this.chatSummary(owner, updated)
    })
  }

  async updateConfig(owner, chatId, body) {
    return this.withChatMutation(chatId, async () => {
      const chat = this.requireChat(owner, chatId)
      const selection = normalizeSelection(body.selection)
      if (JSON.stringify(selection) === JSON.stringify(chat.selection)) return this.getChat(owner, chatId)
      if (body.version !== chat.version) throw httpError(409, '配置版本已改变，请刷新后重试')
      if (this.database.activeRun(owner.ownerId, chatId)) throw httpError(409, '任务运行时不能修改模型配置')
      await this.freezeMcpTools(owner, selection.tools)
      const route = splitModel(selection.model)
      const catalog = await this.sessions.modelCatalog()
      if (!(catalog.groups ?? []).some((group) => group.id === route.provider && (group.models ?? []).some((model) => model.id === route.model)))
        throw httpError(400, '模型不存在或当前不可用')
      await this.sessions.selectModel({ sessionId: chat.sessionId, ...route, ...(selection.model_parameters.reasoning_effort ? { reasoningEffort: selection.model_parameters.reasoning_effort } : {}) })
      this.database.updateChatConfig(owner.ownerId, chatId, chat.version, selection)
      return this.getChat(owner, chatId)
    })
  }

  fork(owner, sourceRunId, body) { return forkChat(this, owner, sourceRunId, body) }

  feedback(owner, runId, rating) {
    if (rating !== null && rating !== 'like' && rating !== 'dislike') throw httpError(400, '反馈类型无效')
    this.database.setFeedback(owner.ownerId, runId, rating)
    return this.getRun(owner, runId)
  }

  async modelParameters(modelId) {
    const route = splitModel(modelId)
    const catalog = await this.sessions.modelCatalog()
    const model = (catalog.groups ?? []).find((group) => group.id === route.provider)?.models?.find((item) => item.id === route.model)
    if (!model) throw httpError(404, '模型不存在或当前不可用')
    if (!model.reasoning?.efforts?.length) return {}
    return { reasoning_effort: {
      type: 'string', options: model.reasoning.efforts.map((effort) => effort.id),
      default: model.reasoning.defaultEffort, label: { zh_Hans: '思考强度', en_US: 'Reasoning Effort' },
    } }
  }

  async deleteChat(owner, chatId) {
    return this.withChatMutation(chatId, async () => {
      const chat = this.requireChat(owner, chatId)
      if (this.database.activeRun(owner.ownerId, chatId))
        throw httpError(409, '会话正在执行任务，请停止后再删除')
      const path = `conversations/${chat.id}`
      const entry = await this.fileManager.operate({ operation: 'stat', path })
      if (entry.kind !== 'missing')
        await this.fileManager.operate({ operation: 'delete', path, version: entry.version })
      this.database.deleteChat(owner.ownerId, chatId)
    })
  }

  async withChatMutation(chatId, operation) {
    const prior = this.chatMutations.get(chatId) ?? Promise.resolve()
    const current = prior.catch(() => {}).then(operation)
    this.chatMutations.set(chatId, current)
    try { return await current }
    finally { if (this.chatMutations.get(chatId) === current) this.chatMutations.delete(chatId) }
  }

  listChats(owner) {
    return this.database.listChats(owner.ownerId).map((chat) => this.chatSummary(owner, chat))
  }

  getChat(owner, chatId) {
    const chat = this.requireChat(owner, chatId)
    return { ...this.chatSummary(owner, chat), selection: chat.selection, runs: this.database.listRuns(owner.ownerId, chat.id).map((run) => this.getRun(owner, run.id)) }
  }

  chatSummary(owner, chat) {
    const active = this.database.activeRun(owner.ownerId, chat.id)
    return {
      id: chat.id, title: chat.title, version: chat.version, pinned: chat.pinned, favorited: chat.favorited,
      created_at: Math.floor(chat.createdAt / 1000), updated_at: Math.floor(chat.updatedAt / 1000),
      has_active_run: Boolean(active), is_running: ['running', 'stopping'].includes(active?.status), needs_input: active?.status === 'waiting_input',
    }
  }

  async submitRun(owner, chatId, body) {
    return this.withChatMutation(chatId, () => this.admitRun(owner, chatId, body))
  }

  async admitRun(owner, chatId, body) {
    let chat = this.requireChat(owner, chatId)
    if (body.version !== undefined && body.version !== chat.version)
      throw httpError(409, '配置版本已改变，请刷新后重试')
    const query = String(body.query ?? '')
    const mentions = normalizeResourceMentions(body.resource_mentions)
    const files = Array.isArray(body.files) ? body.files : []
    if (!query.trim() && !files.length) throw httpError(400, '消息内容不能为空')
    const requestKey = typeof body.request_key === 'string' ? body.request_key : undefined
    const cancelled = () => requestKey && this.database.getCommandReceipt(owner.ownerId, chatId, `run-stop:${requestKey}`)
    const checkCancelled = () => { if (cancelled()) throw httpError(409, '消息已取消') }
    checkCancelled()
    const existing = this.database.findRunByRequestKey(owner.ownerId, chatId, requestKey)
    if (existing && existing.status !== 'failed') return runDto(existing, this.database.allEvents(owner.ownerId, existing.id))
    const fileKeys = files.map((file) => ({ path: file?.path, version: file?.version }))
    const existingKeys = existing?.attachments?.map((file) => ({ path: file.path, version: file.version }))
    if (existing && (existing.query !== query || JSON.stringify(normalizeResourceMentions(existing.selection.resource_mentions)) !== JSON.stringify(mentions) || JSON.stringify(existingKeys) !== JSON.stringify(fileKeys)))
      throw httpError(409, 'request_key 已用于不同的任务内容')
    let parentRunId = body.continue_run_id ?? body.parent_run_id ?? this.database.listRuns(owner.ownerId, chatId)
      .filter((run) => !['discarded', 'steered'].includes(run.status)).at(-1)?.id
    if (parentRunId != null) {
      const parent = this.database.getRun(owner.ownerId, parentRunId)
      if (!parent || parent.chatId !== chatId) throw httpError(409, '上级任务不属于当前会话')
    }
    // Admission is serialized per chat: a normal follow-up belongs after the
    // actual queue tail, even if the client's active-run snapshot is stale.
    if (!body.continue_run_id) {
      const tail = this.database.listRuns(owner.ownerId, chatId)
        .filter((run) => ['queued', 'running', 'waiting_input', 'stopping'].includes(run.status)).at(-1)
      if (tail) parentRunId = tail.id
    }
    const mcpTools = existing?.mcpTools ?? await this.freezeMcpTools(owner, chat.selection.tools)
    checkCancelled()
    const admitted = await admitSandboxAttachments({ fileManager: this.fileManager, workspace: this.workspace, query, files })
    admitted.content = await this.resourceContent(admitted.content, mentions, mcpTools)
    checkCancelled()
    chat = await this.ensureChatSession(owner, chat)
    checkCancelled()
    if (existing && existing.sessionId !== chat.sessionId) this.database.rebindFailedRunSession(owner.ownerId, existing.id, chat.sessionId)
    const { run, created } = this.database.createRun({
      ownerId: owner.ownerId, chatId, sessionId: chat.sessionId, query, attachments: admitted.attachments, mcpTools,
      selection: { ...chat.selection, resource_mentions: mentions }, requestKey,
      parentRunId,
    })
    if (!created && run.status !== 'failed') return runDto(run, this.database.allEvents(owner.ownerId, run.id))
    if (!created) this.database.transitionRun(owner.ownerId, run.id, 'queued')
    // Use the submitted human text, never the attachment instructions sent to DSH.
    if (created && chat.title === '新会话' && this.database.listRuns(owner.ownerId, chatId).length === 1) {
      const title = (query.trim() || admitted.attachments.map((file) => resolveWorkspacePath(this.workspace, file.path)).join('\n') || '新会话').slice(0, 200)
      this.database.updateChat(owner.ownerId, chatId, { title })
      this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_chat_title', chat_id: chatId, title, title_source: 'fallback' })
    }
    this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_status', status: 'queued' })
    if (this.scheduler) {
      checkCancelled()
      await this.scheduler.enqueue(run, admitted.content, !created)
      return runDto(this.database.getRun(owner.ownerId, run.id))
    }
    try {
      if (run.selection.model) {
        const active = this.database.activeRun(owner.ownerId, chatId)
        if (active?.id === run.id)
          await this.sessions.selectModel({ sessionId: chat.sessionId, ...splitModel(run.selection.model), ...(run.selection.model_parameters?.reasoning_effort ? { reasoningEffort: run.selection.model_parameters.reasoning_effort } : {}) })
        else if (active?.selection?.model !== run.selection.model) throw httpError(409, '排队任务不能切换当前运行模型')
      }
      checkCancelled()
      await this.sessions.prompt({
        requestId: run.id, sessionId: chat.sessionId, mode: 'queue',
        content: admitted.content,
      }, new AbortController().signal)
    } catch (error) {
      this.database.transitionRun(owner.ownerId, run.id, cancelled() ? 'cancelled' : 'failed',
        cancelled() ? undefined : `任务提交失败：${error?.message ?? error}`)
    }
    if (cancelled() && !['cancelled', 'failed'].includes(this.database.getRun(owner.ownerId, run.id).status))
      return await this.stopRun(owner, run.id)
    return runDto(this.database.getRun(owner.ownerId, run.id))
  }

  async resourceContent(content, value, tools = []) {
    const mentions = normalizeResourceMentions(value)
    const skills = mentions.skills.length ? await this.listSkills() : []
    return appendResourceInstructions(content, mentions, tools, skills)
  }

  async mcpCatalog(owner, { required = false } = {}) {
    try {
      const payload = await this.platformClient.json({ owner, method: 'GET', route: 'mcp/catalog' })
      const tools = payload.data?.tools ?? payload.tools ?? []
      if (!Array.isArray(tools)) throw httpError(502, '平台 MCP 目录格式无效')
      return tools.map(normalizeMcpResource)
    } catch (error) {
      if (!required && [502, 503].includes(error?.status)) return []
      throw error
    }
  }

  async freezeMcpTools(owner, selectedIds) {
    if (!selectedIds?.length) return []
    const catalog = await this.mcpCatalog(owner, { required: true })
    const byId = new Map(catalog.map((tool) => [tool.id, tool]))
    return selectedIds.map((id) => {
      const tool = byId.get(id)
      if (!tool) throw httpError(409, `MCP 工具已不可用：${id}`)
      return tool
    })
  }

  async resources() {
    const [personal, mcp, globalSkills] = await Promise.all([
      this.fileManager.personalResources({ operation: 'list' }),
      this.fileManager.personalMcp({ operation: 'mcp_list' }),
      this.listSkills(),
    ])
    const skills = (personal.skills ?? []).map((skill) => {
      try {
        const metadata = skillMetadata(skill.content)
        if (metadata.name !== skill.id) throw new Error('技能目录名与 name 不一致')
        return { ...skill, ...metadata, scope: 'personal', readonly: false }
      } catch (error) {
        return { ...skill, name: skill.id, description: '', enabled: false, scope: 'personal', readonly: false, error: error.message }
      }
    })
    return {
      memory: personal.memory ?? { content: '', version: null }, skills, mcp: mcp.mcp ?? [],
      warnings: [...(personal.warnings ?? []), ...(mcp.warnings ?? [])],
      global: { files: [], tools: [], knowledge: [], skills: globalSkills.filter((skill) => skill.scope === 'global') },
    }
  }

  async mutateResource(body) {
    const operation = body?.operation
    if (typeof operation !== 'string') throw httpError(400, '缺少资源操作')
    if (operation === 'skill_inspect') {
      const inspected = await this.fileManager.personalResources(body)
      const metadata = skillMetadata(inspected.content)
      const snapshot = await this.fileManager.personalResources({ operation: 'list' })
      const previous = (snapshot.skills ?? []).find((skill) => skill.id === metadata.name)
      return { name: metadata.name, version: previous?.version ?? null }
    }
    if (operation === 'skill_import') {
      const inspected = await this.fileManager.personalResources({ ...body, operation: 'skill_inspect' })
      const metadata = skillMetadata(inspected.content)
      return this.fileManager.personalResources({ ...body, name: metadata.name })
    }
    if (operation === 'skill_update') {
      const metadata = skillMetadata(body.content)
      if (metadata.name !== body.name) throw httpError(400, '编辑时不能修改技能 name')
    }
    if (operation.startsWith('mcp_')) return this.fileManager.personalMcp(body)
    if (!['memory_update', 'skill_import', 'skill_update', 'skill_uninstall', 'skill_toggle', 'skill_pin'].includes(operation))
      throw httpError(400, '不支持的个人资源操作')
    return this.fileManager.personalResources(body)
  }

  async listSkills() {
    const skills = await this.skills.list({ cwd: this.workspace })
    return skills.map((skill) => ({
      id: skill.name, name: skill.name, description: skill.description, path: skill.path ?? '',
      enabled: true, readonly: skill.source === 'custom' || skill.source === 'bundled',
      scope: skill.source === 'custom' || skill.source === 'bundled' ? 'global' : 'personal',
      provider: skill.provider,
    }))
  }

  async inspectSkill(name) {
    const skill = await this.skills.get(name, { cwd: this.workspace })
    if (!skill) throw httpError(404, '技能不存在')
    return { id: skill.name, name: skill.name, description: skill.description, path: skill.path ?? '', content: skill.content,
      enabled: true, readonly: skill.source === 'custom' || skill.source === 'bundled',
      scope: skill.source === 'custom' || skill.source === 'bundled' ? 'global' : 'personal' }
  }

  async issueCommand(owner, chatId, body, { allowTodoClear = false } = {}) {
    let chat = this.requireChat(owner, chatId)
    const requestKey = typeof body.request_key === 'string' && body.request_key ? body.request_key : undefined
    if (!requestKey) throw httpError(400, '缺少 request_key')
    if (requestKey.startsWith('run-stop:')) throw httpError(400, 'request_key 格式无效')
    const receipt = this.database.getCommandReceipt(owner.ownerId, chatId, requestKey)
    if (receipt) return receipt
    const key = `${owner.ownerId}:${chatId}:${requestKey}`
    if (this.inflightCommands.has(key)) return this.inflightCommands.get(key)
    const control = this.database.getControl(owner.ownerId, chatId)
    if (body.expected_revision !== undefined && body.expected_revision !== control.revision)
      throw httpError(409, '控制状态版本已改变，请刷新后重试')
    const line = String(body.command ?? '').trim()
    if (!/^\/(?:goal|plan|compact)(?:\s|$)/.test(line) && !(allowTodoClear && line === '/todos-clear'))
      throw httpError(400, '不支持的工作台命令')
    const operation = (async () => {
      chat = await this.withChatMutation(chatId, () => this.ensureChatSession(owner, this.requireChat(owner, chatId), { allowActive: true }))
      const agent = this.agents.get(chat.sessionId)
      if (!agent) throw httpError(409, '会话暂时无法恢复，请稍后重试')
      const execution = await this.commands.execute(agent, line, [], new AbortController().signal)
      if (!execution) throw httpError(400, '命令不存在或参数无效')
      if (execution.result?.kind === 'error') throw httpError(409, execution.result.text)
      const plan = /^\/plan\s+(.+)$/.exec(line)?.[1]?.trim()
      if (plan) {
        const current = this.database.getControl(owner.ownerId, chatId)
        this.database.updateControlBySession(chat.sessionId, {
          plan: plan === 'off'
            ? { ...current.plan, active: false, pending: true }
            : { ...current.plan, objective: plan },
        })
      }
      const result = { state: this.database.getControl(owner.ownerId, chatId), message: execution.result?.text ?? '', run: null }
      return this.database.saveCommandReceipt(owner.ownerId, chatId, requestKey, result)
    })()
    this.inflightCommands.set(key, operation)
    try { return await operation }
    finally { this.inflightCommands.delete(key) }
  }

  async clearTodos(owner, chatId, body) {
    const result = await this.issueCommand(owner, chatId, { ...body, command: '/todos-clear' }, { allowTodoClear: true })
    return result.state
  }

  getControl(owner, chatId) {
    this.requireChat(owner, chatId)
    return this.database.getControl(owner.ownerId, chatId)
  }

  followups(owner, chatId, tracked) {
    this.requireChat(owner, chatId)
    return { runs: this.database.followups(owner.ownerId, chatId, tracked).map((run) => this.inputRunDto(owner, run)) }
  }

  async stopSubmission(owner, chatId, requestKey) {
    this.requireChat(owner, chatId)
    if (typeof requestKey !== 'string' || !/^[\w-]{1,128}$/.test(requestKey))
      throw httpError(400, 'request_key 格式无效')
    // Persist independently of admission's chat lock: cancellation must win
    // even while attachments, model setup or sandbox discovery are stalled.
    this.database.saveCommandReceipt(owner.ownerId, chatId, `run-stop:${requestKey}`, { cancelled: true })
    const run = this.database.findRunByRequestKey(owner.ownerId, chatId, requestKey)
    if (run) {
      try { return { accepted: true, run: await this.stopRun(owner, run.id) } }
      catch (error) {
        if (error.status !== 409 || run.messageId) throw error
        // Admission sees the durable cancellation before/after prompt delivery.
      }
    }
    return { accepted: true, run: null }
  }

  stopRun(owner, runId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (['completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered'].includes(run.status)) return runDto(run)
    if (this.scheduler && !this.database.submission(owner.ownerId, run.id)?.dispatched && run.status === 'queued') {
      return runDto(this.database.transitionRun(owner.ownerId, run.id, 'cancelled'))
    }
    const active = this.database.activeRun(owner.ownerId, run.chatId)
    if (active?.id !== run.id) {
      if (!run.messageId) throw httpError(409, '排队消息尚未持久化，请稍后重试')
      return this.sessions.updateQueue({ sessionId: run.sessionId, itemId: run.messageId, action: { kind: 'remove' } })
        .then(() => runDto(this.database.transitionRun(owner.ownerId, run.id, 'cancelled')))
    }
    this.database.transitionRun(owner.ownerId, run.id, 'stopping')
    try { this.sessions.cancel({ sessionId: run.sessionId }) }
    catch (error) {
      this.database.transitionRun(owner.ownerId, run.id, run.status)
      throw httpError(502, `暂停请求未确认，请重试：${error?.message ?? error}`)
    }
    return runDto(this.database.getRun(owner.ownerId, run.id))
  }

  async supplement(owner, sourceRunId, body) {
    const source = this.database.getRun(owner.ownerId, sourceRunId)
    if (!source) throw httpError(404, '任务不存在')
    const input = this.database.listPendingInputs(owner.ownerId, sourceRunId).find((value) => value.requestId === body.request_id)
    if (!input) throw httpError(404, '问题不存在')
    if (input.answer?.supplement_run_id) return this.getRun(owner, input.answer.supplement_run_id)
    if (input.status !== 'skipped') throw httpError(409, '只有已跳过的问题可以补答')
    const answer = typeof body.action === 'string' && body.action
      ? body.action
      : Object.values(body.values ?? {}).filter((value) => typeof value === 'string' && value).join('\n')
    if (!answer) throw httpError(400, '补充回答不能为空')
    const chat = this.requireChat(owner, source.chatId)
    const requestKey = `input-supplement:${input.requestId}`
    const existing = this.database.findRunByRequestKey(owner.ownerId, chat.id, requestKey)
    if (existing && existing.query !== answer) throw httpError(409, '该补答请求已使用不同的回答')
    const { run, created } = this.database.createRun({
      ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: answer, mcpTools: existing?.mcpTools ?? await this.freezeMcpTools(owner, source.selection.tools), selection: source.selection, requestKey,
      parentRunId: source.id,
    })
    if (created || (run.status === 'queued' && !run.messageId)) {
      if (created) this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_status', status: 'queued' })
      const fields = input.payload.args?.fields ?? []
      const context = fields.map((field) => ({ question: field.label, answer: body.values?.[field.name] ?? null }))
      const content = [{ type: 'text', text: `用户补答了之前跳过的提问，请结合这些新信息继续处理当前任务，必要时修正之前的假设。\n${JSON.stringify(context)}\n补充回答：${answer}` }]
      const active = this.database.activeRun(owner.ownerId, chat.id)
      if (active && active.id !== run.id && ['running', 'waiting_input'].includes(active.status)) {
        await this.sessions.prompt({ requestId: run.id, sessionId: active.sessionId, mode: 'steer', content }, new AbortController().signal)
        this.database.transitionRun(owner.ownerId, run.id, 'steered')
        this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_steered', steer_target_run_id: active.id })
        this.database.appendEvent(owner.ownerId, active.id, {
          event: 'workbench_steering', steering_id: run.id, query: answer, attachments: [],
        })
      } else if (this.scheduler) await this.scheduler.enqueue(run, content)
      else await this.sessions.prompt({ requestId: run.id, sessionId: run.sessionId, mode: 'queue', content }, new AbortController().signal)
    }
    this.database.recordInputSupplement(owner.ownerId, sourceRunId, input.requestId, {
      values: body.values ?? {}, action: body.action ?? null,
      custom_fields: body.custom_fields ?? [], skipped_fields: body.skipped_fields ?? [], supplement_run_id: run.id,
    })
    return this.getRun(owner, run.id)
  }

  async removeQueued(owner, runId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (run.status === 'discarded') return runDto(run)
    if (run.status !== 'queued') throw httpError(409, '只有排队中的消息可以删除')
    if (this.scheduler && !this.database.submission(owner.ownerId, run.id)?.dispatched)
      return runDto(this.database.transitionRun(owner.ownerId, run.id, 'discarded'))
    if (!run.messageId) throw httpError(409, '排队消息尚未持久化，请稍后重试')
    await this.sessions.updateQueue({ sessionId: run.sessionId, itemId: run.messageId, action: { kind: 'remove' } })
    return runDto(this.database.transitionRun(owner.ownerId, run.id, 'discarded'))
  }

  async steer(owner, runId, targetRunId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (run.status === 'steered') {
      const accepted = this.getRun(owner, runId)
      if (accepted.steer_target_run_id === targetRunId) return accepted
      throw httpError(409, '消息已直接发送到其他任务')
    }
    const active = this.database.activeRun(owner.ownerId, run.chatId)
    if (!active || active.id !== targetRunId || !['running', 'waiting_input'].includes(active.status)) throw httpError(409, '目标任务已不再运行')
    if (run.status !== 'queued') throw httpError(409, '排队消息尚不能插话')
    const pending = this.scheduler && this.database.submission(owner.ownerId, run.id)
    if (pending && !pending.dispatched) {
      await this.sessions.prompt({ requestId: run.id, sessionId: active.sessionId, mode: 'steer', content: pending.content }, new AbortController().signal)
    } else {
      if (!run.messageId) throw httpError(409, '排队消息尚不能插话')
      await this.sessions.updateQueue({ sessionId: run.sessionId, itemId: run.messageId, action: { kind: 'steer' } })
    }
    this.database.transitionRun(owner.ownerId, run.id, 'steered')
    this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_steered', steer_target_run_id: targetRunId })
    this.database.appendEvent(owner.ownerId, targetRunId, {
      event: 'workbench_steering', steering_id: run.id, query: run.query, attachments: run.attachments ?? [],
    })
    return this.getRun(owner, run.id)
  }

  getRun(owner, runId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    return this.inputRunDto(owner, run, this.database.allEvents(owner.ownerId, run.id))
  }

  inputRunDto(owner, run, events = []) {
    const inputs = this.database.listPendingInputs(owner.ownerId, run.id)
    const steering = this.database.steeringEvents(owner.ownerId, run.id)
    return {
      ...runDto(run, events, inputs.at(-1)),
      ...this.database.runTiming(owner.ownerId, run.id),
      steer_target_run_id: steering.find((event) => event.event === 'workbench_steered')?.steer_target_run_id,
      steering_messages: steering.filter((event) => event.event === 'workbench_steering').map((event) => ({
        id: event.steering_id, query: event.query, attachments: event.attachments ?? [],
      })),
      human_input_history: inputs.filter((input) => ['skipped', 'submitted'].includes(input.status)).map((input) => {
        const answers = input.answer?.answers ?? []
        const values = input.answer?.values ?? Object.fromEntries(answers.map((answer) => [answer.id, answer.custom ?? answer.selected?.[0] ?? '']))
        return {
          ...input.payload, request_id: input.requestId, status: input.status, values,
          action: input.answer?.action ?? (input.payload.tool_name === 'exit_plan_mode' ? Object.values(values)[0] || null : null),
          custom_fields: input.answer?.custom_fields ?? answers.filter((answer) => answer.custom).map((answer) => answer.id),
          skipped_fields: input.answer?.skipped_fields ?? (input.payload.args.fields ?? []).filter((field) => !values[field.name]).map((field) => field.name),
          ...(input.answer?.supplement_run_id ? { supplement_run_id: input.answer.supplement_run_id } : {}),
        }
      }),
    }
  }

  requireChat(owner, chatId) {
    const chat = this.database.getChat(owner.ownerId, chatId)
    if (!chat) throw httpError(404, '会话不存在或已被删除')
    return chat
  }
}

function normalizeMcpResource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, '平台 MCP 工具格式无效')
  const required = ['id', 'runtime_name', 'version', 'scope', 'server_id', 'tool_name', 'description', 'inputSchema']
  if (required.some((key) => value[key] === undefined)) throw httpError(502, '平台 MCP 工具缺少必要字段')
  if (typeof value.id !== 'string' || value.id.length > 260 || !value.id) throw httpError(502, '平台 MCP 工具 ID 无效')
  if (typeof value.runtime_name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.runtime_name)) throw httpError(502, '平台 MCP 运行名无效')
  if (typeof value.version !== 'string' || !value.version || !['global', 'personal'].includes(value.scope)) throw httpError(502, '平台 MCP 工具版本或范围无效')
  if (typeof value.server_id !== 'string' || typeof value.tool_name !== 'string' || typeof value.description !== 'string') throw httpError(502, '平台 MCP 工具元数据无效')
  if (!value.inputSchema || typeof value.inputSchema !== 'object' || Array.isArray(value.inputSchema)) throw httpError(502, '平台 MCP 参数 schema 无效')
  return {
    id: value.id, runtime_name: value.runtime_name, version: value.version, manifest_version: value.manifest_version ?? '',
    scope: value.scope, server_id: value.server_id, tool_name: value.tool_name,
    name: value.name ?? value.tool_name, display_name: value.display_name ?? value.name,
    description: value.description, inputSchema: value.inputSchema,
    group: value.group ?? 'mcp', provider: value.provider ?? 'mcp',
    provider_name: value.provider_name ?? value.server_id,
  }
}

function skillMetadata(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 65_536) throw new Error('SKILL.md 无效或超过 64 KiB')
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') throw new Error('SKILL.md 缺少 YAML 文件头')
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) throw new Error('SKILL.md YAML 文件头不完整')
  const metadata = yaml.load(lines.slice(1, end).join('\n'), { schema: yaml.JSON_SCHEMA })
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('SKILL.md 文件头无效')
  if (typeof metadata.name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(metadata.name)) throw new Error('技能 name 无效')
  if (typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 2000) throw new Error('技能 description 无效')
  return { name: metadata.name, description: metadata.description.trim() }
}

function splitModel(value) {
  if (typeof value !== 'string' || value.indexOf('/') <= 0 || value.endsWith('/')) throw httpError(400, '模型标识无效')
  const position = value.indexOf('/')
  return { provider: value.slice(0, position), model: value.slice(position + 1) }
}

function normalizeSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '配置无效')
  const selection = {
    model: value.model, tools: value.tools ?? [], skills: value.skills ?? [], knowledge: value.knowledge ?? [],
    model_parameters: value.model_parameters ?? {}, tool_parameters: value.tool_parameters ?? {},
  }
  for (const field of ['tools', 'skills', 'knowledge']) {
    if (!Array.isArray(selection[field]) || selection[field].some((item) => typeof item !== 'string')) throw httpError(400, '资源配置无效')
    if (field !== 'tools' && selection[field].length) throw httpError(501, '技能选择与知识库尚未接入此版本')
  }
  if (Object.keys(selection.tool_parameters).length || Object.keys(selection.model_parameters).some((key) => key !== 'reasoning_effort'))
    throw httpError(400, '不支持的模型或工具参数')
  if (selection.model_parameters.reasoning_effort !== undefined && typeof selection.model_parameters.reasoning_effort !== 'string')
    throw httpError(400, '思考强度参数无效')
  splitModel(selection.model)
  return selection
}

export function runDto(run, events = [], pending = null) {
  const waiting = pending?.status === 'pending' ? pending : null
  return {
    id: run.id, chat_id: run.chatId, revision_id: run.id, version: 1, query: run.query,
    created_at: run.createdAt / 1000,
    can_fork: ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) && Number.isInteger(run.selection?.fork_source?.endSeq ?? run.sourceEndSeq),
    resource_mentions: normalizeResourceMentions(run.selection?.resource_mentions),
    status: run.status, error: run.error, feedback: run.feedback ?? null, events, events_cursor: `${run.seq}-0`,
    queue_order: run.queueOrder, parent_run_id: run.parentRunId ?? null,
    activity_protocol: 1, followup_protocol: 1, message_id: run.messageId ?? null, attachments: run.attachments ?? [],
    pending: waiting?.payload ?? null,
    human_input: waiting ? {
      request_id: waiting.requestId, tool_call_id: waiting.payload.tool_call_id,
      deadline_at: waiting.deadlineAt == null ? null : Math.floor(waiting.deadlineAt / 1000),
      interacted: waiting.interacted, server_now: Math.floor(Date.now() / 1000),
    } : null,
  }
}
