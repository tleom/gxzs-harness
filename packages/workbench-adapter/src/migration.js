import { createHash } from 'node:crypto'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { httpError } from './http.js'
import { resolveWorkspacePath } from './paths.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

export class MigrationImporter {
  constructor({ database, sessions, agents, fileManager, ownerId, workspace }) {
    this.database = database
    this.sessions = sessions
    this.agents = agents
    this.fileManager = fileManager
    this.ownerId = ownerId
    this.workspace = workspace
  }

  async import(bundle) {
    validateBundle(bundle, this.ownerId, this.fileManager.workspaceId)
    const digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex')
    const previous = this.database.migrationResult(bundle.source_id, digest)
    if (previous) return previous
    const workspace = await this.fileManager.operate({ operation: 'manifest', path: '.' })
    if (workspace.version !== bundle.workspace.tree_version || workspace.items !== bundle.workspace.files || workspace.size !== bundle.workspace.bytes)
      throw httpError(409, '用户文件空间已改变，请重新生成迁移清单')
    if (Array.isArray(bundle.workspace.samples)) {
      const byPath = new Map((workspace.files ?? []).map((file) => [file.path, file.sha256]))
      if (bundle.workspace.samples.some((file) => byPath.get(file.path) !== file.sha256))
        throw httpError(409, '用户文件抽样校验失败，请停止迁移')
    }
    const result = { source_id: bundle.source_id, owner_id: this.ownerId, digest, chats: [], workspace: {
      id: this.fileManager.workspaceId, tree_version: workspace.version, files: workspace.items, bytes: workspace.size,
    } }
    for (const chat of bundle.chats) result.chats.push(await this.importChat(chat))
    return this.database.recordMigration(bundle.source_id, digest, result)
  }

  async importChat(chat) {
    const sessionId = `session-${chat.id}`
    const preexisting = this.agents.get(sessionId)
    await this.fileManager.operate({ operation: 'mkdir', path: `conversations/${chat.id}` })
    await this.sessions.create({ sessionId, cwd: resolveWorkspacePath(this.workspace, `conversations/${chat.id}`) })
    const agent = this.agents.get(sessionId)
    if (!agent?.session) throw httpError(503, '迁移会话创建后不可用')
    const existing = this.database.getChat(this.ownerId, chat.id)
    if (!existing && preexisting?.session)
      throw httpError(409, '检测到未完成的迁移会话，请先清理该确定性 session 后重试')
    if (!existing) {
      let turn = 0
      for (const run of chat.runs) replayRun(agent.session, run, ++turn)
      this.database.importChat({
        id: chat.id, ownerId: this.ownerId, sessionId, title: chat.title, pinned: chat.pinned,
        favorited: chat.favorited, selection: chat.selection, createdAt: chat.created_at, updatedAt: chat.updated_at,
      })
      for (const run of chat.runs) this.database.importRun({
        id: run.id, ownerId: this.ownerId, chatId: chat.id, sessionId, query: run.query,
        status: TERMINAL.has(run.status) ? run.status : 'interrupted', selection: chat.selection,
        parentRunId: run.parent_run_id, createdAt: run.created_at, updatedAt: run.updated_at, events: run.events,
      })
    }
    return {
      source_chat_id: chat.id, chat_id: chat.id, session_id: sessionId,
      runs: chat.runs.length, events: chat.runs.reduce((total, run) => total + run.events.length, 0),
    }
  }
}

function replayRun(session, run, turn) {
  session.append('turn/start', { turn })
  const user = createUserMessage({ content: [{ type: 'text', text: run.query || '附件消息' }], source: { kind: 'user', rpcId: run.id } })
  session.append('user/message', user, { surfaceOp: 'append' })
  const answer = assistantText(run.events)
  if (answer) {
    const step = 1
    session.append('step/start', { turn, step })
    const message = createAssistantMessage({ content: [{ type: 'text', text: answer }], source: { provider: 'migration', model: 'legacy' } })
    session.append('assistant/message', { turn, step, message, stream: [] }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function assistantText(events = []) {
  const parts = []
  for (const event of events) {
    if (event.event === 'workbench_activity' && event.data?.kind === 'text' && typeof event.data.text === 'string') parts.push(event.data.text)
    else if (event.event === 'agent_message' && typeof event.answer === 'string') parts.push(event.answer)
  }
  return parts.join('')
}

function validateBundle(bundle, ownerId, workspaceId) {
  if (!bundle || bundle.version !== 1 || typeof bundle.source_id !== 'string' || !bundle.source_id || bundle.owner_id !== ownerId)
    throw httpError(400, '迁移清单身份或版本无效')
  if (bundle.workspace?.id !== workspaceId || typeof bundle.workspace?.tree_version !== 'string')
    throw httpError(409, '迁移文件空间与当前用户不一致')
  if (!Array.isArray(bundle.chats) || bundle.chats.length > 20) throw httpError(400, '每个迁移批次最多包含20个会话')
  const ids = new Set()
  for (const chat of bundle.chats) {
    if (!UUID.test(chat.id) || ids.has(chat.id) || typeof chat.title !== 'string' || !Array.isArray(chat.runs)) throw httpError(400, '迁移会话格式无效')
    ids.add(chat.id)
    if (!chat.selection || typeof chat.selection !== 'object' || chat.runs.length > 500) throw httpError(400, '迁移会话配置或任务数量无效')
    const runIds = new Set()
    for (const run of chat.runs) {
      if (!UUID.test(run.id) || runIds.has(run.id) || typeof run.query !== 'string' || !Array.isArray(run.events)) throw httpError(400, '迁移任务格式无效')
      runIds.add(run.id)
      if (run.events.length > 20_000) throw httpError(400, '迁移任务事件数量超限')
    }
  }
}
