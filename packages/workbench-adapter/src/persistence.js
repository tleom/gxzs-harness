import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeCursor } from './cursor.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered'])

export class WorkbenchDatabase {
  constructor(filename, { onEvent } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.onEvent = onEvent
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  migrate() {
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
    if (existing) {
      const versions = this.db.prepare('SELECT version FROM schema_migrations').all()
      if (versions.some((row) => row.version !== 3)) throw new Error('unsupported workbench database schema; provision a new empty database')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migration_imports (
        source_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        imported_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        favorited INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        selection_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS chats_owner_updated ON chats(owner_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        request_key TEXT,
        query TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        mcp_tools_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        error TEXT,
        feedback TEXT CHECK(feedback IS NULL OR feedback IN ('like', 'dislike')),
        selection_json TEXT NOT NULL,
        parent_run_id TEXT,
        queue_order INTEGER,
        turn_number INTEGER,
        message_id TEXT,
        source_start_seq INTEGER,
        source_end_seq INTEGER,
        next_seq INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(owner_id, chat_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS runs_chat_created ON runs(chat_id, created_at, id);
      CREATE INDEX IF NOT EXISTS runs_owner_status ON runs(owner_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS runs_session_message ON runs(session_id, message_id) WHERE message_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS pending_turns (
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        start_seq INTEGER NOT NULL,
        PRIMARY KEY(session_id, turn_number)
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS command_receipts (
        owner_id TEXT NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(owner_id, chat_id, request_key)
      );
      CREATE TABLE IF NOT EXISTS control_state (
        chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0,
        todos_json TEXT NOT NULL DEFAULT '[]',
        goal_json TEXT,
        plan_json TEXT NOT NULL DEFAULT '{"active":false,"pending":false,"review":null,"review_run_id":null}',
        compaction_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS streamed_steps (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        turn_number INTEGER NOT NULL,
        step_number INTEGER NOT NULL,
        PRIMARY KEY(run_id, turn_number, step_number)
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY(run_id, call_id)
      );
      CREATE TABLE IF NOT EXISTS pending_inputs (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        answer_json TEXT,
        deadline_at INTEGER,
        interacted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
    `)
    const versions = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version)
    if (versions.some((version) => version !== 3)) throw new Error('unsupported workbench database schema; provision a new empty database')
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)').run(Date.now())
  }

  transaction(operation) {
    return () => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const result = operation()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  close() { this.db.close() }

  migrationResult(sourceId, digest) {
    const row = this.db.prepare('SELECT digest, result_json FROM migration_imports WHERE source_id = ?').get(sourceId)
    if (!row) return undefined
    if (row.digest !== digest) throw Object.assign(new Error('迁移源内容已改变，请使用新的 source_id'), { status: 409 })
    return JSON.parse(row.result_json)
  }

  recordMigration(sourceId, digest, result, now = Date.now()) {
    this.db.prepare('INSERT INTO migration_imports(source_id, digest, result_json, imported_at) VALUES (?, ?, ?, ?)')
      .run(sourceId, digest, JSON.stringify(result), now)
    return result
  }

  importChat({ id, ownerId, sessionId, title, pinned = false, favorited = false, selection, createdAt, updatedAt }) {
    const existing = this.getChat(ownerId, id)
    if (existing) return existing
    this.db.prepare(`INSERT INTO chats
      (id, owner_id, session_id, title, pinned, favorited, selection_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerId, sessionId, title, Number(pinned), Number(favorited), JSON.stringify(selection), createdAt, updatedAt)
    this.db.prepare('INSERT INTO control_state(chat_id, updated_at) VALUES (?, ?)').run(id, updatedAt)
    return this.getChat(ownerId, id)
  }

  importRun({ id, ownerId, chatId, sessionId, query, status, selection, parentRunId, createdAt, updatedAt, events }) {
    const existing = this.getRun(ownerId, id)
    if (existing) return existing
    this.db.prepare(`INSERT INTO runs
      (id, owner_id, chat_id, session_id, query, status, selection_json, parent_run_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerId, chatId, sessionId, query, status, JSON.stringify(selection), parentRunId ?? null, createdAt, updatedAt)
    for (const event of events ?? []) {
      const payload = { ...event }
      delete payload._id
      this.appendEvent(ownerId, id, payload, createdAt)
    }
    return this.getRun(ownerId, id)
  }

  createChat({ ownerId, sessionId, selection, title = '新对话', id = randomUUID(), now = Date.now() }) {
    const create = this.transaction(() => {
      this.db.prepare(`INSERT INTO chats
        (id, owner_id, session_id, title, selection_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ownerId, sessionId, title, JSON.stringify(selection), now, now)
      this.db.prepare('INSERT INTO control_state(chat_id, updated_at) VALUES (?, ?)').run(id, now)
      return this.getChat(ownerId, id)
    })
    return create()
  }

  getChat(ownerId, id) {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
      .get(id, ownerId)
    return row ? decodeChat(row) : undefined
  }

  getChatBySession(sessionId) {
    const row = this.db.prepare('SELECT * FROM chats WHERE session_id = ? AND deleted_at IS NULL').get(sessionId)
    return row ? decodeChat(row) : undefined
  }

  listChats(ownerId) {
    return this.db.prepare('SELECT * FROM chats WHERE owner_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC, id')
      .all(ownerId).map(decodeChat)
  }

  updateChat(ownerId, chatId, patch, now = Date.now()) {
    const chat = this.getChat(ownerId, chatId)
    if (!chat) throw notFound('会话不存在或已被删除')
    this.db.prepare(`UPDATE chats SET title = ?, pinned = ?, favorited = ?, updated_at = ? WHERE id = ? AND owner_id = ?`)
      .run(patch.title ?? chat.title, Number(patch.pinned ?? chat.pinned), Number(patch.favorited ?? chat.favorited), now, chatId, ownerId)
    return this.getChat(ownerId, chatId)
  }

  updateChatConfig(ownerId, chatId, expectedVersion, selection, now = Date.now()) {
    const result = this.db.prepare(`UPDATE chats SET selection_json = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND owner_id = ? AND version = ? AND deleted_at IS NULL`)
      .run(JSON.stringify(selection), now, chatId, ownerId, expectedVersion)
    if (result.changes !== 1) throw Object.assign(new Error('配置版本已改变，请刷新后重试'), { status: 409 })
    return this.getChat(ownerId, chatId)
  }

  deleteChat(ownerId, chatId, now = Date.now()) {
    if (!this.getChat(ownerId, chatId)) throw notFound('会话不存在或已被删除')
    if (this.activeRun(ownerId, chatId)) throw Object.assign(new Error('会话正在执行任务，请停止后再删除'), { status: 409 })
    this.db.prepare('UPDATE chats SET deleted_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(now, now, chatId, ownerId)
  }

  findRunByRequestKey(ownerId, chatId, requestKey) {
    if (!requestKey) return undefined
    const row = this.db.prepare(`SELECT r.* FROM runs r JOIN chats c ON c.id = r.chat_id
      WHERE r.owner_id = ? AND r.chat_id = ? AND r.request_key = ? AND c.deleted_at IS NULL`)
      .get(ownerId, chatId, requestKey)
    return row ? decodeRun(row) : undefined
  }

  createRun({ ownerId, chatId, sessionId, query, attachments = [], mcpTools = [], selection, requestKey, parentRunId, id = randomUUID(), now = Date.now() }) {
    const create = this.transaction(() => {
      const chat = this.db.prepare('SELECT id FROM chats WHERE id = ? AND owner_id = ? AND deleted_at IS NULL')
        .get(chatId, ownerId)
      if (!chat) throw notFound('会话不存在或已被删除')
      if (requestKey) {
        const existing = this.db.prepare('SELECT * FROM runs WHERE owner_id = ? AND chat_id = ? AND request_key = ?')
          .get(ownerId, chatId, requestKey)
        if (existing) return { run: decodeRun(existing), created: false }
      }
      const queueOrder = this.db.prepare(`SELECT COALESCE(MAX(queue_order), 0) + 1 AS value
        FROM runs WHERE chat_id = ? AND status IN ('queued', 'running', 'waiting_input', 'stopping')`)
        .get(chatId).value
      this.db.prepare(`INSERT INTO runs
        (id, owner_id, chat_id, session_id, request_key, query, attachments_json, mcp_tools_json, status, selection_json,
         parent_run_id, queue_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
        .run(id, ownerId, chatId, sessionId, requestKey ?? null, query, JSON.stringify(attachments), JSON.stringify(mcpTools), JSON.stringify(selection), parentRunId ?? null, queueOrder, now, now)
      this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chatId)
      return { run: this.getRun(ownerId, id), created: true }
    })
    return create()
  }

  getRun(ownerId, id) {
    const row = this.db.prepare(`SELECT r.* FROM runs r JOIN chats c ON c.id = r.chat_id
      WHERE r.id = ? AND r.owner_id = ? AND c.deleted_at IS NULL`).get(id, ownerId)
    return row ? decodeRun(row) : undefined
  }

  setFeedback(ownerId, runId, rating, now = Date.now()) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare('UPDATE runs SET feedback = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(rating, now, runId, ownerId)
    return this.getRun(ownerId, runId)
  }

  adoptInboxMessage(sessionId, requestId, messageId) {
    this.db.prepare(`UPDATE runs SET message_id = ? WHERE session_id = ? AND id = ?
      AND status IN ('queued', 'running', 'waiting_input', 'stopping')
      AND (message_id IS NULL OR message_id = ?)`)
      .run(messageId, sessionId, requestId, messageId)
  }

  observeTurnStart(sessionId, turn, seq) {
    this.db.prepare(`INSERT INTO pending_turns(session_id, turn_number, start_seq) VALUES (?, ?, ?)
      ON CONFLICT(session_id, turn_number) DO UPDATE SET start_seq = excluded.start_seq`).run(sessionId, turn, seq)
  }

  bindRunMessage(sessionId, requestId, turn, messageId) {
    this.db.prepare(`UPDATE runs SET turn_number = ?, message_id = ?
      WHERE session_id = ? AND id = ? AND (turn_number IS NULL OR turn_number = ?)`)
      .run(turn, messageId, sessionId, requestId, turn)
    const start = this.db.prepare('SELECT start_seq FROM pending_turns WHERE session_id = ? AND turn_number = ?').get(sessionId, turn)
    if (start) this.db.prepare('UPDATE runs SET source_start_seq = ? WHERE session_id = ? AND id = ?').run(start.start_seq, sessionId, requestId)
    this.db.prepare('DELETE FROM pending_turns WHERE session_id = ? AND turn_number = ?').run(sessionId, turn)
    const row = this.db.prepare('SELECT * FROM runs WHERE session_id = ? AND id = ?').get(sessionId, requestId)
    return row ? decodeRun(row) : undefined
  }

  setRunSourceSeq(ownerId, runId, field, seq) {
    if (!['source_start_seq', 'source_end_seq'].includes(field)) throw new TypeError('invalid source sequence field')
    const result = this.db.prepare(`UPDATE runs SET ${field} = ? WHERE id = ? AND owner_id = ?`).run(seq, runId, ownerId)
    if (result.changes !== 1) throw notFound('任务不存在')
  }

  switchChatSession(ownerId, chatId, expectedSessionId, nextSessionId, now = Date.now()) {
    const result = this.db.prepare(`UPDATE chats SET session_id = ?, updated_at = ?
      WHERE id = ? AND owner_id = ? AND session_id = ? AND deleted_at IS NULL`)
      .run(nextSessionId, now, chatId, ownerId, expectedSessionId)
    if (result.changes !== 1) throw Object.assign(new Error('会话分支已改变，请刷新后重试'), { status: 409 })
    return this.getChat(ownerId, chatId)
  }

  previousRun(sessionId, turn) {
    const row = this.db.prepare(`SELECT * FROM runs WHERE session_id = ? AND turn_number < ? AND source_end_seq IS NOT NULL
      ORDER BY turn_number DESC LIMIT 1`).get(sessionId, turn)
    return row ? decodeRun(row) : undefined
  }

  runForTurn(sessionId, turn) {
    const row = this.db.prepare(`SELECT * FROM runs WHERE session_id = ? AND turn_number = ?
      AND status NOT IN ('steered', 'discarded') ORDER BY queue_order LIMIT 1`).get(sessionId, turn)
    return row ? decodeRun(row) : undefined
  }

  followups(ownerId, chatId, tracked = []) {
    if (!this.getChat(ownerId, chatId)) throw notFound('会话不存在或已被删除')
    if (tracked.length === 0) return []
    const placeholders = tracked.map(() => '?').join(', ')
    return this.db.prepare(`SELECT * FROM runs WHERE owner_id = ? AND chat_id = ? AND id IN (${placeholders})`)
      .all(ownerId, chatId, ...tracked).map(decodeRun)
  }

  listRuns(ownerId, chatId) {
    return this.db.prepare('SELECT * FROM runs WHERE owner_id = ? AND chat_id = ? ORDER BY created_at, id')
      .all(ownerId, chatId).map(decodeRun)
  }

  getCommandReceipt(ownerId, chatId, requestKey) {
    const row = this.db.prepare('SELECT result_json FROM command_receipts WHERE owner_id = ? AND chat_id = ? AND request_key = ?')
      .get(ownerId, chatId, requestKey)
    return row ? JSON.parse(row.result_json) : undefined
  }

  saveCommandReceipt(ownerId, chatId, requestKey, result, now = Date.now()) {
    if (!this.getChat(ownerId, chatId)) throw notFound('会话不存在或已被删除')
    this.db.prepare(`INSERT INTO command_receipts(owner_id, chat_id, request_key, result_json, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id, chat_id, request_key) DO NOTHING`)
      .run(ownerId, chatId, requestKey, JSON.stringify(result), now)
    return this.getCommandReceipt(ownerId, chatId, requestKey)
  }

  getControl(ownerId, chatId) {
    if (!this.getChat(ownerId, chatId)) throw notFound('会话不存在或已被删除')
    let row = this.db.prepare('SELECT * FROM control_state WHERE chat_id = ?').get(chatId)
    if (!row) {
      this.db.prepare('INSERT INTO control_state(chat_id, updated_at) VALUES (?, ?)').run(chatId, Date.now())
      row = this.db.prepare('SELECT * FROM control_state WHERE chat_id = ?').get(chatId)
    }
    return decodeControl(row)
  }

  updateControlBySession(sessionId, update, now = Date.now()) {
    const chat = this.getChatBySession(sessionId)
    if (!chat) return undefined
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM control_state WHERE chat_id = ?').get(chat.id)
      const next = {
        todos: update.todos === undefined ? JSON.parse(current.todos_json) : update.todos,
        goal: update.goal === undefined ? parseNullable(current.goal_json) : update.goal,
        plan: update.plan === undefined ? JSON.parse(current.plan_json) : update.plan,
        compaction: update.compaction === undefined ? parseNullable(current.compaction_json) : update.compaction,
      }
      this.db.prepare(`UPDATE control_state SET revision = revision + 1, todos_json = ?, goal_json = ?,
        plan_json = ?, compaction_json = ?, updated_at = ? WHERE chat_id = ?`)
        .run(JSON.stringify(next.todos), stringifyNullable(next.goal), JSON.stringify(next.plan), stringifyNullable(next.compaction), now, chat.id)
      return this.getControl(chat.ownerId, chat.id)
    })()
  }

  createPendingInput(ownerId, runId, { requestId, payload, deadlineAt }, now = Date.now()) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    this.transaction(() => {
      this.db.prepare(`INSERT INTO pending_inputs
        (request_id, run_id, payload_json, status, deadline_at, created_at)
        VALUES (?, ?, ?, 'pending', ?, ?)`)
        .run(requestId, runId, JSON.stringify(payload), deadlineAt ?? null, now)
      this.db.prepare(`UPDATE runs SET status = 'waiting_input', updated_at = ? WHERE id = ?`).run(now, runId)
    })()
    return this.getPendingInput(ownerId, runId)
  }

  getPendingInput(ownerId, runId) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    const row = this.db.prepare(`SELECT p.* FROM pending_inputs p
      JOIN runs r ON r.id = p.run_id WHERE p.run_id = ? AND r.owner_id = ?
      ORDER BY p.created_at DESC LIMIT 1`).get(runId, ownerId)
    return row ? decodePending(row) : null
  }

  settlePendingInput(ownerId, runId, requestId, outcome, answer, now = Date.now(), { resumeRun = true } = {}) {
    return this.transaction(() => {
      if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
      const row = this.db.prepare('SELECT * FROM pending_inputs WHERE request_id = ? AND run_id = ?').get(requestId, runId)
      if (!row) throw notFound('问题不存在或已关闭')
      if (row.status !== 'pending') return { pending: decodePending(row), changed: false }
      this.db.prepare(`UPDATE pending_inputs SET status = ?, answer_json = ?, settled_at = ? WHERE request_id = ?`)
        .run(outcome, answer == null ? null : JSON.stringify(answer), now, requestId)
      if (resumeRun)
        this.db.prepare(`UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'waiting_input'`).run(now, runId)
      return { pending: this.getPendingInput(ownerId, runId), changed: true }
    })()
  }

  touchPendingInput(ownerId, runId, requestId) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    const result = this.db.prepare(`UPDATE pending_inputs SET interacted = 1, deadline_at = NULL
      WHERE request_id = ? AND run_id = ? AND status = 'pending'`).run(requestId, runId)
    return result.changes > 0
  }

  markStreamedStep(ownerId, runId, turn, step) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare('INSERT OR IGNORE INTO streamed_steps(run_id, turn_number, step_number) VALUES (?, ?, ?)')
      .run(runId, turn, step)
  }

  clearStreamedStep(ownerId, runId, turn, step) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare('DELETE FROM streamed_steps WHERE run_id = ? AND turn_number = ? AND step_number = ?').run(runId, turn, step)
  }

  isStreamedStep(ownerId, runId, turn, step) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    return Boolean(this.db.prepare('SELECT 1 FROM streamed_steps WHERE run_id = ? AND turn_number = ? AND step_number = ?')
      .get(runId, turn, step))
  }

  startToolCall(ownerId, runId, callId, toolName) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare(`INSERT INTO tool_calls(run_id, call_id, tool_name, status) VALUES (?, ?, ?, 'started')
      ON CONFLICT(run_id, call_id) DO UPDATE SET tool_name = excluded.tool_name`)
      .run(runId, callId, toolName)
  }

  finishToolCall(ownerId, runId, callId) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    const row = this.db.prepare('SELECT tool_name FROM tool_calls WHERE run_id = ? AND call_id = ?').get(runId, callId)
    this.db.prepare(`UPDATE tool_calls SET status = 'finished' WHERE run_id = ? AND call_id = ?`).run(runId, callId)
    return row?.tool_name
  }

  appendEvent(ownerId, runId, payload, now = Date.now()) {
    const entry = this.transaction(() => {
      const run = this.db.prepare('SELECT next_seq FROM runs WHERE id = ? AND owner_id = ?').get(runId, ownerId)
      if (!run) throw notFound('任务不存在')
      const sequence = run.next_seq
      const committed = { ...payload, _id: encodeCursor(sequence) }
      this.db.prepare('INSERT INTO run_events(run_id, seq, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(runId, sequence, JSON.stringify(committed), now)
      this.db.prepare('UPDATE runs SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?').run(now, runId)
      return committed
    })()
    this.onEvent?.(runId, entry)
    return entry
  }

  eventsAfter(ownerId, runId, after, limit = 1000) {
    const run = this.getRun(ownerId, runId)
    if (!run) throw notFound('任务不存在')
    return this.db.prepare(`SELECT payload_json FROM run_events
      WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(runId, after, limit).map((row) => JSON.parse(row.payload_json))
  }

  allEvents(ownerId, runId) {
    const events = []
    let sequence = 0
    while (true) {
      const page = this.eventsAfter(ownerId, runId, sequence, 1000)
      if (page.length === 0) return events
      events.push(...page)
      sequence = Number(page.at(-1)._id.split('-')[0])
    }
  }

  transitionRun(ownerId, runId, status, error, now = Date.now()) {
    const result = this.db.prepare('UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
      .run(status, error ?? null, now, runId, ownerId)
    if (result.changes !== 1) throw notFound('任务不存在')
    return this.getRun(ownerId, runId)
  }

  recoverInterrupted(now = Date.now()) {
    const recover = this.transaction(() => {
      const rows = this.db.prepare(`SELECT id, owner_id FROM runs
        WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered')`).all()
      this.db.prepare(`UPDATE runs SET status = 'interrupted', error = COALESCE(error, ?), updated_at = ?
        WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered')`)
        .run('适配层进程重启，任务已中断', now)
      this.db.prepare(`UPDATE pending_inputs SET status = 'aborted', settled_at = ? WHERE status = 'pending'`).run(now)
      return rows
    })
    return recover()
  }

  hasActiveRuns(ownerId) {
    const placeholders = [...TERMINAL].map(() => '?').join(', ')
    return Boolean(this.db.prepare(`SELECT 1 FROM runs WHERE owner_id = ? AND status NOT IN (${placeholders}) LIMIT 1`)
      .get(ownerId, ...TERMINAL))
  }

  activeRunBySession(sessionId) {
    const placeholders = [...TERMINAL].map(() => '?').join(', ')
    const row = this.db.prepare(`SELECT * FROM runs WHERE session_id = ? AND status NOT IN (${placeholders})
      ORDER BY queue_order, created_at, id LIMIT 1`).get(sessionId, ...TERMINAL)
    return row ? decodeRun(row) : undefined
  }

  activeRun(ownerId, chatId) {
    const placeholders = [...TERMINAL].map(() => '?').join(', ')
    const row = this.db.prepare(`SELECT * FROM runs WHERE owner_id = ? AND chat_id = ?
      AND status NOT IN (${placeholders}) ORDER BY queue_order, created_at, id LIMIT 1`)
      .get(ownerId, chatId, ...TERMINAL)
    return row ? decodeRun(row) : undefined
  }
}

function decodeChat(row) {
  return {
    id: row.id, ownerId: row.owner_id, sessionId: row.session_id, title: row.title,
    pinned: Boolean(row.pinned), favorited: Boolean(row.favorited), version: row.version, selection: JSON.parse(row.selection_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function decodeRun(row) {
  return {
    id: row.id, ownerId: row.owner_id, chatId: row.chat_id, sessionId: row.session_id,
    requestKey: row.request_key ?? undefined, query: row.query, attachments: JSON.parse(row.attachments_json), mcpTools: JSON.parse(row.mcp_tools_json), status: row.status,
    error: row.error ?? undefined, feedback: row.feedback ?? null, selection: JSON.parse(row.selection_json),
    parentRunId: row.parent_run_id ?? undefined, queueOrder: row.queue_order,
    turnNumber: row.turn_number ?? undefined, messageId: row.message_id ?? undefined,
    sourceStartSeq: row.source_start_seq ?? undefined, sourceEndSeq: row.source_end_seq ?? undefined,
    seq: row.next_seq - 1, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function decodePending(row) {
  return {
    requestId: row.request_id,
    runId: row.run_id,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    answer: parseNullable(row.answer_json),
    deadlineAt: row.deadline_at,
    interacted: Boolean(row.interacted),
    createdAt: row.created_at,
    settledAt: row.settled_at,
  }
}

function decodeControl(row) {
  return {
    revision: row.revision,
    todos: JSON.parse(row.todos_json),
    todos_run_id: null,
    goal: parseNullable(row.goal_json),
    plan: JSON.parse(row.plan_json),
    compaction: parseNullable(row.compaction_json),
  }
}

function parseNullable(value) { return value == null ? null : JSON.parse(value) }
function stringifyNullable(value) { return value == null ? null : JSON.stringify(value) }

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 })
}
