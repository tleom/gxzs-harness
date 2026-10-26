import { platformToolNames } from '@gxzs/dsh-workbench-mcp-tools/names'
import { readSkillDefinition, skillDisplayName } from '@gxzs/dsh-workbench-sandbox-skills/definition'
import { orderGlobalSkills } from '@gxzs/dsh-workbench-sandbox-skills/global'
import { randomInt, randomUUID } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { decodeSessionReferenceUri, formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { admitSandboxAttachments, prepareNativeFiles } from './attachments.js'
import { normalizeResourceMentions, appendResourceInstructions, pluginId, pluginName, resolvePlugin, positionResourceMentions, resourceTextHash, goalMentionResources } from './resource-mentions.js'
import { appendSkillInvocations, assertSkillInvocationClaims, resolveSkillInvocations, skillGestureNames, skillInvocationClaims } from './skill-invocations.js'
import { mentionProviders } from './mcp-catalog.js'
import { httpError } from './http.js'
import { isSkillImportFailure, skillImportFailure } from './skill-import.js'
import { decodeCursor } from './cursor.js'
import { resolveWorkspacePath } from './paths.js'
import { forkChat } from './fork-chat.js'
import { inputSupplement, toAnswer } from './human-input.js'
import { requireDatabaseModel } from './database-models.js'
import { currentExecutionRun, fenceMcpExecutions } from './scheduler.js'
import { nativeTurn } from './native-turn.js'
import { fitsHistoryResponse, hasEarlierContent, historyWindow, historyWindowFor, loadNativeHistoryPage, smallerHistoryWindow } from './history-page.js'
import { nativePresentation } from './projection.js'
import { HistoryPresentation } from './history-presentation.js'
import { historyDisplayEvent, historyEventMetadata, historyFrameMetadata } from './history-transport.js'
import { withGoalUpdates } from './goal-updates.js'
import { withNativeCommandRun, nativeCommandRecords } from './native-command.js'
import { dispatchRunPrompt } from './native-prompt.js'
import { goalFailureReason, presentRunEvent, resumeGoalSelection, runFailure } from './run-failure.js'
import { ownedSessionRoots } from './owned-session-roots.js'
import { DirectoryLifecycle } from './directory-lifecycle.js'

const directoryAdjectives = ['calm', 'clear', 'cool', 'fair', 'fresh', 'gentle', 'green', 'happy', 'light', 'little', 'quiet', 'silver', 'soft', 'sunny', 'warm', 'wild']
const directoryNouns = ['birch', 'brook', 'cedar', 'cloud', 'dawn', 'fern', 'field', 'forest', 'grove', 'hill', 'lake', 'leaf', 'maple', 'meadow', 'moon', 'moss', 'oak', 'ocean', 'olive', 'pearl', 'pine', 'pond', 'reed', 'river', 'shore', 'sky', 'snow', 'star', 'stone', 'sun', 'wave', 'willow']

export class WorkbenchService {
  constructor({ database, sessionController, agents, commands, skills, globalSkillOrder, workingDirectory, onGoalChanged, fileManager, platformClient, workspace, sessionQuery, agentPresets, agentDefaultModel, modelSettings, scheduler, attachments, goals, fileUploads, nativeFileAttachments = false }) {
    this.database = database
    this.sessions = sessionController
    this.agents = agents
    this.commands = commands
    this.skills = skills
    this.globalSkillOrder = globalSkillOrder
    this.workingDirectory = workingDirectory
    this.onGoalChanged = onGoalChanged
    this.fileManager = fileManager
    this.platformClient = platformClient
    this.workspace = workspace
    this.sessionQuery = sessionQuery
    this.agentPresets = agentPresets
    this.agentDefaultModel = agentDefaultModel
    this.modelSettings = modelSettings
    this.inflightCommands = new Map()
    this.chatMutations = new Map()
    this.sessionPreparations = new Map()
    this.scheduler = scheduler
    this.attachments = attachments
    this.goals = goals
    this.fileUploads = fileUploads
    this.nativeFileAttachments = nativeFileAttachments
    this.directories = new DirectoryLifecycle(this)
  }

  async createChat(owner, workspace, selection, workspaceId) {
    return this.directories.run(owner, () => this.createChatLocked(owner, workspace, selection, workspaceId))
  }

  async createChatLocked(owner, workspace, selection, workspaceId) {
    const id = randomUUID()
    if (workspaceId !== undefined) {
      if (!this.workspaces) throw httpError(503, '工作区服务尚未就绪')
      const target = await this.workspaces.requireWorkspace(owner, workspaceId, true)
      this.directories.assertAvailable(owner, this.directories.workspacePath(target))
      const created = await this.sessions.create({ workspaceId: target.workspaceId })
      return this.database.createChat({ id, ownerId: owner.ownerId, sessionId: created.sessionId, selection,
        directory: target.path === '.' ? 'conversations' : `conversations/${target.path}` })
    }
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    await this.fileManager.operate({ operation: 'mkdir', path: `conversations/${date}` })
    // A new chat may start from a terminal before it has a title or first prompt.
    // Reserve the short directory atomically; retain its mapping when the chat is renamed.
    const name = `${directoryAdjectives[randomInt(directoryAdjectives.length)]}-${directoryNouns[randomInt(directoryNouns.length)]}`
    const { path: directory } = await this.fileManager.operate({ operation: 'mkdir', path: `conversations/${date}/${name}`, unique: true })
    const created = await this.sessions.create({ cwd: this.chatDirectory(id, directory) })
    const chat = this.database.createChat({ id, ownerId: owner.ownerId, sessionId: created.sessionId, selection, directory })
    return chat
  }

  chatDirectory(chatId, directory) { return resolveWorkspacePath(this.workspace, directory ?? `conversations/${chatId}`) }

  async referenceCandidates(owner, chatId, query = '', signal = new AbortController().signal) {
    const chat = this.requireChat(owner, chatId)
    await this.ensureChatSession(owner, chat)
    const agent = this.agents.get(chat.sessionId)
    if (!agent || !this.sessionReferences) throw httpError(503, '对话引用服务尚未就绪')
    return this.collectReferenceCandidates(owner, query, signal,
      () => this.fileReferences?.list(agent, query, signal) ?? [],
      (sessionQuery, limit) => this.sessionReferences.listCandidates(agent, sessionQuery, limit, signal))
  }

  async observedReferenceCandidates(owner, observed, query, signal) {
    if (!this.sessionReferences?.listSessionCandidates || (this.fileReferences && !this.fileReferences.listObserved))
      throw httpError(503, '子智能体引用服务尚未就绪')
    return this.collectReferenceCandidates(owner, query, signal,
      () => this.fileReferences?.listObserved(observed, query, signal) ?? [],
      (sessionQuery, limit) => this.sessionReferences.listSessionCandidates(observed.header, sessionQuery, limit, signal))
  }

  async collectReferenceCandidates(owner, query, signal, readFiles, readSessions) {
    const byIdentity = query.startsWith('dsh-session:')
    let sessionQuery = query
    if (byIdentity) {
      try { sessionQuery = decodeSessionReferenceUri(query) }
      catch { throw httpError(400, '无效的对话引用') }
    }
    const [files, metadata, workspace] = await Promise.all([
      !byIdentity ? readFiles() : [],
      this.sessionQuery.listSessions(signal),
      this.workspaces?.baseline(owner, signal, { includeSchedules: false }),
    ])
    // DSH owns matching and ranking. Apply its display limit after platform visibility.
    const candidates = await readSessions(sessionQuery, Math.max(1, metadata.length))
    const archived = new Set(workspace?.archivedSessionIds ?? [])
    const blank = new Set((workspace?.sessions ?? []).filter(item => item.blank === true).map(item => item.sessionId))
    const allowed = ownedSessionRoots(this.database.listChats(owner.ownerId), metadata, archived)
    return [
      ...files.map(item => ({ ...item, group: 'files', label: item.path })),
      ...candidates.filter(item => allowed.has(item.sessionId) && (byIdentity
        ? item.sessionId === sessionQuery
        : !blank.has(item.sessionId) && allowed.get(item.sessionId).rootSessionId === item.sessionId))
        .slice(0, this.sessionReferences.config.candidateLimit)
        .map(({ cwd, ...item }) => ({ ...item, chatId: allowed.get(item.sessionId).chatId,
          ...(allowed.get(item.sessionId).rootSessionId !== item.sessionId ? {
            origin: 'subagent', parentSessionId: allowed.get(item.sessionId).parentSessionId,
          } : {}),
          mention: formatSessionReferenceMention({ sessionId: item.sessionId, label: item.displayTitle ?? item.label }) })),
    ]
  }

  async ensureChatSession(owner, chat) {
    this.requireChat(owner, chat.id)
    let pending = this.sessionPreparations.get(chat.sessionId)
    if (!pending) {
      pending = this.prepareChatSession(owner, chat).finally(() => {
        if (this.sessionPreparations.get(chat.sessionId) === pending) this.sessionPreparations.delete(chat.sessionId)
      })
      this.sessionPreparations.set(chat.sessionId, pending)
    }
    return pending
  }

  async prepareChatSession(owner, chat) {
    await this.ensureChatDirectory(owner, chat.id)
    const cwd = this.chatDirectory(chat.id, chat.directory)
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
    if (header && header.cwd !== cwd)
      throw httpError(409, '会话工作目录与当前配置不一致，请新建对话')
    if (!live) {
      if (header) {
        // Share the native resume promise with history and projection readers.
        // create() has a separate adoption path and can race their writer lease.
        const resolved = await this.sessions.resolveAgent(chat.sessionId)
        if ('error' in resolved) throw resolved.error
        if (resolved.agent.session.header.cwd !== cwd)
          throw httpError(409, '会话工作目录与当前配置不一致，请新建对话')
      } else if (!this.agents.get(chat.sessionId)) {
        // alpha.5 may mint a different ID when the named Session has started.
        // Shared preparation prevents concurrent reference/read and submit paths
        // from treating create() as a second resume operation.
        const created = await this.sessions.create({ sessionId: chat.sessionId, cwd })
        if (created.sessionId !== chat.sessionId)
          throw httpError(409, '会话状态已变化，请重新加载对话')
      }
    }
    return chat
  }

  async ensureChatDirectory(owner, chatId) {
    const chat = this.requireChat(owner, chatId)
    await this.fileManager.operate({ operation: chat.directory ? 'list' : 'mkdir', path: chat.directory ?? `conversations/${chatId}` })
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
      // Legacy chat selections are display preferences, not MCP authority.
      const route = splitModel(selection.model)
      await requireDatabaseModel(this.platformClient, this.sessions, owner, selection.model, this.modelSettings)
      await this.sessions.selectModel({ sessionId: chat.sessionId, ...route, ...(selection.model_parameters.reasoning_effort ? { reasoningEffort: selection.model_parameters.reasoning_effort } : {}) })
      this.database.updateChatConfig(owner.ownerId, chatId, chat.version, selection)
      return this.getChat(owner, chatId)
    })
  }

  fork(owner, sourceRunId, body) { return this.directories.run(owner, () => forkChat(this, owner, sourceRunId, body)) }

  feedback(owner, runId, rating) {
    if (rating !== null && rating !== 'like' && rating !== 'dislike') throw httpError(400, '反馈类型无效')
    this.database.setFeedback(owner.ownerId, runId, rating)
    return this.getRun(owner, runId)
  }

  async modelParameters(modelId, owner) {
    const model = await requireDatabaseModel(this.platformClient, this.sessions, owner, modelId, this.modelSettings)
    if (!model.reasoning?.efforts?.length) return {}
    return { reasoning_effort: {
      type: 'string', options: model.reasoning.efforts.map((effort) => effort.id),
      default: model.reasoning.defaultEffort, label: { zh_Hans: '思考强度', en_US: 'Reasoning Effort' },
    } }
  }

  async deleteChat(owner, chatId) {
    return this.directories.run(owner, () => this.deleteChatLocked(owner, chatId))
  }

  async deleteChatLocked(owner, chatId) {
    return this.withChatMutation(chatId, async () => {
      const pending = this.database.chatDeletion(owner.ownerId, chatId)
      if (pending) {
        if (!pending.completedAt) await this.completeChatDeletion(owner, pending, { refreshFiles: true })
        return
      }
      const chat = this.database.deletionChat(owner.ownerId, chatId)
      if (!chat) throw httpError(404, '会话不存在或已被删除')
      if (!this.permanentDeletion) throw httpError(503, '会话删除服务尚未就绪')
      this.scheduler?.deletingChats.add(chatId)
      try {
        // Legacy soft-deleted rows remain hidden to callers, but deletion must
        // still drain their native activity, fences and admission tickets.
        const access = { includeDeleted: true }
        // Drain an in-flight admission before cancelling; otherwise its prompt
        // could arrive after cancellation and restart the deleted conversation.
        await this.scheduler?.pendingTick
        // Capture background run authority before archive dispatches child stops.
        const cancelling = this.database.listRunReferences(owner.ownerId, chatId)
          .filter(run => ['running', 'waiting_input', 'stopping'].includes(run.status) || this.database.submission(owner.ownerId, run.id)?.dispatched
            || this.hasOwnedWork?.(chat.sessionId, run.id)
            || this.database.pendingRunFences(owner.ownerId, access).some(value => value.id === run.id))
        // Native archive commits the wake-up fence before stopping schedules, jobs and children.
        await this.workspaces?.controller?.archiveSession?.({ sessionId: chat.sessionId, stopActivity: true })
        await this.closeTerminals?.(chat.sessionId)
        const agent = this.agents.get(chat.sessionId)
        for (const run of cancelling) this.database.requireRunFence(owner.ownerId, run.id, access)
        if (agent) {
          const goal = this.goals?.get(agent)
          if (goal?.phase === 'active') this.goals.pause(agent, { id: goal.id, revision: goal.revision })
          agent.cancel({ kind: 'user' }, { keepInbox: false })
        }
        const confirmation = await fenceMcpExecutions(this.platformClient, owner, cancelling.map(run => run.id))
        if (agent) await agent.whenIdle()
        await this.waitSessionActivity?.(chat.sessionId)
        for (const run of cancelling) this.database.confirmRunFence(owner.ownerId, run.id, confirmation, access)
        for (const run of this.database.listRunReferences(owner.ownerId, chatId)) {
          if (['queued', 'running', 'waiting_input', 'stopping'].includes(run.status))
            this.database.transitionRun(owner.ownerId, run.id, 'cancelled', undefined, Date.now(), access)
          if (this.scheduler && this.database.submission(owner.ownerId, run.id)) {
            await this.scheduler.request(run, 'release')
            this.database.finishSubmission(owner.ownerId, run.id, access)
          }
        }
        const path = this.directories.chatPath(chat)
        const sessionIds = await this.permanentDeletion.prepare(chat)
        // Retain the shared path even when another fork currently owns it. A
        // failed erasure can be retried after that other fork has been deleted.
        let fileDeletion = path.startsWith('conversations/') ? { path } : undefined
        if (await this.directories.canCleanChat(owner, chat, path)) {
          const entry = await this.fileManager.operate({ operation: 'stat', path })
          if (entry.kind !== 'missing') fileDeletion = { path, version: entry.version }
        }
        const deletion = this.database.beginChatDeletion(owner.ownerId, chatId, sessionIds, fileDeletion)
        await this.completeChatDeletion(owner, deletion)
      } finally {
        this.scheduler?.deletingChats.delete(chatId)
      }
    })
  }

  async completeChatDeletion(owner, deletion, { refreshFiles = false } = {}) {
    if (!this.permanentDeletion) throw httpError(503, '会话删除服务尚未就绪')
    if (deletion.fileDeletion) {
      const { path, version } = deletion.fileDeletion
      if (await this.directories.canCleanChat(owner, { id: deletion.chatId }, path)) {
        const entry = await this.fileManager.operate({ operation: 'stat', path })
        if (entry.kind !== 'missing') await this.fileManager.operate({ operation: 'delete', path, version: refreshFiles || !version ? entry.version : version })
      }
    }
    await this.permanentDeletion.erase(deletion)
    this.database.finishChatDeletion(owner.ownerId, deletion.chatId)
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

  getChat(owner, chatId, includeEvents = false) {
    const chat = this.requireChat(owner, chatId)
    return { ...this.chatSummary(owner, chat), selection: chat.selection, runs: this.database.listRunReferences(owner.ownerId, chat.id).filter(run => !run.nativeChild).map((run) => this.getRun(owner, run.id, includeEvents)) }
  }

  async historyPage(owner, chatId, cursor, signal, nativeLive = false) {
    const chat = this.requireChat(owner, chatId)
    let maxMessages = historyWindow.maxMessages, throughSeq
    while (true) {
      const page = await loadNativeHistoryPage(this, chat.sessionId, cursor, signal, { maxMessages, throughSeq })
      throughSeq = page.through_seq
      const value = this.historyPageView(owner, chat, page, cursor === undefined, nativeLive)
      if (!nativeLive || fitsHistoryResponse(value, maxMessages)) return value
      maxMessages = smallerHistoryWindow(maxMessages)
    }
  }

  historyPageView(owner, chat, page, opening, nativeLive) {
    const runs = new Map(), tools = new Map(), turns = new Map()
    let currentTurn
    for (const { event } of page.records) {
      if (Number.isInteger(event.data?.turn)) currentTurn = event.data.turn
      const turn = event.data?.turn ?? currentTurn
      if (!Number.isInteger(turn)) continue
      if (!turns.has(turn)) turns.set(turn, this.database.runForTurn(chat.sessionId, turn))
      const run = turns.get(turn)
      if (!run) continue
      let view = runs.get(run.id)
      if (!view) {
        view = this.inputRunDto(owner, run)
        runs.set(run.id, view)
      }
      if (event.type === 'tool/call') tools.set(`${run.id}:${event.data.callId}`, event.data.name)
      const block = event.data?.message?.content?.[0]
      const callId = event.data?.message?.source?.callId ?? block?.toolCallId
      for (const [index, payload] of nativePresentation(run, event, { messageRun: event.type === 'user/message' ? this.database.runForMessage(chat.sessionId, event.data?.id) : undefined,
        toolName: tools.get(`${run.id}:${callId}`)
        ?? (callId ? this.database.toolCallName(owner.ownerId, run.id, callId) : '') ?? '' }).entries()) {
        view.events.push({ ...historyDisplayEvent(payload), _id: `history:${chat.sessionId}:${event.seq}:${index}` })
      }
    }
    // The live run uses its existing SSE snapshot/cursor as one atomic pair.
    // Older windows are read-only; they must never replace a newer live view.
    if (opening) for (const run of this.database.listRunReferences(owner.ownerId, chat.id)) {
      if (run.nativeChild) continue
      if (['queued', 'running', 'waiting_input', 'stopping'].includes(run.status)
        || (run.sourceStartSeq == null && run.sourceEndSeq == null)
        || run.sourceEndSeq > page.through_seq || run.sourceStartSeq > page.through_seq) {
        runs.set(run.id, nativeLive ? (runs.get(run.id) ?? this.inputRunDto(owner, this.database.getRun(owner.ownerId, run.id)))
          : { ...this.getRun(owner, run.id, true), history_complete: true })
      }
    }
    return { ...this.chatSummary(owner, chat), selection: chat.selection,
      ...page, records: page.records.map(({ event }) => ({ event: historyEventMetadata(event) })), history_cursor: page.cursor,
      runs: [...runs.values()].map(run => nativeLive ? { ...run, native_history: true } : run) }
  }

  async *followHistory(owner, chatId, signal) {
    const chat = this.requireChat(owner, chatId)
    const presentation = new HistoryPresentation(chat.sessionId, turn =>
      Number.isInteger(turn) ? this.database.runForTurn(chat.sessionId, turn) : undefined,
      (run, callId) => callId ? this.database.toolCallName(owner.ownerId, run.id, callId) : undefined,
      messageId => this.database.runForMessage(chat.sessionId, messageId),
      turn => Number.isInteger(turn) ? this.database.streamRunForTurn(chat.sessionId, turn) : undefined)
    const source = this.sessions.follow({ address: { kind: 'session', sessionId: chat.sessionId },
      ...historyWindow, assistantStream: true }, signal)
    for await (const original of withGoalUpdates(source, this.subscribeGoal
      ? listener => this.subscribeGoal(chat.sessionId, listener) : undefined, signal)) {
      signal.throwIfAborted()
      // Directory changes replace the native session. End the old subscription
      // instead of combining two different source logs in one conversation.
      if (this.requireChat(owner, chatId).sessionId !== chat.sessionId) return
      let frame = original, maxMessages = historyWindow.maxMessages
      while (true) {
        const turns = new Set()
        if (frame.type === 'snapshot') {
          for (const { event } of frame.records) if (Number.isInteger(event.data?.turn)) turns.add(event.data.turn)
          if (frame.assistantStream?.activeAttempt) turns.add(frame.assistantStream.activeAttempt.turn)
        } else if (frame.type === 'event' && Number.isInteger(frame.event.data?.turn)) turns.add(frame.event.data.turn)
        else if (frame.type === 'assistant-stream' && frame.frame.type === 'start') turns.add(frame.frame.turn)
        const runs = new Map(), bindings = []
        for (const turn of turns) {
          const run = this.database.runForTurn(chat.sessionId, turn)
          if (!run) continue
          runs.set(run.id, this.inputRunDto(owner, run))
          bindings.push({ turn, run_id: run.id })
        }
        // Project the complete native frame locally. Only the display content and
        // coordinates used by the UI cross the transport boundary, once each.
        const value = frame.type === 'snapshot' ? {
          type: frame.type, cursor: frame.cursor, records: frame.records,
          hasMore: frame.hasMore && await hasEarlierContent(this.sessions, chat.sessionId,
            frame.cursor, frame.records[0]?.event.seq, signal), assistantStream: frame.assistantStream,
        } : frame
        const updatesControl = frame.type === 'snapshot' || frame.type === 'goal-state'
          || (frame.type === 'event' && (['goal/change', 'plan/mode', 'command/run', 'command/done', 'turn/end', 'request/context', 'assistant/message', 'assistant/attempt', 'compaction/end'].includes(frame.event.type)
            || (frame.event.type === 'user/message' && ['goal', 'compact-checkpoint'].includes(frame.event.data?.source?.kind))))
        const update = { event: 'workbench_history', session_id: chat.sessionId, value: historyFrameMetadata(value), runs: [...runs.values()], bindings,
          ...(updatesControl ? { control: await this.getControl(owner, chatId) } : {}),
          display: frame.type === 'goal-state' ? { events: [], replace: false, retire_attempts: [] } : presentation.accept(frame) }
        if (fitsHistoryResponse(update, frame.type === 'snapshot' ? maxMessages : 1)) {
          yield update
          break
        }
        // Ask DSH to choose a smaller native message/surface boundary at the
        // same cursor. Do not truncate records or advance past an unread page.
        maxMessages = smallerHistoryWindow(frame.type === 'snapshot' ? maxMessages : 1)
        const page = await this.sessions.page({ address: { kind: 'session', sessionId: chat.sessionId },
          throughSeq: original.cursor, ...historyWindowFor(maxMessages) }, signal)
        signal.throwIfAborted()
        frame = { ...original, records: page.records, hasMore: page.hasMore }
      }
    }
  }

  async changes(owner, chatId, seqValue, indexValue, signal) {
    const chat = this.requireChat(owner, chatId)
    const integer = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))
    if (!integer(seqValue) || (indexValue !== null && !integer(indexValue))) throw httpError(400, '文件改动坐标无效')
    if (!this.workspaceChanges) throw httpError(503, '文件改动服务尚未就绪')
    const seq = Number(seqValue)
    if (indexValue !== null) {
      const value = await this.workspaceChanges.diff(chat.sessionId, seq, Number(indexValue), signal)
      if (!value) throw httpError(404, '该轮文件差异已不可用')
      return value
    }
    const value = this.workspaceChanges.summary(chat.sessionId, seq)
    // Native snapshots live only with the recording Host/Session. Absence after
    // restart is normal; the UI must omit a card whose content no longer exists.
    if (!value) return null
    const {turn, files, total, added, deleted} = value
    return {turn, files: files.map(file => {
      // Native paths are relative to the recorded turn's cwd, not the current UI folder.
      // Only owner-workspace files can be opened by the Workbench file service.
      try {
        const absolute = resolveWorkspacePath(this.workspace, path.posix.resolve(value.cwd, file.path))
        return {...file, workspacePath: path.posix.relative(this.workspace, absolute)}
      } catch { return file }
    }), total, added, deleted}
  }

  chatSummary(owner, chat) {
    const active = this.database.activeRun(owner.ownerId, chat.id)
    const waiting = active?.status === 'waiting_input' ? this.database.getPendingInput(owner.ownerId, active.id) : null
    const pendingInteraction = waiting?.payload?.questions?.some(question => question.intent?.kind === 'plan-review') ? 'plan-review' : 'question'
    return {
      id: chat.id, sessionId: chat.sessionId, title: chat.title, version: chat.version, pinned: chat.pinned, favorited: chat.favorited,
      file_directory: chat.directory ?? `conversations/${chat.id}`,
      created_at: Math.floor(chat.createdAt / 1000), updated_at: Math.floor(chat.updatedAt / 1000),
      has_active_run: Boolean(active), is_running: ['queued', 'running', 'stopping'].includes(active?.status), needs_input: active?.status === 'waiting_input',
      control_run: active?.selection?.native_child ? this.getRun(owner, active.id, false) : null,
      pending_interaction: waiting?.status === 'pending' ? pendingInteraction : null,
      has_error: !active && this.database.latestRunStatus(owner.ownerId, chat.id) === 'failed',
    }
  }

  async submitRun(owner, chatId, body) {
    return this.withChatMutation(chatId, () => this.admitRun(owner, chatId, body))
  }

  async admitRun(owner, chatId, body, command) {
    let chat = this.requireChat(owner, chatId)
    const requestKey = typeof body.request_key === 'string' ? body.request_key : undefined
    if (requestKey !== undefined && (requestKey.length === 0 || requestKey.length > 128 || requestKey.includes('\0')))
      throw httpError(400, 'request_key 格式无效')
    // A submission key is an immutable receipt, including failed executions.
    // Explicit retries submit a new key and retain parent_run_id for lineage.
    const existing = this.database.findRunByRequestKey(owner.ownerId, chatId, requestKey)
    if (existing) return this.getRun(owner, existing.id)
    if (body.mode !== undefined && !['queue', 'steer'].includes(body.mode))
      throw httpError(400, '消息提交方式无效')
    if (body.version !== undefined && body.version !== chat.version)
      throw httpError(409, '配置版本已改变，请刷新后重试')
    if (body.silent_resume === true && typeof body.continue_run_id !== 'string')
      throw httpError(400, '继续任务必须指定原任务')
    const silentResume = body.silent_resume === true
    const query = silentResume ? 'resume' : String(body.query ?? '')
    const mentions = normalizeResourceMentions(body.resource_mentions)
    const files = Array.isArray(body.files) ? body.files : []
    if (silentResume && files.length) throw httpError(400, '后台继续不能携带附件，请发送新消息')
    if (silentResume && mentions.skills.length) throw httpError(400, '后台继续不能新增技能引用，请发送带技能标签的新消息')
    if (!query.trim() && !files.length) throw httpError(400, '消息内容不能为空')
    const cancelled = () => requestKey && this.database.getCommandReceipt(owner.ownerId, chatId, `run-stop:${requestKey}`)
    const checkCancelled = () => { if (cancelled()) throw httpError(409, '消息已取消') }
    checkCancelled()
    await requireDatabaseModel(this.platformClient, this.sessions, owner, chat.selection.model, this.modelSettings)
    let parentRunId = body.retry_of ?? body.continue_run_id ?? body.parent_run_id ?? this.database.listRunReferences(owner.ownerId, chatId)
      .filter((run) => !['discarded', 'steered'].includes(run.status)).at(-1)?.id
    if (parentRunId != null) {
      const parent = this.database.getRun(owner.ownerId, parentRunId)
      if (!parent || parent.chatId !== chatId) throw httpError(409, '上级任务不属于当前会话')
      if (body.retry_of && !['failed', 'interrupted', 'cancelled'].includes(parent.status))
        throw Object.assign(httpError(409, '原任务尚未失败或中断'), { code: 'STALE_RUN' })
    }
    // Admission is serialized per chat: a normal follow-up belongs after the
    // actual queue tail, even if the client's active-run snapshot is stale.
    if (!body.continue_run_id && !body.retry_of) {
      const tail = this.database.listRunReferences(owner.ownerId, chatId)
        .filter((run) => ['queued', 'running', 'waiting_input', 'stopping'].includes(run.status)).at(-1)
      if (tail) parentRunId = tail.id
    }
    // Plugin references express preference inside the authorized MCP catalog.
    // Skill references become explicit native user invocation gestures.
    const { tools: mcpTools, servers: mcpServers } = await this.freezeMcpCatalog(owner, mentions.tools, mentions.plugins)
    const mentionTools = mentionProviders(mcpTools, mcpServers)
    checkCancelled()
    const admitted = await admitSandboxAttachments({ fileManager: this.fileManager, workspace: this.workspace, query, files, nativeFiles: this.nativeFileAttachments, attachmentStore: this.attachments })
    chat = await this.ensureChatSession(owner, chat)
    const agent = this.agents.get(chat.sessionId)
    const selectedSkills = await this.selectedSkills(mentions, agent)
    admitted.content = await this.resourceContent(admitted.content, mentions, mentionTools, agent, selectedSkills, body.mention_positions)
    checkCancelled()
    const { run, created } = this.database.createRun({
      ownerId: owner.ownerId, chatId, sessionId: chat.sessionId, query, attachments: admitted.attachments, mcpTools,
      selection: { ...chat.selection, mcp_servers: mcpServers, ...(silentResume ? { silent_resume: true } : {}),
        ...(!silentResume && body.mode ? { prompt_mode: body.mode } : {}), resource_mentions: mentions,
        mentioned_resources: await this.mentionSnapshot(mentions, mentionTools, agent, body.mention_positions, query),
        skill_names: await this.skillNames(agent), skill_invocations: skillInvocationClaims(selectedSkills), ...(command ? { command } : {}) }, requestKey,
      parentRunId,
    })
    if (!created) return this.getRun(owner, run.id)
    this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_status', status: 'queued' })
    if (this.scheduler) {
      checkCancelled()
      try { await this.scheduler.enqueue(run, admitted.content) }
      catch (error) {
        this.database.transitionRun(owner.ownerId, run.id, 'failed', `任务提交失败：${error?.message ?? error}`)
        this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_end', status: 'failed', error: `任务提交失败：${error?.message ?? error}` })
        throw error
      }
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
      await dispatchRunPrompt(this, run, admitted.content)
    } catch (error) {
      this.database.transitionRun(owner.ownerId, run.id, cancelled() ? 'cancelled' : 'failed',
        cancelled() ? undefined : `任务提交失败：${error?.message ?? error}`)
    }
    if (cancelled() && !['cancelled', 'failed'].includes(this.database.getRun(owner.ownerId, run.id).status))
      return await this.stopRun(owner, run.id)
    return runDto(this.database.getRun(owner.ownerId, run.id))
  }

  async resourceContent(content, value, tools = [], agent, selected, positions) {
    const mentions = normalizeResourceMentions(value)
    selected ??= await this.selectedSkills(mentions, agent)
    return appendSkillInvocations(appendResourceInstructions(content, mentions, tools, positions), selected)
  }

  /** Wrap the native SkillTool pre-step hook, including restored inbox claims. */
  async guardSkillInvocations({ agent, messages = [], turn, signal }, next) {
    const sessionId = agent.session?.id ?? agent.id
    const checks = new Map()
    for (const message of messages) {
      if (message.source?.kind !== 'user') continue
      const run = this.database.runForMessage(sessionId, message.id)
        ?? (!message.source.rpcId ? this.database.runForTurn(sessionId, turn) : undefined)
      if (!run?.selection.resource_mentions?.skills?.length) continue
      const names = skillGestureNames(message.content)
      const mentions = normalizeResourceMentions(run.selection.resource_mentions)
      // Older durable submissions did not store identity. Resolve once in the
      // same scoped view, retaining the legacy bare personal alias contract.
      const claims = run.selection.skill_invocations ?? skillInvocationClaims(await this.selectedSkills(mentions, agent))
      if (!run.selection.skill_invocations)
        this.database.updateRunResources(run, { ...run.selection, skill_invocations: claims }, run.mcpTools)
      for (const claim of claims) if (names.has(claim.name)) checks.set(`${run.id}:${claim.name}`, claim)
    }
    if (!checks.size) return next()
    const claims = [...checks.values()]
    const validate = async () => {
      signal?.throwIfAborted()
      const current = await this.selectedSkills({ skills: [...new Set(claims.map(claim => claim.name))] }, agent, signal)
      assertSkillInvocationClaims(current, claims)
      signal?.throwIfAborted()
    }
    await validate()
    const decision = await next()
    if (decision.kind === 'reject') return decision
    await validate()
    const invoked = new Set(decision.messages.filter(message => message.source?.kind === 'skill-invocation')
      .map(message => message.source.name))
    for (const claim of claims) if (!invoked.has(claim.name))
      throw httpError(409, `所选技能未能加载，请检查是否仍启用后重试：${claim.name}`, 'SKILL_SELECTION_UNAVAILABLE')
    return decision
  }

  async selectedSkills(mentions, agent, signal) {
    if (!mentions.skills.length) return []
    if (!agent || !this.workingDirectory) throw httpError(409, '会话技能服务暂时不可用，请稍后重试')
    const cwd = await this.workingDirectory.ensure(agent, signal)
    return resolveSkillInvocations(this.skills, mentions.skills, { agent, cwd, signal })
  }

  async mentionSnapshot(mentions, tools, agent, positions, text = '') {
    const skills = mentions.skills.length ? await this.listSkills(agent) : []
    return positionResourceMentions([
      ...groupPluginMentions([...(mentions.plugins ?? []).map(id => {
        const tool = resolvePlugin(tools, id)
        return { id: pluginName(tool), kind: 'tools', name: tool.provider_name ?? pluginName(tool) }
      }), ...mentions.tools.map(id => {
        const tool = tools.find(item => item.id === id)
        if (tool?.server_id) resolvePlugin(tools, pluginId(tool))
        return { id: tool?.server_id ? pluginName(tool) : id, kind: 'tools', name: tool?.provider_name ?? tool?.server_id ?? id }
      })], tools),
      ...mentions.skills.map(id => {
        const skill = skills.find(item => item.id === id || item.name === id || `personal:${item.name}` === id)
        return { id, kind: 'skills', name: skill?.displayName ?? skill?.name ?? id }
      }),
    ], positions, text.length, tools)
  }

  async skillNames(agent) {
    return Object.fromEntries((await this.listSkills(agent)).map(skill => [skill.name, skill.displayName ?? skill.name]))
  }

  async mcpCatalog(owner, { required = false, includePlugins = false } = {}) {
    try {
      const payload = await this.platformClient.json({ owner, method: 'GET', route: 'mcp/catalog',
        timeoutMs: (this.platformClient.mcpPolicy?.catalog_timeout_seconds ?? 180) * 1000 })
      const tools = payload.data?.tools ?? payload.tools ?? []
      if (!Array.isArray(tools)) throw httpError(502, '平台 MCP 目录格式无效')
      const normalized = tools.map(normalizeMcpResource)
      const names = platformToolNames(normalized)
      const items = normalized.map(tool => ({ ...tool, runtime_name: names.get(tool.id) }))
      const plugins = payload.data?.plugins ?? payload.plugins ?? []
      if (!Array.isArray(plugins)) throw httpError(502, '平台插件目录格式无效')
      return includePlugins ? { tools: items, plugins } : items
    } catch (error) {
      const transient = [502, 503, 504].includes(error?.status) || ['TimeoutError', 'TypeError'].includes(error?.name)
      if (transient)
        throw Object.assign(httpError(503, 'MCP 工具目录暂不可用，请稍后重试'), { code: 'MCP_CATALOG_UNAVAILABLE' })
      throw error
    }
  }

  async freezeMcpTools(owner, selectedIds, selectedPlugins = []) {
    return (await this.freezeMcpCatalog(owner, selectedIds, selectedPlugins)).tools
  }

  async freezeMcpCatalog(owner, selectedIds, selectedPlugins = []) {
    const snapshot = this.refreshMcpCatalog ? await this.refreshMcpCatalog(owner)
      : await this.mcpCatalog(owner, { required: true, includePlugins: true })
    const rawTools = Array.isArray(snapshot) ? snapshot : snapshot.tools
    const catalog = this.refreshMcpCatalog ? rawTools.map(normalizeMcpResource) : rawTools
    const servers = (Array.isArray(snapshot) ? [] : snapshot.plugins ?? []).filter(server => server.available !== false)
    const byId = new Map(catalog.map((tool) => [tool.id, tool]))
    for (const id of selectedIds ?? [])
      if (!byId.has(id)) throw httpError(409, `MCP 工具已不可用：${id}`)
    for (const id of selectedPlugins)
      resolvePlugin(mentionProviders(catalog, servers), id)
    return { tools: catalog, servers }
  }

  async pluginInventory(owner) {
    const payload = await this.platformClient.json({ owner, method: 'GET', route: 'mcp/plugins' })
    const plugins = payload.data?.plugins ?? payload.plugins
    if (!Array.isArray(plugins) || plugins.some(item => !item || typeof item.name !== 'string' || typeof item.id !== 'string'))
      throw httpError(502, '平台插件目录格式无效')
    return plugins
  }

  async resources(owner) {
    const [personal, mcp, globalSkills] = await Promise.all([
      this.fileManager.personalResources({ operation: 'list' }),
      this.fileManager.personalMcp({ operation: 'mcp_list' }),
      this.listSkills(),
    ])
    const skills = await Promise.all((personal.skills ?? []).map(async (skill) => {
      try {
        const metadata = await readSkillDefinition(skill.content, { id: skill.id })
        if (metadata.name !== skill.id) throw new Error('技能目录名与 name 不一致')
        if (globalSkills.some(global => global.scope === 'global' && global.name === metadata.name))
          return { ...skill, ...metadata, content: skill.content, scope: 'personal', readonly: false,
            error: `调用名 ${metadata.name} 与全局技能冲突，请修改个人技能的调用名` }
        return { ...skill, ...metadata, content: skill.content, scope: 'personal', readonly: false }
      } catch (error) {
        return { ...skill, name: skill.id, description: '', enabled: false, scope: 'personal', readonly: false, error: error.message }
      }
    }))
    const plugins = owner ? await this.pluginInventory(owner) : []
    const names = new Map()
    for (const plugin of plugins) names.set(plugin.name, (names.get(plugin.name) ?? 0) + 1)
    const issues = plugins.flatMap(plugin => {
      const error = !/^[a-z][a-z0-9_-]{0,63}$/.test(plugin.name) ? '名称须以小写字母开头，只含小写字母、数字、下划线或连字符，最多 64 位'
        : names.get(plugin.name) > 1 ? '调用名重复，请修改后使用' : null
      return error ? [{ id: plugin.id, name: plugin.name, error }] : []
    })
    return {
      skills, mcp: (mcp.mcp ?? []).map(item => {
        const issue = issues.find(issue => issue.id === `personal:mcp:${item.id}`)
        return issue ? { ...item, error: `${issue.name}：${issue.error}` } : item
      }),
      skill_order_version: personal.order_version ?? null, mcp_order_version: mcp.order_version ?? null,
      plugin_name_issues: issues,
      warnings: [...(personal.warnings ?? []), ...(mcp.warnings ?? []), ...skills.filter(skill => skill.error).map(skill => skill.error),
        ...issues.map(issue => `${issue.name}：${issue.error}`)],
      global: { files: [], tools: [], knowledge: [], skills: globalSkills.filter((skill) => skill.scope === 'global') },
    }
  }

  async mutateResource(body, owner, sendPackage = payload => signal
    ? this.fileManager.personalResources(payload, signal) : this.fileManager.personalResources(payload), signal) {
    const operation = body?.operation
    if (typeof operation !== 'string') throw httpError(400, '缺少资源操作')
    if (['skill_import_cancel', 'skill_import_status'].includes(operation))
      return this.fileManager.personalResources(body)
    if (operation === 'skill_stage') {
      let staged
      try {
        staged = await sendPackage(body)
        const metadata = await readImportedSkill(staged.content)
        await this.assertNoGlobalSkillCollision(metadata.name)
        const prepared = await this.fileManager.personalResources({ operation: 'skill_prepare',
          import_id: staged.import_id, name: metadata.name,
          ...(Object.hasOwn(body, 'version') ? { version: body.version } : {}) }, signal)
        if (prepared.conflict)
          await this.fileManager.personalResources({ operation: 'skill_import_cancel', import_id: staged.import_id }).catch(() => {})
        return { ...prepared, displayName: metadata.displayName }
      } catch (error) {
        if (staged?.import_id) await this.fileManager.personalResources({ operation: 'skill_import_cancel', import_id: staged.import_id }).catch(() => {})
        throw error
      }
    }
    if (operation === 'skill_inspect') {
      const inspected = await sendPackage(body)
      const metadata = await readImportedSkill(inspected.content)
      const snapshot = await this.fileManager.personalResources({ operation: 'list' })
      const previous = (snapshot.skills ?? []).find((skill) => skill.id === metadata.name)
      return { name: metadata.name, displayName: metadata.displayName, version: previous?.version ?? null }
    }
    if (operation === 'skill_import') {
      if (body.import_id) {
        const current = await this.fileManager.personalResources({ operation: 'skill_import_status', import_id: body.import_id }, signal)
        if (current.status === 'completed') return current
        if (current.status !== 'ready')
          return this.fileManager.personalResources(body, signal)
        const inspected = await this.fileManager.personalResources({ operation: 'skill_inspect', import_id: body.import_id }, signal)
        const metadata = await readImportedSkill(inspected.content)
        await this.assertNoGlobalSkillCollision(metadata.name)
        return this.fileManager.personalResources({ ...body, name: metadata.name }, signal)
      }
      const import_id = randomUUID().replaceAll('-', '')
      let prepared
      try {
        prepared = await this.mutateResource({ ...body, operation: 'skill_stage', import_id,
          version: body.version ?? null }, owner, sendPackage, signal)
        if (prepared.conflict) return { conflict: true }
        let result = await this.mutateResource({ operation: 'skill_import', import_id,
          version: prepared.version }, owner, sendPackage, signal)
        const deadline = Date.now() + 600_000
        while (['ready', 'running', 'pending'].includes(result.status) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 200))
          signal?.throwIfAborted()
          result = await this.fileManager.personalResources({ operation: 'skill_import_status', import_id }, signal)
        }
        if (result.conflict || result.status === 'conflict') return { conflict: true }
        if (result.status !== 'completed') throw skillImportFailure(result)
        return Object.fromEntries(['id', 'version', 'path'].filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]]))
      } catch (error) {
        if (!prepared || isSkillImportFailure(error)) throw error
        const settled = await this.fileManager.personalResources({ operation: 'skill_import_cancel', import_id }).catch(stopError => {
          if (isSkillImportFailure(stopError)) throw stopError
          return null
        })
        if (settled?.status === 'completed')
          return Object.fromEntries(['id', 'version', 'path'].filter(key => Object.hasOwn(settled, key)).map(key => [key, settled[key]]))
        if (settled && ['failed', 'cancelled', 'conflict'].includes(settled.status)) throw skillImportFailure(settled)
        throw error
      }
    }
    if (operation === 'skill_update') {
      const metadata = await readImportedSkill(body.content)
      if (metadata.name !== (body.new_name ?? body.name)) throw httpError(400, '技能调用名与 SKILL.md 中的 name 不一致')
      if (metadata.name !== body.name) await this.assertNoGlobalSkillCollision(metadata.name)
    }
    if (operation === 'skill_toggle' && body.enabled === true) await this.assertNoGlobalSkillCollision(body.name)
    if (operation.startsWith('mcp_')) {
      if (operation === 'mcp_save' || operation === 'mcp_toggle' && body.enabled === true) {
        const name = body.new_name ?? body.name
        if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name))
          throw httpError(400, '插件调用名须以小写字母开头，只含小写字母、数字、下划线或连字符，最多 64 位')
        const plugins = await this.pluginInventory(owner)
        if (plugins.some(plugin => plugin.name === name && plugin.id !== `personal:mcp:${body.name}`))
          throw httpError(409, `插件调用名已存在：${name}`)
      }
      return this.fileManager.personalMcp(body, signal)
    }
    if (!['skill_import', 'skill_update', 'skill_uninstall', 'skill_toggle', 'skill_reorder'].includes(operation))
      throw httpError(400, '不支持的个人资源操作')
    return this.fileManager.personalResources(body)
  }

  async listSkills(agent) {
    const cwd = agent && this.workingDirectory ? await this.workingDirectory.ensure(agent) : this.workspace
    const skills = await this.skills.list({ cwd, ...(agent ? { scope: agent } : {}) })
    const resources = skills.map((skill) => ({
      id: skill.name, name: skill.name, displayName: skillDisplayName(skill), metadata: skill.metadata, source: skill.source, invocation: skill.invocation, description: skill.description, path: skill.path ?? '',
      enabled: true, readonly: skill.provider !== 'gxzs-sandbox-personal',
      scope: skill.provider === 'gxzs-sandbox-personal' ? 'personal' : 'global',
      provider: skill.provider,
    }))
    return this.globalSkillOrder ? orderGlobalSkills(resources, await this.globalSkillOrder()) : resources
  }

  async catalogSkills(owner, chatId) {
    if (!chatId) return this.listSkills()
    return this.withChatMutation(chatId, async () => {
      const chat = await this.ensureChatSession(owner, this.requireChat(owner, chatId))
      const agent = this.agents.get(chat.sessionId)
      if (!agent) throw httpError(409, '会话技能服务暂时不可用，请稍后重试')
      return this.listSkills(agent)
    })
  }

  async assertNoGlobalSkillCollision(name) {
    const existing = (await this.listSkills()).find(skill => skill.name === name)
    if (existing?.scope === 'global') throw httpError(409, `技能调用名与全局技能冲突：${name}`)
  }

  async inspectSkill(name) {
    const skill = await this.skills.get(name, { cwd: this.workspace })
    if (!skill) throw httpError(404, '技能不存在')
    return { id: skill.name, name: skill.name, displayName: skillDisplayName(skill), metadata: skill.metadata, source: skill.source, invocation: skill.invocation, description: skill.description, path: skill.path ?? '', content: skill.content,
      enabled: true, readonly: skill.provider !== 'gxzs-sandbox-personal',
      scope: skill.provider === 'gxzs-sandbox-personal' ? 'personal' : 'global' }
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
    if (/^\/compact(?:\s|$)/.test(line) && body.files?.length)
      throw httpError(400, '/compact 不接受附件')
    // Sandbox path receipts are not native AttachmentContent. Reject control
    // attachments before converting them so non-image files cannot disappear.
    if (/^\/plan\s+off$/.test(line) && body.files?.length)
      throw httpError(400, 'Attachments cannot accompany /plan off.')
    if (/^\/goal(?:\s+(?:pause|resume|clear|edit))?$/i.test(line) && body.files?.length)
      throw httpError(400, 'Attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>.')
    if (!/^\/(?:goal|plan|compact)(?:\s|$)/.test(line) && !(allowTodoClear && line === '/todos-clear'))
      throw httpError(400, '不支持的工作台命令')
    const operation = this.withChatMutation(chatId, async () => {
      const latestControl = this.database.getControl(owner.ownerId, chatId)
      if (body.expected_revision !== undefined && body.expected_revision !== latestControl.revision)
        throw httpError(409, '控制状态版本已改变，请刷新后重试')
      chat = await this.ensureChatSession(owner, this.requireChat(owner, chatId))
      const agent = this.agents.get(chat.sessionId)
      if (!agent) throw httpError(409, '会话暂时无法恢复，请稍后重试')
      if (line === '/compact' && body.background === true) {
        // DSH appends command/run synchronously before entering its handler.
        // Release admission and HTTP as soon as that native identity exists;
        // command/done remains the sole settlement authority, including errors.
        const before = new Set(agent.session.snapshotEvents().filter(event => event.type === 'command/run').map(event => event.data.commandId))
        const execution = this.commands.execute(agent, line, [], new AbortController().signal)
        const started = agent.session.snapshotEvents().find(event => event.type === 'command/run' && !before.has(event.data.commandId))
        if (!started) {
          await execution
          throw httpError(400, '压缩命令不可用')
        }
        void execution.catch(() => {}) // Native command/done records handler failures.
        const result = { accepted: true, command_id: started.data.commandId, state: await this.getControl(owner, chatId), message: '', run: null }
        return this.database.saveCommandReceipt(owner.ownerId, chatId, requestKey, result)
      }
      const planTask = /^\/plan\s+(?!off\s*$)([\s\S]+)$/.exec(line)
      if (planTask || line === '/plan' && body.files?.length) {
        const mentions = normalizeResourceMentions(body.resource_mentions)
        const { tools: mcpTools, servers: mcpServers } = await this.freezeMcpCatalog(owner, mentions.tools, mentions.plugins)
        const mentionTools = mentionProviders(mcpTools, mcpServers)
        const selectedSkills = await this.selectedSkills(mentions, agent)
        const admitted = body.files?.length
          ? await admitSandboxAttachments({ fileManager: this.fileManager, workspace: this.workspace, query: '', files: body.files, nativeFiles: this.nativeFileAttachments, attachmentStore: this.attachments })
          : { content: [], attachments: [] }
        const resourceContext = appendResourceInstructions(admitted.content.filter(item => item.type === 'text'), mentions, mentionTools)
          .map(item => item.text).join('\n')
        const planQuery = planTask?.[1] ?? admitted.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
        const nativeQuery = appendSkillInvocations(appendResourceInstructions([{ type: 'text', text: planQuery }], mentions, mentionTools, body.mention_positions).slice(0, 1), selectedSkills)
          .map(item => item.text).join('\n')
        const planLine = `/plan${nativeQuery ? ` ${nativeQuery}` : ''}`
        if (agent.status !== 'running' && chat.selection.model) {
          await requireDatabaseModel(this.platformClient, this.sessions, owner, chat.selection.model, this.modelSettings)
          await this.sessions.selectModel({ sessionId: chat.sessionId, ...splitModel(chat.selection.model),
            ...(chat.selection.model_parameters?.reasoning_effort ? { reasoningEffort: chat.selection.model_parameters.reasoning_effort } : {}) })
        }
        const run = this.database.createRun({ ownerId: owner.ownerId, chatId, sessionId: chat.sessionId,
          query: planQuery, attachments: admitted.attachments, selection: { ...chat.selection, mcp_servers: mcpServers, command: 'plan',
            resource_mentions: mentions, mentioned_resources: await this.mentionSnapshot(mentions, mentionTools, agent, body.mention_positions, planQuery),
            skill_names: await this.skillNames(agent), skill_invocations: skillInvocationClaims(selectedSkills),
            resource_context: resourceContext }, mcpTools, requestKey: `plan:${requestKey}` }).run
        let execution
        try {
          execution = await withNativeCommandRun(run, async () => this.commands.execute(agent, planLine,
            await this.commandAttachments(agent, admitted.content), new AbortController().signal))
          if (!execution || execution.result?.kind === 'error') throw httpError(409, execution?.result?.text ?? '计划模式不可用')
        } catch (error) {
          this.database.transitionRun(owner.ownerId, run.id, 'failed', error.message)
          throw error
        }
        const result = { state: await this.getControl(owner, chatId), message: execution.result?.text ?? '', run: this.getRun(owner, run.id) }
        return this.database.saveCommandReceipt(owner.ownerId, chatId, requestKey, result)
      }
      const editsGoal = /^\/goal\s+edit\s/i.test(line)
      const startsGoal = /^\/goal\s+/.test(line) && !/^\/goal\s+(?:pause|clear|edit)$/i.test(line)
        && (!editsGoal || this.goals?.get(agent)?.phase === 'complete')
      let goalRun
      let createdGoalRun = false
      const previousGoalRun = this.database.goalRun(chat.sessionId)
      const resumesGoal = /^\/goal\s+resume\s*$/i.test(line)
      const previousMentions = normalizeResourceMentions(previousGoalRun?.selection.resource_mentions)
      if (resumesGoal && body.resource_mentions !== undefined) {
        const requested = normalizeResourceMentions(body.resource_mentions)
        // Existing composers send an empty selection even for control commands.
        if (Object.values(requested).some(ids => ids.length) && Object.keys(previousMentions).some(kind => requested[kind].length !== previousMentions[kind].length
          || requested[kind].some(id => !previousMentions[kind].includes(id))))
          throw httpError(409, '恢复目标沿用原资源引用；请先编辑目标资源后再恢复')
      }
      const goalMentions = resumesGoal ? previousMentions : normalizeResourceMentions(body.resource_mentions ??
        (editsGoal ? previousGoalRun?.selection.resource_mentions : undefined))
      const selectedGoalSkills = startsGoal || editsGoal ? await this.selectedSkills(goalMentions, agent) : []
      if ((resumesGoal || editsGoal && body.resource_mentions === undefined) && previousGoalRun?.selection.skill_invocations)
        assertSkillInvocationClaims(selectedGoalSkills, previousGoalRun.selection.skill_invocations)
      const admitted = body.files?.length
        ? await admitSandboxAttachments({ fileManager: this.fileManager, workspace: this.workspace, query: '', files: body.files, nativeFiles: this.nativeFileAttachments, attachmentStore: this.attachments })
        : { content: [], attachments: [] }
      const commandAttachments = await this.commandAttachments(agent, admitted.content)
      let editedResources
      if (editsGoal && !startsGoal && previousGoalRun && (body.resource_mentions !== undefined
        || previousGoalRun.selection.resource_position_hash || body.mention_positions?.length)) {
        const mentions = goalMentions
        const { tools: mcpTools, servers: mcpServers } = body.resource_mentions === undefined
          ? { tools: previousGoalRun.mcpTools, servers: previousGoalRun.selection.mcp_servers ?? [] }
          : await this.freezeMcpCatalog(owner, mentions.tools, mentions.plugins)
        const mentionTools = mentionProviders(mcpTools, mcpServers)
        const objective = line.replace(/^\/goal\s+(?:edit\s+)?/i, '')
        editedResources = { mcpTools, selection: { ...previousGoalRun.selection, mcp_servers: mcpServers,
          resource_mentions: mentions, mentioned_resources: await this.mentionSnapshot(mentions, mentionTools, agent, body.mention_positions, objective),
          resource_position_hash: resourceTextHash(objective),
          skill_names: await this.skillNames(agent), skill_invocations: skillInvocationClaims(selectedGoalSkills),
          resource_context: body.resource_mentions === undefined ? previousGoalRun.selection.resource_context
            : appendResourceInstructions([], mentions, mentionTools).map(item => item.text).join('\n') } }
      }
      if (startsGoal) {
        const previous = /^\/goal\s+resume\s*$/i.test(line) ? this.database.goalRun(chat.sessionId) : undefined
        const mentions = goalMentions
        const { tools: mcpTools, servers: mcpServers } = previous
          ? { tools: previous.mcpTools, servers: previous.selection.mcp_servers ?? [] }
          : await this.freezeMcpCatalog(owner, mentions.tools, mentions.plugins)
        const mentionTools = mentionProviders(mcpTools, mcpServers)
        const resourceContext = previous?.selection.resource_context ?? appendResourceInstructions(admitted.content.filter(item => item.type === 'text'), mentions, mentionTools)
          .map(item => item.text).join('\n')
        if (agent.status !== 'running' && chat.selection.model) {
          await requireDatabaseModel(this.platformClient, this.sessions, owner, chat.selection.model, this.modelSettings)
          await this.sessions.selectModel({ sessionId: chat.sessionId, ...splitModel(chat.selection.model),
            ...(chat.selection.model_parameters?.reasoning_effort ? { reasoningEffort: chat.selection.model_parameters.reasoning_effort } : {}) })
        }
        {
          const objective = /^\/goal\s+resume\s*$/i.test(line)
            ? this.goals?.get(agent)?.objective ?? '继续目标' : line.replace(/^\/goal\s+(?:edit\s+)?/i, '')
          goalRun = this.database.createRun({ ownerId: owner.ownerId, chatId, sessionId: chat.sessionId,
            query: objective, attachments: previous?.attachments ?? admitted.attachments, selection: /^\/goal\s+resume\s*$/i.test(line)
              ? { ...resumeGoalSelection(previous?.selection, chat.selection, objective), skill_invocations: skillInvocationClaims(selectedGoalSkills) } : { ...chat.selection, mcp_servers: mcpServers, command: 'goal', resource_mentions: mentions,
              mentioned_resources: await this.mentionSnapshot(mentions, mentionTools, agent, body.mention_positions, objective), skill_names: await this.skillNames(agent),
              skill_invocations: skillInvocationClaims(selectedGoalSkills), resource_context: resourceContext,
              ...(Array.isArray(body.mention_positions) && body.mention_positions.length
                ? { resource_position_hash: resourceTextHash(objective) } : {}) }, mcpTools, requestKey: `goal:${requestKey}`,
            parentRunId: previous?.id }).run
          createdGoalRun = true
          this.database.appendEvent(owner.ownerId, goalRun.id, { event: 'workbench_status', status: 'queued' })
        }
        this.database.setGoalRun(chat.sessionId, goalRun.id)
      }
      let execution
      try {
        execution = await this.withGoalSkillInvocations(agent, selectedGoalSkills, () =>
          this.commands.execute(agent, line, commandAttachments, new AbortController().signal), editedResources ? () => {
            if (editedResources) this.database.updateRunResources(previousGoalRun, editedResources.selection, editedResources.mcpTools)
          } : undefined)
        if (!execution) throw httpError(400, '命令不存在或参数无效')
        if (execution.result?.kind === 'error') throw httpError(409, execution.result.text)
        if (editedResources) this.database.updateRunResources(previousGoalRun, editedResources.selection, editedResources.mcpTools)
        // Older managers admit ordinary files as sandbox-path text. Preserve
        // that content in native history for goal edits as well as new goals.
        const fallbackFiles = admitted.content.filter(item => item.type === 'text')
        if (fallbackFiles.length) agent.followup(createUserMessage({ content: fallbackFiles, source: { kind: 'user' } }))
      } catch (error) {
        if (editedResources) this.database.updateRunResources(previousGoalRun, previousGoalRun.selection, previousGoalRun.mcpTools)
        if (createdGoalRun) {
          this.database.setGoalRun(chat.sessionId, previousGoalRun?.id)
          this.database.transitionRun(owner.ownerId, goalRun.id, 'failed', error.message)
          this.database.appendEvent(owner.ownerId, goalRun.id, { event: 'workbench_end', status: 'failed', error: error.message })
        }
        throw error
      }
      const state = await this.getControl(owner, chatId)
      if (createdGoalRun && state.goal?.phase !== 'active') {
        this.database.transitionRun(owner.ownerId, goalRun.id, 'completed')
        this.database.appendEvent(owner.ownerId, goalRun.id, { event: 'workbench_end', status: 'completed' })
      }
      const result = { state, message: execution.result?.text ?? '', run: goalRun ? this.getRun(owner, goalRun.id) : null }
      return this.database.saveCommandReceipt(owner.ownerId, chatId, requestKey, result)
    })
    this.inflightCommands.set(key, operation)
    try { return await operation }
    finally { this.inflightCommands.delete(key) }
  }

  async clearTodos(owner, chatId, body) {
    const result = await this.issueCommand(owner, chatId, { ...body, command: '/todos-clear' }, { allowTodoClear: true })
    return result.state
  }

  async commandAttachments(agent, content) {
    const result = []
    for (const item of content) {
      if (item.type === 'image') result.push(item)
      if (item.type === 'file') {
        if (!this.fileUploads) throw httpError(503, '原生文件上传服务尚未就绪')
        result.push(...await prepareNativeFiles(this.fileUploads, agent.id, [item], this.attachments))
      }
    }
    return result
  }

  async withGoalSkillInvocations(agent, skills, operation, accepted) {
    if (!skills.length && !accepted) return operation()
    if (!this.onGoalChanged) throw httpError(503, '目标技能加载服务尚未就绪')
    let injected = false
    let injectionError
    const dispose = this.onGoalChanged(({ agent: changed, change }) => {
      if (injected || changed.id !== agent.id || !['create', 'edit', 'resume'].includes(change.operation)) return
      // Editing a paused objective must keep it paused. Its selected skills are
      // validated now and invoked only when the user later resumes the goal.
      if (change.goal?.phase !== 'active') return
      injected = true
      try {
        accepted?.()
        if (!skills.length) return
        changed.followup(createUserMessage({ content: appendSkillInvocations([
          { type: 'text', text: change.goal.objective },
        ], skills), source: { kind: 'user' } }))
      } catch (error) { injectionError = error }
    })
    try {
      const result = await operation()
      if (injectionError) throw injectionError
      return result
    } finally { dispose() }
  }

  async mutateGoal(owner, chatId, action, body) {
    if (!['edit', 'pause', 'resume', 'clear'].includes(action)) throw httpError(400, '未知目标操作')
    return this.withChatMutation(chatId, async () => {
      const chat = await this.ensureChatSession(owner, this.requireChat(owner, chatId))
      const agent = this.agents.get(chat.sessionId)
      if (!agent) throw httpError(409, '会话暂时无法恢复')
      const ref = body.ref
      const current = this.goals.get(agent)
      if (!current || current.id !== ref?.id || current.revision !== ref?.revision)
        throw httpError(409, '目标已改变，请刷新后重试', 'GOAL_STALE_REF')
      let resumedRun
      const previousGoalRun = this.database.goalRun(chat.sessionId)
      const selectedSkills = ['edit', 'resume'].includes(action)
        ? await this.selectedSkills(normalizeResourceMentions(previousGoalRun?.selection.resource_mentions), agent) : []
      if (['edit', 'resume'].includes(action) && previousGoalRun?.selection.skill_invocations)
        assertSkillInvocationClaims(selectedSkills, previousGoalRun.selection.skill_invocations)
      const editedSelection = action === 'edit' && previousGoalRun && typeof body.request?.objective === 'string'
        && body.request.objective !== current.objective && previousGoalRun.selection.resource_position_hash ? {
          ...previousGoalRun.selection, resource_position_hash: undefined,
          mentioned_resources: (previousGoalRun.selection.mentioned_resources ?? []).map(({ offset: _offset, ...resource }) => resource),
        } : undefined
      if (action === 'resume') {
        const previous = this.database.goalRun(chat.sessionId)
        const active = this.database.activeRunBySession(chat.sessionId)
        if (!active || !['running', 'waiting_input'].includes(active.status)) {
          const resources = previous ? { tools: previous.mcpTools, servers: previous.selection.mcp_servers ?? [] } : await this.freezeMcpCatalog(owner, [])
          resumedRun = this.database.createRun({ ownerId: owner.ownerId, chatId, sessionId: chat.sessionId,
            query: current.objective, selection: { ...resumeGoalSelection(previous?.selection, chat.selection, current.objective), mcp_servers: resources.servers,
              skill_invocations: skillInvocationClaims(selectedSkills) },
            attachments: previous?.attachments ?? [], mcpTools: resources.tools,
            parentRunId: previous?.id,
          }).run
          this.database.setGoalRun(chat.sessionId, resumedRun.id)
        }
      }
      try {
        const value = await this.withGoalSkillInvocations(agent, selectedSkills, () =>
          action === 'edit' ? this.goals.edit(agent, ref, body.request) : this.goals[action](agent, ref),
        editedSelection ? () => this.database.updateRunResources(previousGoalRun, editedSelection, previousGoalRun.mcpTools) : undefined)
        if (editedSelection) this.database.updateRunResources(previousGoalRun, editedSelection, previousGoalRun.mcpTools)
        return { value, state: await this.getControl(owner, chatId), run: resumedRun ? this.getRun(owner, resumedRun.id) : null }
      } catch (error) {
        if (editedSelection) this.database.updateRunResources(previousGoalRun, previousGoalRun.selection, previousGoalRun.mcpTools)
        if (resumedRun) {
          this.database.setGoalRun(chat.sessionId, previousGoalRun?.id)
          this.database.transitionRun(owner.ownerId, resumedRun.id, 'failed', error.message)
        }
        throw error
      }
    })
  }

  async getControl(owner, chatId) {
    const chat = this.requireChat(owner, chatId)
    const withGoalResources = value => value.goal ? { ...value, goal: { ...value.goal,
      mentioned_resources: goalMentionResources(this.database.goalRun(chat.sessionId), value.goal.objective) } } : value
    let state = this.database.getControl(owner.ownerId, chatId)
    const agent = this.agents.get(chat.sessionId)
    if (!agent && state.goal) state = { ...state, goal: { ...state.goal, activation: 'disarmed' } }
    if (agent && this.goals) {
      const goal = this.goals.get(agent)
      state = { ...state, goal: goal ? { ...goal, reason: goalFailureReason(goal, this.database.goalRun(chat.sessionId)),
        max_rounds: goal.maxGoalRounds, rounds_started: goal.roundsStarted, last_run_id: this.database.goalRun(chat.sessionId)?.id ?? null } : null }
    }
    if (!this.sessionQuery) return withGoalResources(state)
    const source = await this.sessionQuery.observeSession(chat.sessionId)
    try {
      const plan = source.projections?.values?.plan ?? { active: false, pending: false }
      if (!agent) {
        const projection = source.projections?.values?.goal
        const goal = projection?.goal
        state = { ...state, goal: goal ? { ...goal, activation: 'disarmed',
          reason: goalFailureReason({ ...goal, activation: 'disarmed' }, this.database.goalRun(chat.sessionId)), max_rounds: goal.maxGoalRounds,
          rounds_started: projection.roundsStarted, last_run_id: this.database.goalRun(chat.sessionId)?.id ?? null } : null }
      }
      return withGoalResources({ ...state, plan, contextPressure: source.projections?.values?.contextPressure ?? null,
        contextBreakdown: source.projections?.values?.contextBreakdown ?? null,
        commands: nativeCommandRecords(source.events ?? [], this.database.listRunReferences(owner.ownerId, chatId)) })
    } finally { source[Symbol.dispose]?.() }
  }

  followups(owner, chatId, tracked) {
    this.requireChat(owner, chatId)
    return { runs: this.database.followups(owner.ownerId, chatId, tracked).map((run) => this.inputRunDto(owner, run)) }
  }

  async stopSubmission(owner, chatId, requestKey) {
    this.requireChat(owner, chatId)
    if (typeof requestKey !== 'string' || requestKey.length === 0 || requestKey.length > 128 || requestKey.includes('\0'))
      throw httpError(400, 'request_key 格式无效')
    const run = this.database.findRunByRequestKey(owner.ownerId, chatId, requestKey)
    if (run && this.database.submission(owner.ownerId, run.id)?.dispatched !== false) {
      // The native boundary has been crossed. Do not create an admission tombstone
      // or remove an inbox item as a side effect of cancelling the Session.
      return { accepted: true, run: await this.stopRun(owner, run.id) }
    }
    // Persist independently of admission's chat lock: cancellation must win
    // even while attachments, model setup or sandbox discovery are stalled.
    this.database.saveCommandReceipt(owner.ownerId, chatId, `run-stop:${requestKey}`, { cancelled: true })
    if (run) {
      try { return { accepted: true, run: await this.stopRun(owner, run.id) } }
      catch (error) {
        if (error.status !== 409 || run.messageId) throw error
        // Admission sees the durable cancellation before/after prompt delivery.
      }
    }
    return { accepted: true, run: null }
  }

  async stopRun(owner, runId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (this.scheduler && this.database.submission(owner.ownerId, run.id)?.dispatched === false && run.status === 'queued') {
      return runDto(this.database.transitionRun(owner.ownerId, run.id, 'cancelled'))
    }
    // Native cancel retains the inbox. Only native events change the turn cache;
    // an acknowledgement is not a terminal state and creates no `stopping` state.
    const agent = this.agents.get(run.sessionId)
    const goal = agent && this.goals?.get(agent)
    const active = currentExecutionRun(this.database, this.agents, run.sessionId)
      ?? (this.executionRun?.(run.sessionId)?.background ? this.executionRun(run.sessionId) : undefined)
      ?? (goal?.phase === 'active' ? this.database.goalRun(run.sessionId) : undefined)
    if ((active && active.id !== run.id) || (!active && (goal?.phase === 'active' || agent?.status === 'running')))
      throw httpError(409, '当前任务已改变，请刷新后重试', 'STALE_RUN')
    const runIds = run.status !== 'queued' || active?.id === run.id ? [run.id] : []
    if (run.selection?.native_notice === true && run.parentRunId && runIds.length) {
      const parent = this.database.getRun(owner.ownerId, run.parentRunId)
      if (parent?.sessionId === run.sessionId) runIds.push(parent.id)
    }
    for (const id of runIds) this.database.requireRunFence(owner.ownerId, id)
    let nativeError
    try {
      if (goal?.phase === 'active') this.goals.pause(agent, { id: goal.id, revision: goal.revision })
      this.sessions.cancel({ sessionId: run.sessionId })
      this.cancelOwned?.(run.sessionId, run.id)
    }
    catch (error) { nativeError = error }
    const confirmation = await fenceMcpExecutions(this.platformClient, owner, runIds)
    for (const id of runIds) this.database.confirmRunFence(owner.ownerId, id, confirmation)
    if (nativeError) throw httpError(502, `暂停请求未确认，请重试：${nativeError?.message ?? nativeError}`)
    return runDto(this.database.getRun(owner.ownerId, run.id))
  }

  async supplement(owner, sourceRunId, body) {
    const source = this.database.getRun(owner.ownerId, sourceRunId)
    if (!source) throw httpError(404, '任务不存在')
    return this.withChatMutation(source.chatId, () => this.supplementAccepted(owner, sourceRunId, body))
  }

  async supplementAccepted(owner, sourceRunId, body) {
    const source = this.database.getRun(owner.ownerId, sourceRunId)
    if (!source) throw httpError(404, '任务不存在')
    const input = typeof body.request_id === 'string' && body.request_id
      ? this.database.getPendingInput(owner.ownerId, sourceRunId, body.request_id) : null
    if (!input) throw httpError(404, '问题不存在')
    const nativeAnswer = toAnswer(input.payload.questions ?? [], body)
    if (input.answer?.supplement_run_id) {
      if (!isDeepStrictEqual(toAnswer(input.payload.questions ?? [], input.answer).answers, nativeAnswer.answers))
        throw httpError(409, '该补答请求已使用不同的回答')
      return this.getRun(owner, input.answer.supplement_run_id)
    }
    if (!['skipped', 'timeout', 'aborted'].includes(input.status)) throw httpError(409, '只有已跳过的问题可以补答')
    const answer = nativeAnswer.answers.map((item) => [...item.selected, item.custom].filter(Boolean).join('\n')).filter(Boolean).join('\n')
    if (!answer) throw httpError(400, '补充回答不能为空')
    const chat = this.requireChat(owner, source.chatId)
    const requestKey = `input-supplement:${input.requestId}`
    const existing = this.database.findRunByRequestKey(owner.ownerId, chat.id, requestKey)
    if (existing && (existing.query !== answer || (existing.selection?.input_supplement
      && !isDeepStrictEqual(existing.selection.input_supplement, inputSupplement(input.payload.questions ?? [], nativeAnswer.answers)))))
      throw httpError(409, '该补答请求已使用不同的回答')
    const active = currentExecutionRun(this.database, this.agents, chat.sessionId)
    const inherited = existing ?? active
    const resources = inherited ? { tools: inherited.mcpTools, servers: inherited.selection.mcp_servers ?? [] }
      : await this.freezeMcpCatalog(owner, [])
    const { run, created } = this.database.createRun({
      ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
      query: answer, mcpTools: resources.tools,
      selection: { ...chat.selection, mcp_servers: resources.servers, silent_resume: false, is_continuation: false, prompt_mode: 'steer',
        input_supplement: inputSupplement(input.payload.questions ?? [], nativeAnswer.answers) }, requestKey,
      parentRunId: source.id,
    })
    if (created || (run.status === 'queued' && !run.messageId)) {
      if (created) this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_status', status: 'queued' })
      const context = (input.payload.questions ?? []).map((question) => ({ question: question.question, answer: nativeAnswer.answers.find((item) => item.id === question.id) }))
      const content = [{ type: 'text', text: `用户重新回答了之前跳过的提问。请立即按这些新信息调整当前任务；如先前的假设与补答冲突，以补答为准。\n${JSON.stringify(context)}\n补充回答：${answer}` }]
      // A newer native question released its admission while waiting. Close it
      // through the same bridge as the Skip button, then let the scheduler
      // reacquire admission and DSH choose the current step or next turn.
      const pending = active ? this.database.listPendingInputs(owner.ownerId, active.id) : []
      for (const question of pending)
        if (question.status === 'pending' && question.requestId !== input.requestId)
          this.humanInput.skip(owner.ownerId, active.id, question.requestId)
      if (this.scheduler) {
        // Reuse explicit direct-send handling so a live, admitted turn receives
        // the answer now, instead of waiting behind a dispatcher snapshot.
        this.database.saveSubmission(owner.ownerId, run.id, content)
        if (active) await this.steerQueued(owner, run.id, active.id)
        else void this.scheduler.tick()
      }
      else await this.sessions.prompt({ requestId: run.id, sessionId: run.sessionId, mode: 'steer', content }, new AbortController().signal)
    }
    this.database.recordInputSupplement(owner.ownerId, sourceRunId, input.requestId, {
      ...nativeAnswer, supplement_run_id: run.id,
    })
    return this.getRun(owner, run.id)
  }

  async editQueued(owner, runId, body) {
    return this.withQueueMutation(owner, runId, () => this.editQueuedMessage(owner, runId, body))
  }

  withQueueMutation(owner, runId, operation) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    return this.withChatMutation(run.chatId, () => this.scheduler?.withSubmissionMutation
      ? this.scheduler.withSubmissionMutation(runId, operation) : operation())
  }

  async editQueuedMessage(owner, runId, body) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    const text = body.content?.[0]?.text
    if (!Array.isArray(body.content) || body.content.length !== 1 || body.content[0].type !== 'text' || typeof text !== 'string' || !text.trim())
      throw httpError(400, '排队编辑仅接受非空文本')
    if (run.attachments?.length) throw httpError(409, '包含附件的消息不支持文本编辑')
    const inbox = this.agents?.get(run.sessionId)?.inbox
    const original = this.database.submission(owner.ownerId, runId)?.content
      ?? [...(inbox?.nextTurn ?? []), ...(inbox?.nextStep ?? [])].find(item => item.id === run.messageId)?.content
    if (original?.some(part => part.type !== 'text')) throw httpError(409, '包含附件的消息不支持文本编辑')
    // Rebuild native gestures from the frozen selection so editing cannot
    // duplicate them or bypass the current Agent's user-invocation policy.
    const agent = this.agents.get(run.sessionId)
    const selectedSkills = await this.selectedSkills(normalizeResourceMentions(run.selection.resource_mentions), agent)
    if (run.selection.skill_invocations) assertSkillInvocationClaims(selectedSkills, run.selection.skill_invocations)
    const content = await this.resourceContent(body.content, run.selection.resource_mentions, mentionProviders(run.mcpTools, run.selection.mcp_servers), agent, selectedSkills, body.mention_positions)
    const mentionedResources = await this.mentionSnapshot(normalizeResourceMentions(run.selection.resource_mentions), mentionProviders(run.mcpTools, run.selection.mcp_servers), agent, body.mention_positions, text)
    // Before dispatch update the durable admission payload; afterward DSH's
    // inbox decides whether the message is still editable.
    if (!run.messageId) {
      if (!this.database.editSubmission(owner.ownerId, runId, content))
        throw httpError(409, '消息已离开队列，请刷新后重试', 'STALE_RUN')
    } else {
      await this.sessions.updateQueue({ sessionId: run.sessionId, itemId: run.messageId, action: { kind: 'edit', content } })
    }
    // Update the display cache only after the owning queue accepts the edit.
    this.database.db.prepare('UPDATE runs SET query = ? WHERE id = ? AND owner_id = ?').run(text, run.id, owner.ownerId)
    this.database.updateRunResources(run, { ...run.selection, mentioned_resources: mentionedResources }, run.mcpTools)
    return this.getRun(owner, runId)
  }

  async removeQueued(owner, runId) {
    return this.withQueueMutation(owner, runId, () => this.removeQueuedMessage(owner, runId))
  }

  async removeQueuedMessage(owner, runId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (run.status === 'discarded') return runDto(run)
    if (run.status !== 'queued') throw httpError(409, '消息已离开队列，请刷新后重试', 'STALE_RUN')
    if (this.scheduler && this.database.submission(owner.ownerId, run.id)?.dispatched === false)
      return runDto(this.database.transitionRun(owner.ownerId, run.id, 'discarded'))
    if (!run.messageId) throw httpError(409, '排队消息尚未持久化，请稍后重试')
    await this.sessions.updateQueue({ sessionId: run.sessionId, itemId: run.messageId, action: { kind: 'remove' } })
    return runDto(this.database.transitionRun(owner.ownerId, run.id, 'discarded'))
  }

  async steer(owner, runId, targetRunId) {
    return this.withQueueMutation(owner, runId, () => this.steerQueued(owner, runId, targetRunId))
  }

  async steerQueued(owner, runId, targetRunId) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (run.status === 'steered') {
      const accepted = this.getRun(owner, runId)
      if (accepted.steer_target_run_id === targetRunId) return accepted
      throw httpError(409, '消息已直接发送到其他任务')
    }
    // Upload durable files before checking the target; DSH owns prompt admission.
    let pending = this.scheduler && this.database.submission(owner.ownerId, run.id)
    const content = pending && !pending.dispatched
      ? await prepareNativeFiles(this.fileUploads, run.sessionId, pending.content, this.attachments)
      : undefined
    const active = this.database.getRun(owner.ownerId, targetRunId)
    const current = this.database.getRun(owner.ownerId, runId)
    if (!active || active.sessionId !== run.sessionId || active.id === run.id)
      throw Object.assign(httpError(409, '消息目标已改变，请刷新后重试'), { code: 'STALE_RUN' })
    // DSH may already have claimed this exact message as the next turn while
    // the browser was waiting for admission or file preparation.
    if (['running', 'waiting_input', 'completed'].includes(current?.status)) return this.getRun(owner, runId)
    if (current?.status !== 'queued')
      throw Object.assign(httpError(409, '消息已离开队列，请刷新后重试'), { code: 'STALE_RUN' })
    const agent = this.agents.get(run.sessionId)
    const boundary = nativeTurn(agent)
    const bound = boundary?.openTurnStartSeq != null && this.database.runForTurn(run.sessionId, boundary.lastTurn)
    if (!['running', 'waiting_input'].includes(active.status)
      || agent?.status !== 'running' || bound?.id !== active.id
      || !this.scheduler?.hasAdmission(run.sessionId)) {
      // Keep the same durable message. The native AgentLoop turns a late steer
      // into a new turn after the scheduler acquires its ordinary admission.
      if (pending && !pending.dispatched)
        this.database.updateRunResources(current, { ...current.selection, prompt_mode: 'steer' }, current.mcpTools)
      void this.scheduler?.tick()
      return this.getRun(owner, runId)
    }
    pending = this.database.submission(owner.ownerId, runId)
    if (pending && !pending.dispatched) {
      await this.sessions.prompt({ sessionId: run.sessionId, requestId: run.id, content, mode: 'steer' }, new AbortController().signal)
    } else {
      const message = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(item => item.id === current.messageId)
      if (!message) throw Object.assign(httpError(409, '排队消息已被接收，请刷新后重试'), { code: 'STALE_RUN' })
      await this.sessions.updateQueue({ sessionId: run.sessionId, itemId: message.id, action: { kind: 'steer' } })
    }
    const accepted = this.database.getRun(owner.ownerId, run.id)
    if (['running', 'waiting_input', 'completed'].includes(accepted?.status)) return this.getRun(owner, run.id)
    const after = nativeTurn(agent)
    const target = after?.openTurnStartSeq != null && this.database.runForTurn(run.sessionId, after.lastTurn)
    if (accepted?.status !== 'steered' && (target?.id !== targetRunId || agent.status !== 'running')) return this.getRun(owner, run.id)
    if (pending && !pending.dispatched) this.database.finishSubmission(owner.ownerId, run.id)
    if (this.database.getRun(owner.ownerId, run.id)?.status !== 'steered') {
      this.database.transitionRun(owner.ownerId, run.id, 'steered')
      this.database.appendEvent(owner.ownerId, run.id, { event: 'workbench_steered', steer_target_run_id: targetRunId })
      this.database.appendEvent(owner.ownerId, targetRunId, {
        event: 'workbench_steering', steering_id: run.id, query: run.query, attachments: run.attachments ?? [],
      })
    }
    return this.getRun(owner, run.id)
  }

  getRun(owner, runId, includeEvents = false, page) {
    const run = this.database.getRun(owner.ownerId, runId)
    if (!run) throw httpError(404, '任务不存在')
    if (includeEvents && page) {
      const after = decodeCursor(page.after)
      const through = page.through == null ? run.seq : decodeCursor(page.through)
      if (after > through || through > run.seq) throw httpError(400, '事件游标超过历史快照范围')
      const events = this.database.eventsAfter(owner.ownerId, run.id, after, 256, presentRunEvent, { through })
      const cursor = events.at(-1)?._id ?? `${through}-0`
      const more = Number(cursor.split('-')[0]) < through
      return { ...this.inputRunDto(owner, run, events, this.database.steeringEvents(owner.ownerId, run.id, through)), events_cursor: cursor,
        events_through_cursor: `${through}-0`, ...(more ? { events_next_cursor: cursor } : {}), history_complete: !more }
    }
    return { ...this.inputRunDto(owner, run, includeEvents ? this.database.allEvents(owner.ownerId, run.id, presentRunEvent,
      { maxBytes: 16 * 1024 * 1024, maxEvents: 10000 }) : []), history_complete: includeEvents }
  }

  inputRunDto(owner, run, events = [], steeringSnapshot) {
    const inputs = this.database.listPendingInputs(owner.ownerId, run.id)
    const context = this.database.latestContextEvent(owner.ownerId, run.id)
    const steering = steeringSnapshot ?? (events.length ? events.filter(event => event.event === 'workbench_steering' || event.event === 'workbench_steered')
      : this.database.steeringEvents(owner.ownerId, run.id))
    const messages = new Map(steering.filter(event => event.event === 'workbench_steering').map(event => [event.steering_id,
      { id: event.steering_id, query: event.query, attachments: event.attachments ?? [], created_at: event.created_at,
        message: this.database.getRun(owner.ownerId, event.steering_id) }]))
    // A pending steer can be consumed by a later run after pause/resume. Native
    // turn bindings retain its full input even when the admission page is absent.
    if (steeringSnapshot === undefined) for (const message of this.database.consumedSteeringRuns(owner.ownerId, run.id)) {
      messages.set(message.id, { id: message.id, query: message.query, attachments: message.attachments, message })
    }
    if (run.error && !run.errorCode) run.errorCode = this.database.runErrorCode(owner.ownerId, run.id)
    return {
      ...runDto(run, events,
        inputs.findLast(input => input.status === 'pending') ?? inputs.at(-1)),
      context_usage: context ? presentRunEvent(context) : undefined,
      input_supplement: this.inputSupplement(run),
      ...this.database.runTiming(owner.ownerId, run.id),
      steer_target_run_id: steering.find((event) => event.event === 'workbench_steered')?.steer_target_run_id,
      steering_messages: [...messages.values()].map(({ id, query, attachments, created_at, message }) => {
        const mentions = message ? runDto(message).mentioned_resources : []
        return { id, query, attachments,
          ...(message ? { input_supplement: this.inputSupplement(message), turn: message.turnNumber } : {}),
          ...(mentions.length ? { mentioned_resources: mentions } : {}),
          created_at: message ? message.createdAt / 1000 : created_at }
      }),
      human_input_history: inputs.filter((input) => ['skipped', 'timeout', 'aborted', 'submitted'].includes(input.status)).map((input) => {
        const answers = input.answer?.answers ?? []
        return {
          ...input.payload, request_id: input.requestId,
          answers,
          outcome: input.status, status: ['timeout', 'aborted'].includes(input.status) ? 'skipped' : input.status,
          ...(input.answer?.supplement_run_id ? { supplement_run_id: input.answer.supplement_run_id } : {}),
        }
      }),
    }
  }

  inputSupplement(run) {
    if (run.selection?.input_supplement) return run.selection.input_supplement
    if (!run.parentRunId || run.selection?.prompt_mode !== 'steer') return undefined
    // Older persisted supplements can use the original question/answer receipt.
    const input = this.database.listPendingInputs(run.ownerId, run.parentRunId)
      .find(input => input.answer?.supplement_run_id === run.id)
    return input ? inputSupplement(input.payload.questions ?? [], input.answer.answers ?? []) : undefined
  }

  requireChat(owner, chatId) {
    const chat = this.database.getChat(owner.ownerId, chatId)
    if (!chat) throw httpError(404, '会话不存在或已被删除')
    this.directories.assertAvailable(owner, chat.directory ?? `conversations/${chat.id}`)
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
    name: value.tool_name, display_name: value.tool_name,
    description: value.description, inputSchema: value.inputSchema,
    ...(value.outputSchema === undefined ? {} : { outputSchema: value.outputSchema }),
    ...(value.annotations === undefined ? {} : { annotations: value.annotations }),
    ...(value.execution === undefined ? {} : { execution: value.execution }),
    group: value.group ?? 'mcp', provider: value.provider ?? 'mcp',
    provider_name: value.provider_name ?? value.server_id,
    provider_call_name: value.provider_call_name ?? value.server_id,
    provider_description: value.provider_description ?? '',
  }
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
    if (field === 'knowledge' && selection[field].length) throw httpError(501, '知识库选择尚未接入此版本')
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
  const forkEnd = run.sourceEndSeq ?? run.selection?.fork_source?.endSeq
  const mentioned = run.selection?.mentioned_resources ?? []
  return {
    id: run.id, chat_id: run.chatId, revision_id: run.id, version: 1, query: run.query,
    created_at: run.createdAt / 1000,
    can_fork: ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) && Number.isSafeInteger(forkEnd) && forkEnd >= 0,
    resource_mentions: normalizeResourceMentions(run.selection?.resource_mentions),
    mentioned_resources: groupPluginMentions(mentioned, mentioned.some(resource => resource.kind === 'tools') ? run.mcpTools ?? [] : []),
    ...(run.selection?.input_supplement ? { input_supplement: run.selection.input_supplement } : {}),
    ...(run.selection?.command ? { command: run.selection.command } : {}),
    ...(run.selection?.silent_resume || run.selection?.is_continuation ? { is_continuation: true } : {}),
    ...(run.selection?.native_source === 'schedule' ? { source: { kind: 'schedule', titles: run.selection.schedule_titles ?? [], schedule_ids: run.selection.schedule_ids ?? [] } } : {}),
    ...(run.selection?.native_notice && run.selection.native_source !== 'tool-jobs' ? { source: { kind: run.selection.native_source ?? 'agent-message' } } : {}),
    status: run.status, error: run.error ? runFailure({ message: run.error, code: run.errorCode }).message : run.error,
    feedback: run.feedback ?? null,
    events: events.filter(event => !run.selection?.fork_source || event.event !== 'workbench_changes').map(presentRunEvent),
    events_cursor: `${run.seq}-0`,
    stop_confirmation: run.stopConfirmation ?? null,
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

function groupPluginMentions(resources, tools) {
  const byId = new Map(tools.map(tool => [tool.id, tool]))
  const seen = new Set()
  return resources.filter(resource => {
    if (resource.kind !== 'tools') return true
    const tool = byId.get(resource.id) ?? tools.find(item => pluginName(item) === resource.id || pluginId(item) === resource.id)
    const provider = tool?.provider && tool.provider !== 'mcp' ? tool.provider
      : tool?.server_id ? `${tool.scope ?? 'global'}:mcp:${tool.server_id}`
        : /^(?:global|personal):mcp:[^:]+(?=:)/.exec(resource.id)?.[0]
    const identity = provider ?? resource.id
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

// HTTP admission maps provider validation errors; parsing remains owned by DSH.
async function readImportedSkill(content) {
  try { return await readSkillDefinition(content) }
  catch (error) { throw httpError(400, error.message) }
}
