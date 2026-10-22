import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeCursor } from './cursor.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered'])

export class WorkbenchDatabase {
  constructor(filename, { onEvent, streamFlushMs = 20, streamBatchBytes = 64 * 1024, onStreamError } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.onEvent = onEvent
    this.onStreamError = onStreamError
    this.streamFlushMs = streamFlushMs
    this.streamBatchBytes = streamBatchBytes
    this.pendingStream = []
    this.pendingStreamBytes = 0
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
      CREATE TABLE IF NOT EXISTS platform_schedule_sync (
        owner_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        fingerprint TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS chat_deletions (
        chat_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        session_ids_json TEXT NOT NULL,
        file_deletion_json TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS workspace_deletions (
        workspace_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        completed_at INTEGER
      );
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
      CREATE TABLE IF NOT EXISTS run_submissions (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        content_json TEXT NOT NULL,
        dispatched INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runs_session_message ON runs(session_id, message_id) WHERE message_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS pending_turns (
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        start_seq INTEGER NOT NULL,
        PRIMARY KEY(session_id, turn_number)
      );
      CREATE TABLE IF NOT EXISTS run_turns (
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        PRIMARY KEY(session_id, turn_number)
      );
      CREATE TABLE IF NOT EXISTS projected_native_events (
        session_id TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        PRIMARY KEY(session_id, source_seq)
      );
      CREATE TABLE IF NOT EXISTS goal_runs (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS run_fences (
        run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        confirmed INTEGER NOT NULL DEFAULT 0,
        result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, seq)
      );
      -- These additive indexes are also usable by older readers. Materialize
      -- event classification once at insertion/migration, not on every state poll.
      CREATE INDEX IF NOT EXISTS run_events_end ON run_events(run_id, seq DESC, created_at)
        WHERE json_extract(payload_json, '$.event') = 'workbench_end';
      CREATE INDEX IF NOT EXISTS run_events_started ON run_events(run_id, seq, created_at)
        WHERE json_extract(payload_json, '$.status') = 'running'
          OR json_extract(payload_json, '$.event') = 'workbench_activity';
      CREATE INDEX IF NOT EXISTS run_events_context ON run_events(run_id, seq DESC)
        WHERE json_extract(payload_json, '$.event') = 'workbench_context';
      CREATE INDEX IF NOT EXISTS run_events_steering ON run_events(run_id, seq)
        WHERE json_extract(payload_json, '$.event') IN ('workbench_steering', 'workbench_steered');
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
    if (!this.db.prepare('PRAGMA table_info(chats)').all().some((column) => column.name === 'directory'))
      this.db.exec('ALTER TABLE chats ADD COLUMN directory TEXT')
    if (!this.db.prepare('PRAGMA table_info(run_fences)').all().some((column) => column.name === 'result_json'))
      this.db.exec('ALTER TABLE run_fences ADD COLUMN result_json TEXT')
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)').run(Date.now())
    this.db.exec(`INSERT OR IGNORE INTO run_turns(session_id, turn_number, run_id)
      SELECT session_id, turn_number, id FROM runs WHERE turn_number IS NOT NULL AND status NOT IN ('steered', 'discarded')`)
    this.db.exec(`INSERT OR IGNORE INTO run_fences(run_id)
      SELECT id FROM runs WHERE turn_number IS NOT NULL AND status IN ('completed','failed','cancelled','interrupted')`)
  }

  transaction(operation) {
    return () => {
      if (this.inTransaction) return operation()
      this.db.exec('BEGIN IMMEDIATE')
      this.inTransaction = true
      this.pendingPublications = []
      try {
        const result = operation()
        this.db.exec('COMMIT')
        this.inTransaction = false
        const publications = this.pendingPublications
        this.pendingPublications = []
        for (const [runId, entry] of publications) this.publishEvent(runId, entry)
        return result
      } catch (error) {
        if (this.inTransaction) this.db.exec('ROLLBACK')
        this.pendingPublications = []
        throw error
      } finally {
        this.inTransaction = false
      }
    }
  }

  close() {
    this.flushStreamEvents()
    clearTimeout(this.streamTimer)
    this.db.close()
  }

  scheduleSyncSequence(ownerId, fingerprint) {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT sequence,fingerprint FROM platform_schedule_sync WHERE owner_id=?').get(ownerId)
      if (current?.fingerprint === fingerprint) return current.sequence
      const sequence = (current?.sequence ?? 0) + 1
      this.db.prepare(`INSERT INTO platform_schedule_sync(owner_id,sequence,fingerprint) VALUES(?,?,?)
        ON CONFLICT(owner_id) DO UPDATE SET sequence=excluded.sequence,fingerprint=excluded.fingerprint`).run(ownerId, sequence, fingerprint)
      return sequence
    })()
  }

  publishEvent(runId, entry) {
    try { this.onEvent?.(runId, entry) }
    catch { /* Observers cannot roll back a committed cursor or trigger replay. */ }
  }

  importChat({ id, ownerId, sessionId, title, pinned = false, favorited = false, selection, createdAt, updatedAt, directory = null }) {
    const existing = this.getChat(ownerId, id)
    if (existing) return existing
    this.db.prepare(`INSERT INTO chats
      (id, owner_id, session_id, title, pinned, favorited, selection_json, created_at, updated_at, directory)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ownerId, sessionId, title, Number(pinned), Number(favorited), JSON.stringify(selection), createdAt, updatedAt, directory)
    this.db.prepare('INSERT INTO control_state(chat_id, updated_at) VALUES (?, ?)').run(id, updatedAt)
    return this.getChat(ownerId, id)
  }

  createChat({ ownerId, sessionId, selection, directory = null, title = '新会话', id = randomUUID(), now = Date.now() }) {
    const create = this.transaction(() => {
      this.db.prepare(`INSERT INTO chats
        (id, owner_id, session_id, title, selection_json, created_at, updated_at, directory)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, ownerId, sessionId, title, JSON.stringify(selection), now, now, directory)
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

  rebindFailedRunSession(ownerId, runId, sessionId) {
    this.db.prepare("UPDATE runs SET session_id = ? WHERE owner_id = ? AND id = ? AND status = 'failed'").run(sessionId, ownerId, runId)
  }

  getChatBySession(sessionId) {
    const row = this.db.prepare('SELECT * FROM chats WHERE session_id = ? AND deleted_at IS NULL').get(sessionId)
    return row ? decodeChat(row) : undefined
  }

  listChats(ownerId) {
    return this.db.prepare('SELECT * FROM chats WHERE owner_id = ? AND deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC, id')
      .all(ownerId).map(decodeChat)
  }
  // Retained native tasks keep their original owner even after chat soft deletion.
  chatBindings(ownerId) {
    return this.db.prepare('SELECT id, session_id AS sessionId, title, deleted_at AS deletedAt FROM chats WHERE owner_id = ?')
      .all(ownerId)
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

  deletionChat(ownerId, chatId) {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ? AND owner_id = ?').get(chatId, ownerId)
    return row ? decodeChat(row) : undefined
  }

  directoryChats(ownerId) {
    // Include interrupted deletions until native writers have been erased.
    return this.db.prepare('SELECT * FROM chats WHERE owner_id = ?').all(ownerId).map(decodeChat)
  }

  workspaceDeletion(ownerId, workspaceId) {
    const row = this.db.prepare('SELECT * FROM workspace_deletions WHERE owner_id = ? AND workspace_id = ?').get(ownerId, workspaceId)
    return row ? { ...JSON.parse(row.plan_json), workspaceId, completedAt: row.completed_at } : undefined
  }

  pendingWorkspaceDeletions(ownerId) {
    return this.db.prepare('SELECT workspace_id FROM workspace_deletions WHERE owner_id = ? AND completed_at IS NULL')
      .all(ownerId).map(row => this.workspaceDeletion(ownerId, row.workspace_id))
  }

  beginWorkspaceDeletion(ownerId, workspaceId, plan) {
    this.db.prepare('INSERT OR IGNORE INTO workspace_deletions(workspace_id, owner_id, plan_json) VALUES (?, ?, ?)')
      .run(workspaceId, ownerId, JSON.stringify(plan))
    return this.workspaceDeletion(ownerId, workspaceId)
  }

  finishWorkspaceDeletion(ownerId, workspaceId) {
    this.db.prepare('UPDATE workspace_deletions SET completed_at = ? WHERE owner_id = ? AND workspace_id = ?')
      .run(Date.now(), ownerId, workspaceId)
  }

  chatDeletion(ownerId, chatId) {
    const row = this.db.prepare('SELECT * FROM chat_deletions WHERE owner_id = ? AND chat_id = ?').get(ownerId, chatId)
    return row ? { chatId: row.chat_id, sessionIds: JSON.parse(row.session_ids_json), fileDeletion: parseNullable(row.file_deletion_json), completedAt: row.completed_at } : undefined
  }

  pendingChatDeletions(ownerId) {
    return this.db.prepare('SELECT chat_id FROM chat_deletions WHERE owner_id = ? AND completed_at IS NULL')
      .all(ownerId).map(row => this.chatDeletion(ownerId, row.chat_id))
  }

  retainedRunInputs(ownerId) {
    return this.db.prepare(`SELECT r.query, r.attachments_json, s.content_json FROM runs r
      JOIN chats c ON c.id = r.chat_id LEFT JOIN run_submissions s ON s.run_id = r.id
      WHERE c.owner_id = ? AND c.deleted_at IS NULL`).iterate(ownerId)
  }

  beginChatDeletion(ownerId, chatId, sessionIds, fileDeletion, now = Date.now()) {
    return this.transaction(() => {
      const chat = this.deletionChat(ownerId, chatId)
      if (!chat) throw notFound('会话不存在或已被删除')
      if (this.db.prepare("SELECT id FROM runs WHERE chat_id = ? AND status IN ('queued','running','waiting_input','stopping') LIMIT 1").get(chatId))
        throw Object.assign(new Error('会话任务尚未停止'), { status: 409 })
      const ids = [...new Set([chat.sessionId, ...sessionIds])]
      for (const id of ids) if (this.db.prepare('SELECT id FROM chats WHERE session_id = ? AND id <> ?').get(id, chatId))
        throw new Error('Cannot delete another conversation session')
      this.db.prepare('INSERT OR IGNORE INTO chat_deletions(chat_id,owner_id,session_ids_json,file_deletion_json,created_at) VALUES (?,?,?,?,?)')
        .run(chatId, ownerId, JSON.stringify(ids), fileDeletion ? JSON.stringify(fileDeletion) : null, now)
      this.db.prepare('UPDATE chats SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, chatId)
      return this.chatDeletion(ownerId, chatId)
    })()
  }

  finishChatDeletion(ownerId, chatId, now = Date.now()) {
    this.flushStreamEvents()
    this.transaction(() => {
      const deletion = this.chatDeletion(ownerId, chatId)
      if (!deletion) throw new Error('Missing permanent deletion receipt')
      this.db.exec('PRAGMA secure_delete = ON')
      for (const sessionId of deletion.sessionIds) {
        this.db.prepare('DELETE FROM pending_turns WHERE session_id = ?').run(sessionId)
        this.db.prepare('DELETE FROM projected_native_events WHERE session_id = ?').run(sessionId)
      }
      // Runs, events, inputs, receipts and control state share this FK cascade.
      this.db.prepare('DELETE FROM chats WHERE id = ? AND owner_id = ?').run(chatId, ownerId)
      this.db.prepare('UPDATE chat_deletions SET file_deletion_json = NULL WHERE chat_id = ? AND owner_id = ?').run(chatId, ownerId)
    })()
    const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (checkpoint.busy) throw new Error('Conversation deletion is waiting for a reader; retry deletion')
    this.db.prepare('UPDATE chat_deletions SET completed_at = ? WHERE chat_id = ? AND owner_id = ?').run(now, chatId, ownerId)
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
      // Only forkChat's copied historical rows carry this marker. New Goal,
      // child and ordinary turns must expose their own native file changes.
      const { fork_source: _forkSource, ...currentSelection } = selection
      this.db.prepare(`INSERT INTO runs
        (id, owner_id, chat_id, session_id, request_key, query, attachments_json, mcp_tools_json, status, selection_json,
         parent_run_id, queue_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
        .run(id, ownerId, chatId, sessionId, requestKey ?? null, query, JSON.stringify(attachments), JSON.stringify(mcpTools), JSON.stringify(currentSelection), parentRunId ?? null, queueOrder, now, now)
      this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chatId)
      return { run: this.getRun(ownerId, id), created: true }
    })
    return create()
  }

  getRun(ownerId, id, { includeDeleted = false } = {}) {
    this.flushStreamEvents()
    const row = this.db.prepare(`SELECT r.*, f.result_json AS stop_confirmation_json FROM runs r JOIN chats c ON c.id = r.chat_id LEFT JOIN run_fences f ON f.run_id=r.id
      WHERE r.id = ? AND r.owner_id = ? AND (? OR c.deleted_at IS NULL)`).get(id, ownerId, Number(includeDeleted))
    return row ? { ...decodeRun(row), ...(row.error ? { errorCode: this.runErrorCode(ownerId, id) } : {}) } : undefined
  }

  /** Transport/receipt authorization needs no frozen tool/attachment payloads. */
  getRunState(ownerId, id) {
    this.flushStreamEvents()
    this.runStreamStateStatement ??= this.db.prepare(`SELECT r.id, r.status, r.next_seq - 1 AS seq
      FROM runs r JOIN chats c ON c.id=r.chat_id
      WHERE r.id=? AND r.owner_id=? AND c.deleted_at IS NULL`)
    return this.runStreamStateStatement.get(id, ownerId)
  }

  runErrorCode(ownerId, id) {
    const row = this.db.prepare(`SELECT e.payload_json FROM run_events e INDEXED BY run_events_end JOIN runs r ON r.id=e.run_id
      WHERE e.run_id=? AND r.owner_id=? AND json_extract(e.payload_json, '$.event')='workbench_end'
      ORDER BY e.seq DESC LIMIT 1`).get(id, ownerId)
    return row ? JSON.parse(row.payload_json).error_code : undefined
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
    const assigned = this.runForTurn(sessionId, turn)
    if (!assigned || assigned.id === requestId) this.db.prepare(`INSERT INTO run_turns(session_id, turn_number, run_id)
      SELECT session_id, ?, id FROM runs WHERE session_id = ? AND id = ? AND status NOT IN ('steered', 'discarded')
      ON CONFLICT(session_id, turn_number) DO UPDATE SET run_id=excluded.run_id
      WHERE EXISTS (SELECT 1 FROM runs previous WHERE previous.id=run_turns.run_id
        AND previous.session_id=run_turns.session_id AND previous.status IN ('steered', 'discarded'))`)
      .run(turn, sessionId, requestId)
    const start = this.db.prepare('SELECT start_seq FROM pending_turns WHERE session_id = ? AND turn_number = ?').get(sessionId, turn)
    if (start) this.db.prepare('UPDATE runs SET source_start_seq = ? WHERE session_id = ? AND id = ?').run(start.start_seq, sessionId, requestId)
    this.db.prepare('DELETE FROM pending_turns WHERE session_id = ? AND turn_number = ?').run(sessionId, turn)
    const row = this.db.prepare('SELECT * FROM runs WHERE session_id = ? AND id = ?').get(sessionId, requestId)
    return row ? decodeRun(row) : undefined
  }

  bindNativeTurn(run, turn) {
    this.db.prepare(`INSERT INTO run_turns(session_id, turn_number, run_id)
      SELECT session_id, ?, id FROM runs WHERE session_id = ? AND id = ? AND status NOT IN ('steered', 'discarded')
      ON CONFLICT(session_id, turn_number) DO UPDATE SET run_id=excluded.run_id
      WHERE EXISTS (SELECT 1 FROM runs previous WHERE previous.id=run_turns.run_id
        AND previous.session_id=run_turns.session_id AND previous.status IN ('steered', 'discarded'))`)
      .run(turn, run.sessionId, run.id)
    const start = this.db.prepare('SELECT start_seq FROM pending_turns WHERE session_id=? AND turn_number=?').get(run.sessionId, turn)
    this.db.prepare('UPDATE runs SET turn_number=COALESCE(turn_number, ?), source_start_seq=COALESCE(source_start_seq, ?) WHERE id=?')
      .run(turn, start?.start_seq ?? null, run.id)
    this.db.prepare('DELETE FROM pending_turns WHERE session_id=? AND turn_number=?').run(run.sessionId, turn)
    return this.runForTurn(run.sessionId, turn)
  }

  setGoalRun(sessionId, runId) {
    if (!runId) {
      this.db.prepare('DELETE FROM goal_runs WHERE session_id=?').run(sessionId)
      return
    }
    this.db.prepare('INSERT INTO goal_runs(session_id, run_id) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET run_id=excluded.run_id')
      .run(sessionId, runId)
  }

  goalRun(sessionId) {
    const row = this.db.prepare('SELECT r.* FROM runs r JOIN goal_runs g ON r.id=g.run_id WHERE g.session_id=?').get(sessionId)
    return row ? { ...decodeRun(row), ...(row.error ? { errorCode: this.runErrorCode(row.owner_id, row.id) } : {}) } : undefined
  }

  updateRunResources(run, selection, mcpTools) {
    this.db.prepare('UPDATE runs SET selection_json=?, mcp_tools_json=? WHERE id=? AND owner_id=?')
      .run(JSON.stringify(selection), JSON.stringify(mcpTools), run.id, run.ownerId)
  }

  hasProjectedEvent(sessionId, seq) {
    return Number.isInteger(seq) && Boolean(this.db.prepare('SELECT 1 FROM projected_native_events WHERE session_id=? AND source_seq=?').get(sessionId, seq))
  }

  markProjectedEvent(sessionId, seq) {
    if (Number.isInteger(seq)) this.db.prepare('INSERT OR IGNORE INTO projected_native_events VALUES (?, ?)').run(sessionId, seq)
  }

  setRunSourceSeq(ownerId, runId, field, seq) {
    if (!['source_start_seq', 'source_end_seq'].includes(field)) throw new TypeError('invalid source sequence field')
    const value = field === 'source_start_seq' ? `MIN(COALESCE(${field}, ?), ?)` : '?'
    const result = this.db.prepare(`UPDATE runs SET ${field} = ${value} WHERE id = ? AND owner_id = ?`)
      .run(...(field === 'source_start_seq' ? [seq, seq] : [seq]), runId, ownerId)
    if (result.changes !== 1) throw notFound('任务不存在')
  }



  previousRun(sessionId, turn) {
    const row = this.db.prepare(`SELECT * FROM runs WHERE session_id = ? AND turn_number < ? AND source_end_seq IS NOT NULL
      ORDER BY turn_number DESC LIMIT 1`).get(sessionId, turn)
    return row ? decodeRun(row) : undefined
  }

  runForTurn(sessionId, turn) {
    // The durable native turn binding is authoritative. Resolve its primary key
    // before considering legacy receipts without a binding; scanning all runs
    // also traverses every large frozen resource snapshot during recovery.
    const bound = this.db.prepare(`SELECT r.* FROM run_turns t JOIN runs r ON r.id=t.run_id
      WHERE t.session_id=? AND t.turn_number=? AND r.session_id=t.session_id
      AND r.status NOT IN ('steered', 'discarded')`).get(sessionId, turn)
    if (bound) return decodeRun(bound)
    const row = this.db.prepare(`SELECT r.* FROM runs r LEFT JOIN run_turns t ON t.run_id=r.id
      WHERE r.session_id = ? AND (t.turn_number = ? OR r.turn_number = ?)
      AND r.status NOT IN ('steered', 'discarded') ORDER BY r.queue_order LIMIT 1`).get(sessionId, turn, turn)
    return row ? decodeRun(row) : undefined
  }

  /** Streaming needs only the current binding, never the frozen MCP schemas. */
  streamRunForTurn(sessionId, turn) {
    this.boundStreamRunStatement ??= this.db.prepare(`SELECT r.id, r.owner_id AS ownerId FROM run_turns t
      JOIN runs r ON r.id=t.run_id AND r.session_id=t.session_id
      JOIN chats c ON c.id=r.chat_id AND c.session_id=r.session_id AND c.owner_id=r.owner_id
      WHERE t.session_id=? AND t.turn_number=? AND c.deleted_at IS NULL
      AND r.status NOT IN ('steered', 'discarded')`)
    const bound = this.boundStreamRunStatement.get(sessionId, turn)
    if (bound) return bound
    this.streamRunStatement ??= this.db.prepare(`SELECT r.id, r.owner_id AS ownerId FROM runs r
      JOIN chats c ON c.id=r.chat_id AND c.session_id=r.session_id AND c.owner_id=r.owner_id
      LEFT JOIN run_turns t ON t.run_id=r.id
      WHERE r.session_id=? AND (t.turn_number=? OR r.turn_number=?) AND c.deleted_at IS NULL
      AND r.status NOT IN ('steered', 'discarded') ORDER BY r.queue_order LIMIT 1`)
    return this.streamRunStatement.get(sessionId, turn, turn)
  }

  runForMessage(sessionId, messageId) {
    if (typeof messageId !== 'string') return undefined
    const row = this.db.prepare('SELECT * FROM runs WHERE session_id=? AND message_id=?').get(sessionId, messageId)
    return row ? decodeRun(row) : undefined
  }

  followups(ownerId, chatId, tracked = []) {
    if (!this.getChat(ownerId, chatId)) throw notFound('会话不存在或已被删除')
    if (tracked.length === 0) return []
    const placeholders = tracked.map(() => '?').join(', ')
    return this.db.prepare(`SELECT r.*, f.result_json AS stop_confirmation_json FROM runs r LEFT JOIN run_fences f ON f.run_id=r.id
      WHERE r.owner_id = ? AND r.chat_id = ? AND r.id IN (${placeholders})`)
      .all(ownerId, chatId, ...tracked).map(decodeRun)
  }

  pendingScheduleNotifications(ownerId) {
    return this.db.prepare(`SELECT r.* FROM runs r JOIN chats c ON c.id=r.chat_id
      WHERE r.owner_id=? AND c.deleted_at IS NULL
      AND json_extract(r.selection_json, '$.schedule_notification_pending')=1
      ORDER BY r.created_at,r.id`).all(ownerId).map(decodeRun)
  }

  rememberScheduleInitialization(ownerId, chatId, task, createdAt) {
    return this.saveCommandReceipt(ownerId, chatId, `schedule-notify-init:${task.id}`, { task, createdAt })
  }

  pendingScheduleInitializations(ownerId) {
    return this.db.prepare(`SELECT r.chat_id,r.result_json FROM command_receipts r JOIN chats c ON c.id=r.chat_id
      WHERE r.owner_id=? AND c.deleted_at IS NULL AND r.request_key LIKE 'schedule-notify-init:%'
      AND json_extract(r.result_json, '$.createdAt') IS NOT NULL
      ORDER BY r.created_at,r.request_key`).all(ownerId)
      .map(row => ({ chatId: row.chat_id, ...JSON.parse(row.result_json) }))
  }

  acknowledgeScheduleInitialization(ownerId, chatId, jobId) {
    // The platform's config version is the replay fence; completed local
    // initialization records need not accumulate beside creation receipts.
    this.db.prepare('DELETE FROM command_receipts WHERE owner_id=? AND chat_id=? AND request_key=?')
      .run(ownerId, chatId, `schedule-notify-init:${jobId}`)
  }

  acknowledgeScheduleNotification(ownerId, runId) {
    const run = this.getRun(ownerId, runId)
    if (run) this.updateRunResources(run, { ...run.selection, schedule_notification_pending: false }, run.mcpTools)
  }

  scheduleNotificationEnd(ownerId, runId) {
    return this.db.prepare(`SELECT e.payload_json,e.created_at FROM run_events e JOIN runs r ON r.id=e.run_id
      WHERE r.owner_id=? AND r.id=? AND json_extract(e.payload_json, '$.event')='workbench_end'
      ORDER BY e.seq DESC LIMIT 1`).get(ownerId, runId)
  }

  listRuns(ownerId, chatId) {
    return this.db.prepare(`SELECT r.*, f.result_json AS stop_confirmation_json FROM runs r LEFT JOIN run_fences f ON f.run_id=r.id
      WHERE r.owner_id = ? AND r.chat_id = ? ORDER BY r.created_at, r.rowid`)
      .all(ownerId, chatId).map(decodeRun)
  }

  // Index and display selection must not hydrate every frozen resource snapshot.
  listRunReferences(ownerId, chatId) {
    return this.db.prepare(`SELECT id, session_id AS sessionId, message_id AS messageId, status,
      parent_run_id AS parentRunId, source_start_seq AS sourceStartSeq, source_end_seq AS sourceEndSeq,
      json_extract(selection_json, '$.native_child') AS nativeChild FROM runs
      WHERE owner_id = ? AND chat_id = ? ORDER BY created_at, rowid`).all(ownerId, chatId)
  }

  runForSubagent(ownerId, chatId, childId) {
    const row = this.db.prepare(`SELECT r.*, f.result_json AS stop_confirmation_json FROM runs r
      LEFT JOIN run_fences f ON f.run_id=r.id WHERE r.owner_id=? AND r.chat_id=?
      AND EXISTS (SELECT 1 FROM json_each(r.selection_json, '$.subagent_ids') WHERE value=?)
      ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`).get(ownerId, chatId, childId)
    return row ? decodeRun(row) : undefined
  }

  // Read existing native completion receipts; this is a display projection,
  // not a second task lifecycle. Feedback/config edits cannot advance its time.
  chatCompletions(ownerId) {
    const rows = this.db.prepare(`WITH receipts AS (
      SELECT r.id, r.chat_id, r.session_id, r.status, r.queue_order,
        COALESCE((SELECT COALESCE(json_extract(e.payload_json, '$.occurred_at'), e.created_at)
          FROM run_events e WHERE e.run_id=r.id
          AND json_extract(e.payload_json, '$.event') IN ('workbench_end','workbench_status')
          AND json_extract(e.payload_json, '$.status') IN ('completed','failed','cancelled','interrupted')
          ORDER BY e.seq DESC LIMIT 1), r.created_at) AS at
      FROM runs r WHERE r.owner_id=? AND r.status IN ('completed','failed','cancelled','interrupted')
    ), latest AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY at DESC, queue_order DESC) AS position FROM receipts
    ) SELECT * FROM latest WHERE position=1`).all(ownerId)
    return new Map(rows.map(row => [row.session_id, {
      id: row.id, status: row.status, at: row.at,
    }]))
  }

  latestRunStatus(ownerId, chatId) {
    return this.db.prepare('SELECT status FROM runs WHERE owner_id = ? AND chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(ownerId, chatId)?.status
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
    const calls = this.db.prepare(`SELECT call_id FROM tool_calls WHERE run_id = ? AND tool_name = ? AND status = 'started'`)
      .all(runId, payload.tool_name)
    if (calls.length === 1) payload = { ...payload, tool_call_id: calls[0].call_id }
    this.transaction(() => {
      this.db.prepare(`INSERT INTO pending_inputs
        (request_id, run_id, payload_json, status, deadline_at, created_at)
        VALUES (?, ?, ?, 'pending', ?, ?)`)
        .run(requestId, runId, JSON.stringify(payload), deadlineAt ?? null, now)
      this.db.prepare(`UPDATE runs SET status = 'waiting_input', updated_at = ? WHERE id = ?`).run(now, runId)
    })()
    return this.getPendingInput(ownerId, runId)
  }

  getPendingInput(ownerId, runId, requestId = null) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    const row = this.db.prepare(`SELECT p.* FROM pending_inputs p
      JOIN runs r ON r.id = p.run_id WHERE p.run_id = ? AND r.owner_id = ?
        AND (? IS NULL OR p.request_id = ?)
      ORDER BY (p.status = 'pending') DESC, p.created_at DESC, p.rowid DESC LIMIT 1`).get(runId, ownerId, requestId, requestId)
    return row ? decodePending(row) : null
  }

  listPendingInputs(ownerId, runId) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    const rows = this.db.prepare(`SELECT p.request_id, p.run_id, p.status, p.deadline_at,
      p.interacted, p.created_at, p.settled_at,
      CASE WHEN length(CAST(p.payload_json AS BLOB)) + length(CAST(COALESCE(p.answer_json, '') AS BLOB)) <= 8388608
        THEN p.payload_json END AS payload_json,
      CASE WHEN length(CAST(p.payload_json AS BLOB)) + length(CAST(COALESCE(p.answer_json, '') AS BLOB)) <= 8388608
        THEN p.answer_json END AS answer_json FROM pending_inputs p
      JOIN runs r ON r.id = p.run_id WHERE p.run_id = ? AND r.owner_id = ?
      ORDER BY p.created_at, p.rowid`).iterate(runId, ownerId)
    const inputs = []
    let bytes = 0
    for (const row of rows) {
      bytes += row.payload_json == null ? Infinity
        : Buffer.byteLength(row.payload_json) + Buffer.byteLength(row.answer_json ?? '')
      if (bytes > 8 * 1024 * 1024 || inputs.length >= 10000)
        throw Object.assign(new Error('任务交互记录超过读取大小限制'), { status: 413, code: 'RUN_METADATA_TOO_LARGE' })
      inputs.push(decodePending(row))
    }
    return inputs
  }

  recordInputSupplement(ownerId, runId, requestId, answer) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare(`UPDATE pending_inputs SET status = 'submitted', answer_json = ?
      WHERE request_id = ? AND run_id = ? AND status IN ('skipped', 'timeout', 'aborted')`)
      .run(JSON.stringify(answer), requestId, runId)
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
        this.db.prepare(`UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'waiting_input'
          AND NOT EXISTS (SELECT 1 FROM pending_inputs WHERE run_id = ? AND status = 'pending')`).run(now, runId, runId)
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
    if (!this.getRunState(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare('INSERT OR IGNORE INTO streamed_steps(run_id, turn_number, step_number) VALUES (?, ?, ?)')
      .run(runId, turn, step)
  }

  clearStreamedStep(ownerId, runId, turn, step) {
    if (!this.getRunState(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare('DELETE FROM streamed_steps WHERE run_id = ? AND turn_number = ? AND step_number = ?').run(runId, turn, step)
  }

  isStreamedStep(ownerId, runId, turn, step) {
    if (!this.getRunState(ownerId, runId)) throw notFound('任务不存在')
    return Boolean(this.db.prepare('SELECT 1 FROM streamed_steps WHERE run_id = ? AND turn_number = ? AND step_number = ?')
      .get(runId, turn, step))
  }

  startToolCall(ownerId, runId, callId, toolName) {
    if (!this.getRunState(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare(`INSERT INTO tool_calls(run_id, call_id, tool_name, status) VALUES (?, ?, ?, 'started')
      ON CONFLICT(run_id, call_id) DO UPDATE SET tool_name = excluded.tool_name`)
      .run(runId, callId, toolName)
  }

  finishToolCall(ownerId, runId, callId) {
    if (!this.getRunState(ownerId, runId)) throw notFound('任务不存在')
    const row = this.db.prepare('SELECT tool_name FROM tool_calls WHERE run_id = ? AND call_id = ?').get(runId, callId)
    this.db.prepare(`UPDATE tool_calls SET status = 'finished' WHERE run_id = ? AND call_id = ?`).run(runId, callId)
    return row?.tool_name
  }

  toolCallName(ownerId, runId, callId) {
    if (!this.getRunState(ownerId, runId)) throw notFound('任务不存在')
    return this.db.prepare('SELECT tool_name FROM tool_calls WHERE run_id = ? AND call_id = ?').get(runId, callId)?.tool_name
  }

  appendEvent(ownerId, runId, payload, now = Date.now()) {
    this.flushStreamEvents()
    this.eventSequenceStatement ??= this.db.prepare('SELECT next_seq FROM runs WHERE id = ? AND owner_id = ?')
    this.eventInsertStatement ??= this.db.prepare('INSERT INTO run_events(run_id, seq, payload_json, created_at) VALUES (?, ?, ?, ?)')
    this.eventAdvanceStatement ??= this.db.prepare('UPDATE runs SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?')
    const entry = this.transaction(() => {
      const run = this.eventSequenceStatement.get(runId, ownerId)
      if (!run) throw notFound('任务不存在')
      const sequence = run.next_seq
      const committed = { ...payload, _id: encodeCursor(sequence) }
      this.eventInsertStatement.run(runId, sequence, JSON.stringify(committed), now)
      this.eventAdvanceStatement.run(now, runId)
      return committed
    })()
    if (this.inTransaction) this.pendingPublications.push([runId, entry])
    else this.publishEvent(runId, entry)
    return entry
  }

  /** Buffer only unpublished deltas; a cursor exists only after FULL commit. */
  appendStreamEvent(ownerId, runId, payload, turn, step, now = Date.now()) {
    if (this.streamFlushError) this.flushStreamEvents()
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    this.pendingStream.push({ ownerId, runId, payload, turn, step, now, bytes })
    this.pendingStreamBytes += bytes
    if (this.pendingStreamBytes >= this.streamBatchBytes) return this.flushStreamEvents()
    if (!this.streamTimer) {
      this.streamTimer = setTimeout(() => {
        this.streamTimer = undefined
        try { this.flushStreamEvents() }
        catch (error) { this.onStreamError?.(error) }
      }, this.streamFlushMs)
      this.streamTimer.unref?.()
    }
    return undefined
  }

  flushStreamEvents() {
    if (this.flushingStream || !this.pendingStream.length) return
    clearTimeout(this.streamTimer)
    this.streamTimer = undefined
    const batch = this.pendingStream.splice(0)
    this.pendingStreamBytes = 0
    this.flushingStream = true
    try {
      this.transaction(() => {
        const marked = new Set()
        for (const { ownerId, runId, payload, turn, step, now } of batch) {
          const key = `${runId}:${turn}:${step}`
          if (!marked.has(key)) {
            this.markStreamedStep(ownerId, runId, turn, step)
            marked.add(key)
          }
          this.appendEvent(ownerId, runId, payload, now)
        }
      })()
      this.streamFlushError = undefined
    } catch (error) {
      this.pendingStream.unshift(...batch)
      this.pendingStreamBytes += batch.reduce((total, entry) => total + entry.bytes, 0)
      this.streamFlushError = error
      throw error
    } finally { this.flushingStream = false }
  }

  eventsAfter(ownerId, runId, after, limit = 1000, present = event => event,
    { through = Number.MAX_SAFE_INTEGER, maxBytes = 4 * 1024 * 1024 } = {}) {
    const run = this.getRunState(ownerId, runId)
    if (!run) throw notFound('任务不存在')
    // Project each row before retaining the page. Old context events can hold
    // large tool catalogs; collecting raw JSON first can exhaust the Host heap.
    const events = []
    let bytes = 0
    // Bound a single event too, leaving room for JSON/DTO copies in the Host.
    // Check inside SQLite so an oversized legacy row is not first copied to JS.
    const rows = this.db.prepare(`SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= 8388608
      THEN payload_json END AS payload_json FROM run_events
      WHERE run_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
      .iterate(runId, after, through, limit)
    for (const row of rows) {
      if (row.payload_json == null) throw Object.assign(new Error('单条历史事件超过读取大小限制'), { status: 413 })
      const event = present(JSON.parse(row.payload_json))
      const size = Buffer.byteLength(JSON.stringify(event))
      if (events.length && bytes + size > maxBytes) break
      events.push(event)
      bytes += size
    }
    return events
  }

  runTiming(ownerId, runId) {
    const run = this.getRun(ownerId, runId)
    if (!run) throw notFound('任务不存在')
    const timing = this.db.prepare(`WITH endings AS (
      SELECT seq, created_at FROM run_events INDEXED BY run_events_end WHERE run_id=? AND json_extract(payload_json, '$.event')='workbench_end'
      ORDER BY seq DESC LIMIT 2
    ) SELECT
      (SELECT created_at FROM run_events INDEXED BY run_events_started WHERE run_id=?
        AND seq>COALESCE((SELECT seq FROM endings LIMIT 1 OFFSET 1), -1)
        AND seq<=COALESCE((SELECT seq FROM endings LIMIT 1), 9223372036854775807)
        AND (json_extract(payload_json, '$.status')='running' OR json_extract(payload_json, '$.event')='workbench_activity')
        ORDER BY seq LIMIT 1) AS started,
      (SELECT created_at FROM endings LIMIT 1) AS ended,
      (SELECT created_at FROM run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1) AS last_event`)
      .get(runId, runId, runId)
    const ended = TERMINAL.has(run.status) ? timing.ended ?? timing.last_event ?? run.updatedAt : null
    return {
      started_at: timing.started == null ? null : timing.started / 1000,
      completed_at: ended == null ? null : ended / 1000,
      elapsed_seconds: ended != null && timing.started != null ? Math.max(0, ended - timing.started) / 1000 : null,
    }
  }

  latestContextEvent(ownerId, runId) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= 8388608
      THEN payload_json END AS payload_json FROM run_events WHERE run_id = ?
      AND json_extract(payload_json, '$.event') = 'workbench_context' ORDER BY seq DESC LIMIT 1`).get(runId)
    if (row && row.payload_json == null) throw Object.assign(new Error('单条历史事件超过读取大小限制'), { status: 413 })
    return row ? JSON.parse(row.payload_json) : undefined
  }

  allEvents(ownerId, runId, present = event => event, { maxBytes = Infinity, maxEvents = Infinity } = {}) {
    const events = []
    let sequence = 0
    let bytes = 0
    while (true) {
      const page = this.eventsAfter(ownerId, runId, sequence, 1000, present)
      if (page.length === 0) return events
      for (const event of page) bytes += Buffer.byteLength(JSON.stringify(event))
      if (bytes > maxBytes || events.length + page.length > maxEvents)
        throw Object.assign(new Error('历史记录较大，请使用分段历史读取'), { status: 413, code: 'HISTORY_PAGE_REQUIRED' })
      events.push(...page)
      sequence = Number(page.at(-1)._id.split('-')[0])
    }
  }

  steeringEvents(ownerId, runId, through = Number.MAX_SAFE_INTEGER) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    const rows = this.db.prepare(`SELECT CASE WHEN length(CAST(payload_json AS BLOB)) <= 8388608
      THEN payload_json END AS payload_json FROM run_events WHERE run_id = ? AND seq <= ?
      AND json_extract(payload_json, '$.event') IN ('workbench_steering', 'workbench_steered') ORDER BY seq`)
      .iterate(runId, through)
    const events = []
    let bytes = 0
    for (const row of rows) {
      bytes += row.payload_json == null ? Infinity : Buffer.byteLength(row.payload_json)
      if (bytes > 8 * 1024 * 1024 || events.length >= 10000)
        throw Object.assign(new Error('任务转向记录超过读取大小限制'), { status: 413, code: 'RUN_METADATA_TOO_LARGE' })
      events.push(JSON.parse(row.payload_json))
    }
    return events
  }

  saveSubmission(ownerId, runId, content, retry = false) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    if (retry) this.db.prepare('DELETE FROM run_submissions WHERE run_id=?').run(runId)
    this.db.prepare('INSERT INTO run_submissions(run_id, content_json) VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING')
      .run(runId, JSON.stringify({ content, ticketId: randomUUID() }))
  }

  submissions(ownerId) {
    return this.db.prepare(`SELECT s.* FROM run_submissions s JOIN runs r ON r.id=s.run_id
      WHERE r.owner_id=? ORDER BY r.created_at,r.rowid`).all(ownerId)
      .map((row) => {
        const value = JSON.parse(row.content_json)
        return { runId: row.run_id, content: value.content, ticketId: value.ticketId, dispatched: Boolean(row.dispatched) }
      })
  }

  submission(ownerId, runId) {
    const row = this.db.prepare(`SELECT s.* FROM run_submissions s JOIN runs r ON r.id=s.run_id WHERE r.owner_id=? AND s.run_id=?`).get(ownerId, runId)
    if (!row) return undefined
    const value = JSON.parse(row.content_json)
    return { runId: row.run_id, content: value.content, ticketId: value.ticketId, dispatched: Boolean(row.dispatched) }
  }

  ensureTicketGeneration(ownerId, runId, generation) {
    const row = this.db.prepare(`SELECT s.content_json FROM run_submissions s JOIN runs r ON r.id=s.run_id WHERE r.owner_id=? AND r.id=?`).get(ownerId, runId)
    if (!row) return
    const value = JSON.parse(row.content_json)
    if (value.generation === generation) return
    // Rotation is only meaningful across a fenced host generation. The native
    // request id stays unchanged; admission identity belongs to this host.
    if (value.generation !== undefined) value.ticketId = randomUUID()
    value.generation = generation
    this.db.prepare('UPDATE run_submissions SET content_json=? WHERE run_id=?').run(JSON.stringify(value), runId)
  }

  rotateSubmissionTicket(ownerId, runId, generation) {
    const row = this.db.prepare(`SELECT s.content_json FROM run_submissions s JOIN runs r ON r.id=s.run_id WHERE r.owner_id=? AND r.id=?`).get(ownerId, runId)
    if (!row) return
    const value = JSON.parse(row.content_json)
    this.db.prepare('UPDATE run_submissions SET content_json=? WHERE run_id=?')
      .run(JSON.stringify({ ...value, generation, ticketId: randomUUID() }), runId)
  }

  dispatchSubmission(ownerId, runId) {
    if (!this.getRun(ownerId, runId)) throw notFound('任务不存在')
    this.db.prepare('UPDATE run_submissions SET dispatched=1 WHERE run_id=?').run(runId)
  }

  editSubmission(ownerId, runId, content) {
    const row = this.db.prepare(`SELECT s.content_json FROM run_submissions s JOIN runs r ON r.id=s.run_id
      WHERE r.owner_id=? AND r.id=? AND r.status='queued' AND s.dispatched=0`).get(ownerId, runId)
    if (!row) return false
    const value = JSON.parse(row.content_json)
    this.db.prepare('UPDATE run_submissions SET content_json=? WHERE run_id=?')
      .run(JSON.stringify({ ...value, content }), runId)
    return true
  }

  finishSubmission(ownerId, runId, access) {
    if (!this.getRun(ownerId, runId, access)) throw notFound('任务不存在')
    this.db.prepare('DELETE FROM run_submissions WHERE run_id=?').run(runId)
  }

  removeSubmission(runId) {
    this.db.prepare('DELETE FROM run_submissions WHERE run_id=?').run(runId)
  }

  transitionRun(ownerId, runId, status, error, now = Date.now(), access) {
    return this.transaction(() => this.transitionRunRecord(ownerId, runId, status, error, now, access))()
  }

  transitionRunRecord(ownerId, runId, status, error, now, access) {
    const before = this.getRun(ownerId, runId, access)
    if (!before) throw notFound('任务不存在')
    const result = this.db.prepare('UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
      .run(status, error ?? null, now, runId, ownerId)
    if (result.changes !== 1) throw notFound('任务不存在')
    if (TERMINAL.has(status) && !['completed', 'discarded', 'steered'].includes(status)
      && (before.turnNumber !== undefined || ['running', 'waiting_input', 'stopping'].includes(before.status)))
      this.requireRunFence(ownerId, runId, access)
    if (status === 'discarded' || status === 'steered') {
      const removed = this.getRun(ownerId, runId, access)
      this.db.prepare('UPDATE runs SET parent_run_id = ? WHERE owner_id = ? AND chat_id = ? AND parent_run_id = ?')
        .run(removed.parentRunId ?? null, ownerId, removed.chatId, runId)
    }
    return this.getRun(ownerId, runId, access)
  }

  requireRunFence(ownerId, runId, access) {
    if (!this.getRun(ownerId, runId, access)) throw notFound('任务不存在')
    this.db.prepare('INSERT INTO run_fences(run_id) VALUES (?) ON CONFLICT(run_id) DO UPDATE SET confirmed=0').run(runId)
  }

  pendingRunFences(ownerId, { includeDeleted = false } = {}) {
    return this.db.prepare(`SELECT r.* FROM runs r JOIN run_fences f ON r.id=f.run_id JOIN chats c ON c.id=r.chat_id
      WHERE r.owner_id=? AND f.confirmed=0 AND (? OR c.deleted_at IS NULL)`).all(ownerId, Number(includeDeleted)).map(decodeRun)
  }

  confirmRunFence(ownerId, runId, confirmation = { fenced: true, uncertain: false }, access) {
    if (!this.getRun(ownerId, runId, access)) throw notFound('任务不存在')
    const row = this.db.prepare('SELECT result_json FROM run_fences WHERE run_id=?').get(runId)
    const previous = parseNullable(row?.result_json)
    // Java/manager only fence platform tools. Native tools such as bash may
    // still have an unsettled dispatch when that remote fence returns.
    const nativePending = Boolean(this.db.prepare("SELECT 1 FROM tool_calls WHERE run_id=? AND status='started' LIMIT 1").get(runId))
    // A later successful cleanup cannot prove an earlier unknown side effect
    // did not commit. Preserve that uncertainty across retries and restarts.
    const result = { fenced: confirmation.fenced === true, uncertain: previous?.uncertain === true || confirmation.uncertain === true || nativePending }
    this.transaction(() => {
      this.db.prepare('UPDATE run_fences SET confirmed=1, result_json=? WHERE run_id=?').run(JSON.stringify(result), runId)
      if (JSON.stringify(previous) !== JSON.stringify(result)) this.appendEvent(ownerId, runId, {
        event: 'workbench_stop_confirmation', stop_confirmation: result,
        ...(result.uncertain ? { message: '任务已暂停，部分外部工具结果尚未确认，请先核对后再重试' } : {}),
      })
    })()
    return result
  }

  recoverInterrupted(now = Date.now(), nativeQueued = [], initialRunIds) {
    const recover = this.transaction(() => {
      const keep = new Set(nativeQueued)
      const initial = initialRunIds === undefined ? undefined : new Set(initialRunIds)
      const rows = this.db.prepare(`SELECT id, owner_id FROM runs
        WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered')
        AND id NOT IN (SELECT run_id FROM run_submissions WHERE dispatched=0)`).all()
        .filter(row => !keep.has(row.id) && (!initial || initial.has(row.id)))
      for (const row of rows) {
        this.transitionRun(row.owner_id, row.id, 'interrupted', '适配层进程重启，任务已中断', now)
        this.appendEvent(row.owner_id, row.id, { event: 'workbench_end', status: 'interrupted', error: '适配层进程重启，任务已中断' })
      }
      for (const runId of keep) this.db.prepare("UPDATE runs SET status='queued', error=NULL WHERE id=? AND status NOT IN ('discarded','steered','cancelled')").run(runId)
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
      ORDER BY CASE WHEN status='queued' THEN 1 ELSE 0 END,
        (SELECT MAX(turn_number) FROM run_turns WHERE run_id=runs.id) DESC, queue_order, created_at, id LIMIT 1`).get(sessionId, ...TERMINAL)
    return row ? decodeRun(row) : undefined
  }

  activeRun(ownerId, chatId) {
    const placeholders = [...TERMINAL].map(() => '?').join(', ')
    const row = this.db.prepare(`SELECT * FROM runs WHERE owner_id = ? AND chat_id = ?
      AND status NOT IN (${placeholders}) ORDER BY CASE WHEN status='queued' THEN 1 ELSE 0 END,
        (SELECT MAX(turn_number) FROM run_turns WHERE run_id=runs.id) DESC, queue_order, created_at, id LIMIT 1`)
      .get(ownerId, chatId, ...TERMINAL)
    return row ? decodeRun(row) : undefined
  }
}

function decodeChat(row) {
  return {
    id: row.id, ownerId: row.owner_id, sessionId: row.session_id, title: row.title, directory: row.directory ?? undefined,
    pinned: Boolean(row.pinned), favorited: Boolean(row.favorited), version: row.version, selection: JSON.parse(row.selection_json),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function decodeRun(row) {
  return {
    id: row.id, ownerId: row.owner_id, chatId: row.chat_id, sessionId: row.session_id,
    requestKey: row.request_key ?? undefined, query: row.query, attachments: JSON.parse(row.attachments_json), mcpTools: JSON.parse(row.mcp_tools_json), status: row.status,
    error: row.error ?? undefined, feedback: row.feedback ?? null, selection: JSON.parse(row.selection_json),
    stopConfirmation: parseNullable(row.stop_confirmation_json),
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
