import yaml from 'js-yaml'
import { admitSandboxAttachments } from './attachments.js'
import { httpError } from './http.js'

export class WorkbenchService {
  constructor({ database, sessionController, agents, commands, skills, fileManager, platformClient, workspace }) {
    this.database = database
    this.sessions = sessionController
    this.agents = agents
    this.commands = commands
    this.skills = skills
    this.fileManager = fileManager
    this.platformClient = platformClient
    this.workspace = workspace
    this.inflightCommands = new Map()
    this.chatMutations = new Map()
  }

  async createChat(owner, workspace, selection) {
    const created = await this.sessions.create({ cwd: workspace })
    return this.database.createChat({ ownerId: owner.ownerId, sessionId: created.sessionId, selection })
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
      return this.chatSummary(owner, this.database.updateChat(owner.ownerId, chatId, patch))
    })
  }

  async updateConfig(owner, chatId, body) {
    return this.withChatMutation(chatId, async () => {
      const chat = this.requireChat(owner, chatId)
      if (body.version !== chat.version) throw httpError(409, '配置版本已改变，请刷新后重试')
      if (this.database.activeRun(owner.ownerId, chatId)) throw httpError(409, '任务运行时不能修改模型配置')
      const selection = normalizeSelection(body.selection)
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

  async regenerate(owner, sourceRunId, body) {
    const source = this.database.getRun(owner.ownerId, sourceRunId)
    if (!source) throw httpError(404, '任务不存在')
    if (!Number.isInteger(source.turnNumber)) throw httpError(409, '原任务尚未形成可重新生成的轮次')
    return this.withChatMutation(source.chatId, async () => {
      const chat = this.requireChat(owner, source.chatId)
      const requestKey = typeof body.request_key === 'string' ? body.request_key : undefined
      const existing = this.database.findRunByRequestKey(owner.ownerId, chat.id, requestKey)
      if (existing && existing.status !== 'failed') return runDto(existing, this.database.allEvents(owner.ownerId, existing.id))
      if (existing) {
        if (existing.parentRunId !== source.id) throw httpError(409, 'request_key 已用于其他重新生成任务')
        const admitted = await admitSandboxAttachments({ fileManager: this.fileManager, workspace: this.workspace, query: existing.query, files: existing.attachments })
        this.database.transitionRun(owner.ownerId, existing.id, 'queued')
        this.database.appendEvent(owner.ownerId, existing.id, { event: 'workbench_status', status: 'queued' })
        try {
          if (existing.selection.model) await this.sessions.selectModel({ sessionId: existing.sessionId, ...splitModel(existing.selection.model), ...(existing.selection.model_parameters?.reasoning_effort ? { reasoningEffort: existing.selection.model_parameters.reasoning_effort } : {}) })
          await this.sessions.prompt({ requestId: existing.id, sessionId: existing.sessionId, mode: 'queue', content: admitted.content }, new AbortController().signal)
        } catch (error) {
          this.database.transitionRun(owner.ownerId, existing.id, 'failed', `重新生成提交失败：${error?.message ?? error}`)
        }
        return runDto(this.database.getRun(owner.ownerId, existing.id))
      }
      if (chat.sessionId !== source.sessionId) throw httpError(409, '只能从当前会话分支重新生成')
      if (this.database.activeRun(owner.ownerId, chat.id)) throw httpError(409, '任务运行时不能重新生成')
      const previous = this.database.previousRun(source.sessionId, source.turnNumber)
      const child = previous
        ? await this.sessions.fork({ sessionId: source.sessionId, atSeq: previous.sourceEndSeq })
        : await this.sessions.create({ cwd: this.workspace })
      const query = typeof body.query === 'string' && body.query.trim() ? body.query : source.query
      const admitted = await admitSandboxAttachments({ fileManager: this.fileManager, workspace: this.workspace, query, files: source.attachments })
      const { run } = this.database.createRun({
        ownerId: owner.ownerId, chatId: chat.id, sessionId: child.sessionId, query,
        attachments: admitted.attachments, mcpTools: await this.freezeMcpTools(owner, source.selection.tools), selection: source.selection, requestKey, parentRunId: source.id,
      })
      this.database.switchChatSession(owner.ownerId, chat.id, source.sessionId, child.sessionId)
      this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_status', status: 'queued' })
      try {
        if (source.selection.model) await this.sessions.selectModel({ sessionId: child.sessionId, ...splitModel(source.selection.model), ...(source.selection.model_parameters?.reasoning_effort ? { reasoningEffort: source.selection.model_parameters.reasoning_effort } : {}) })
        await this.sessions.prompt({ requestId: run.id, sessionId: child.sessionId, mode: 'queue', content: admitted.content }, new AbortController().signal)
      } catch (error) {
        this.database.transitionRun(owner.ownerId, run.id, 'failed', `重新生成提交失败：${error?.message ?? error}`)
      }
      return runDto(this.database.getRun(owner.ownerId, run.id))
    })
  }

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
    return this.withChatMutation(chatId, () => {
      this.requireChat(owner, chatId)
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
      has_active_run: Boolean(active), is_running: Boolean(active), needs_input: active?.status === 'waiting_input',
    }
  }

  async submitRun(owner, chatId, body) {
    return this.withChatMutation(chatId, () => this.admitRun(owner, chatId, body))
  }

  async admitRun(owner, chatId, body) {
    const chat = this.requireChat(owner, chatId)
    if (body.version !== undefined && body.version !== chat.version)
      throw httpError(409, '配置版本已改变，请刷新后重试')
    const query = String(body.query ?? '')
    const files = Array.isArray(body.files) ? body.files : []
    if (!query.trim() && !files.length) throw httpError(400, '消息内容不能为空')
    const requestKey = typeof body.request_key === 'string' ? body.request_key : undefined
    const existing = this.database.findRunByRequestKey(owner.ownerId, chatId, requestKey)
    if (existing && existing.status !== 'failed') return runDto(existing, this.database.allEvents(owner.ownerId, existing.id))
    const fileKeys = files.map((file) => ({ path: file?.path, version: file?.version }))
    const existingKeys = existing?.attachments?.map((file) => ({ path: file.path, version: file.version }))
    if (existing && (existing.query !== query || JSON.stringify(existingKeys) !== JSON.stringify(fileKeys)))
      throw httpError(409, 'request_key 已用于不同的任务内容')
    const mcpTools = existing?.mcpTools ?? await this.freezeMcpTools(owner, chat.selection.tools)
    const admitted = await admitSandboxAttachments({ fileManager: this.fileManager, workspace: this.workspace, query, files })
    const { run, created } = this.database.createRun({
      ownerId: owner.ownerId, chatId, sessionId: chat.sessionId, query, attachments: admitted.attachments, mcpTools,
      selection: chat.selection, requestKey,
      parentRunId: typeof body.continue_run_id === 'string' ? body.continue_run_id : undefined,
    })
    if (!created && run.status !== 'failed') return runDto(run, this.database.allEvents(owner.ownerId, run.id))
    if (!created) this.database.transitionRun(owner.ownerId, run.id, 'queued')
    this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_status', status: 'queued' })
    try {
      if (run.selection.model) {
        const active = this.database.activeRun(owner.ownerId, chatId)
        if (active?.id === run.id)
          await this.sessions.selectModel({ sessionId: chat.sessionId, ...splitModel(run.selection.model), ...(run.selection.model_parameters?.reasoning_effort ? { reasoningEffort: run.selection.model_parameters.reasoning_effort } : {}) })
        else if (active?.selection?.model !== run.selection.model) throw httpError(409, '排队任务不能切换当前运行模型')
      }
      await this.sessions.prompt({
        requestId: run.id, sessionId: chat.sessionId, mode: 'queue',
        content: admitted.content,
      }, new AbortController().signal)
    } catch (error) {
      this.database.transitionRun(owner.ownerId, run.id, 'failed', `任务提交失败：${error?.message ?? error}`)
    }
    return runDto(this.database.getRun(owner.ownerId, run.id))
  }

  async mcpCatalog(owner, { required = false } = {}) {
    try {
      const payload = await this.platformClient.json({ owner, method: 'GET', route: 'mcp/catalog' })
      const tools = payload.data?.tools ?? payload.tools ?? []
      if (!Array.isArray(tools)) throw httpError(502, '平台 MCP 目录格式无效')
      return tools.map(normalizeMcpResource)
    } catch (error) {
      if (!required && error?.status === 503) return []
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
    const chat = this.requireChat(owner, chatId)
    const requestKey = typeof body.request_key === 'string' && body.request_key ? body.request_key : undefined
    if (!requestKey) throw httpError(400, '缺少 request_key')
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
    const agent = this.agents.get(chat.sessionId)
    if (!agent) throw httpError(409, '会话当前不在线，请先发送一条消息')
    const operation = (async () => {
      const execution = await this.commands.execute(agent, line, [], new AbortController().signal)
      if (!execution) throw httpError(400, '命令不存在或参数无效')
      if (execution.result?.kind === 'error') throw httpError(409, execution.result.text)
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
    return { runs: this.database.followups(owner.ownerId, chatId, tracked).map((run) => runDto(run)) }
  }

  stopRun(owner, runId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (['completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered'].includes(run.status)) return runDto(run)
    const active = this.database.activeRun(owner.ownerId, run.chatId)
    if (active?.id !== run.id) {
      if (!run.messageId) throw httpError(409, '排队消息尚未持久化，请稍后重试')
      return this.sessions.updateQueue({ sessionId: run.sessionId, itemId: run.messageId, action: { kind: 'remove' } })
        .then(() => runDto(this.database.transitionRun(owner.ownerId, run.id, 'cancelled')))
    }
    this.database.transitionRun(owner.ownerId, run.id, 'stopping')
    try { this.sessions.cancel({ sessionId: run.sessionId }) }
    catch { return runDto(this.database.transitionRun(owner.ownerId, run.id, 'cancelled')) }
    return runDto(this.database.getRun(owner.ownerId, run.id))
  }

  async supplement(owner, sourceRunId, body) {
    const source = this.database.getRun(owner.ownerId, sourceRunId)
    if (!source) throw httpError(404, '任务不存在')
    const answer = typeof body.action === 'string' && body.action
      ? body.action
      : Object.values(body.values ?? {}).filter((value) => typeof value === 'string' && value).join('\n')
    if (!answer) throw httpError(400, '补充回答不能为空')
    const chat = this.requireChat(owner, source.chatId)
    const { run, created } = this.database.createRun({
      ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: answer, mcpTools: await this.freezeMcpTools(owner, source.selection.tools), selection: source.selection, requestKey: body.request_key,
      parentRunId: source.id,
    })
    if (created) {
      this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_status', status: 'queued' })
      await this.sessions.prompt({ requestId: run.id, sessionId: run.sessionId, mode: 'queue', content: [{ type: 'text', text: answer }] }, new AbortController().signal)
    }
    return runDto(this.database.getRun(owner.ownerId, run.id))
  }

  async removeQueued(owner, runId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (run.status === 'discarded') return runDto(run)
    if (run.status !== 'queued') throw httpError(409, '只有排队中的消息可以删除')
    if (!run.messageId) throw httpError(409, '排队消息尚未持久化，请稍后重试')
    await this.sessions.updateQueue({ sessionId: run.sessionId, itemId: run.messageId, action: { kind: 'remove' } })
    return runDto(this.database.transitionRun(owner.ownerId, run.id, 'discarded'))
  }

  async steer(owner, runId, targetRunId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    const active = this.database.activeRun(owner.ownerId, run.chatId)
    if (!active || active.id !== targetRunId) throw httpError(409, '目标任务已不再运行')
    if (run.status !== 'queued' || !run.messageId) throw httpError(409, '排队消息尚不能插话')
    await this.sessions.updateQueue({ sessionId: run.sessionId, itemId: run.messageId, action: { kind: 'steer' } })
    return runDto(this.database.transitionRun(owner.ownerId, run.id, 'steered'))
  }

  getRun(owner, runId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    const pending = this.database.getPendingInput(owner.ownerId, run.id)
    return runDto(run, this.database.allEvents(owner.ownerId, run.id), pending)
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
    name: value.name ?? value.tool_name, description: value.description, inputSchema: value.inputSchema,
    provider: value.provider ?? 'mcp', provider_name: value.provider_name ?? value.server_id,
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
