import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'

const opened = []
const temporaryDirectories = []
const open = () => {
  const database = new WorkbenchDatabase(':memory:')
  opened.push(database)
  return database
}
afterEach(() => {
  opened.splice(0).forEach((database) => database.close())
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function seed(database, ownerId = 'user-a') {
  const chat = database.createChat({ ownerId, sessionId: `session-${ownerId}`, selection: { model: 'p/m' }, now: 1 })
  return { chat, ownerId }
}

describe('workbench durable projection', () => {
  it('resolves consumed steering through native turn bindings with owner and chat isolation', () => {
    const database = open(), { chat, ownerId } = seed(database)
    const create = (id, target = chat, owner = ownerId) => database.createRun({ id, ownerId: owner,
      chatId: target.id, sessionId: target.sessionId, query: id, attachments: [{ name: id }], selection: {}, now: 1 }).run
    const original = create('original'), resumed = create('resumed'), first = create('first'), later = create('later')
    database.bindRunMessage(chat.sessionId, original.id, 1, 'original-message')
    database.bindRunMessage(chat.sessionId, resumed.id, 2, 'resume-message')
    database.bindNativeTurn(resumed, 3)
    for (const [message, turn] of [[first, 2], [later, 3]]) {
      database.transitionRun(ownerId, message.id, 'steered')
      database.bindRunMessage(chat.sessionId, message.id, turn, message.id)
    }
    const pending = create('pending')
    database.transitionRun(ownerId, pending.id, 'steered')
    const otherChat = database.createChat({ ownerId, sessionId: 'other-session', selection: {} })
    const other = create('other', otherChat)
    database.transitionRun(ownerId, other.id, 'steered')
    database.bindRunMessage(otherChat.sessionId, other.id, 2, 'other-message')
    const prepare = database.db.prepare.bind(database.db)
    let query
    database.db.prepare = sql => { if (sql.startsWith('SELECT m.* FROM runs r')) query = sql; return prepare(sql) }
    expect(database.consumedSteeringRuns(ownerId, original.id)).toEqual([])
    expect(database.consumedSteeringRuns(ownerId, resumed.id).map(run => [run.id, run.turnNumber, run.attachments]))
      .toEqual([['first', 2, [{ name: 'first' }]], ['later', 3, [{ name: 'later' }]]])
    expect(prepare('EXPLAIN QUERY PLAN ' + query).all(resumed.id, ownerId).map(row => row.detail).join('\n'))
      .toContain('runs_session_turn (session_id=? AND turn_number=?)')
    expect(() => database.consumedSteeringRuns('foreign', resumed.id)).toThrow('任务不存在')
    database.db.prepare('UPDATE chats SET deleted_at=1 WHERE id=?').run(chat.id)
    expect(() => database.consumedSteeringRuns(ownerId, resumed.id)).toThrow('任务不存在')
  })

  it('uses active and chronological indexes for chat summaries without sorting frozen catalogs', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    for (const id of ['settled', 'queued', 'running']) {
      database.createRun({ id, ownerId, chatId: chat.id, sessionId: chat.sessionId, query: id, selection: {}, now: 1 })
    }
    database.transitionRun(ownerId, 'settled', 'completed')
    database.transitionRun(ownerId, 'running', 'running')
    const prepare = database.db.prepare.bind(database.db), queries = []
    database.db.prepare = sql => { queries.push(sql); return prepare(sql) }
    expect(database.activeRun(ownerId, chat.id)?.id).toBe('running')
    expect(database.activeRunBySession(chat.sessionId)?.id).toBe('running')
    expect(database.latestRunStatus(ownerId, chat.id)).toBe('running')
    expect(database.activeRun('foreign', chat.id)).toBeUndefined()
    const chatSql = queries.find(sql => sql.startsWith('SELECT id FROM runs INDEXED BY runs_active_queue'))
    const sessionSql = queries.find(sql => sql.startsWith('SELECT id, owner_id FROM runs WHERE session_id'))
    expect(prepare('EXPLAIN QUERY PLAN ' + chatSql).all(ownerId, chat.id).map(r => r.detail).join('\n')).toContain('runs_active_queue')
    expect(prepare('EXPLAIN QUERY PLAN ' + sessionSql).all(chat.sessionId).map(r => r.detail).join('\n')).toContain('runs_active_session')
    const latest = queries.find(sql => sql.startsWith('SELECT status FROM runs'))
    const plan = prepare('EXPLAIN QUERY PLAN ' + latest).all(ownerId, chat.id).map(r => r.detail).join('\n')
    expect(plan).toContain('runs_owner_chat_created')
    expect(plan).not.toContain('TEMP B-TREE')
  })

  it('assigns queue order from active receipts without scanning settled tool snapshots', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const create = id => database.createRun({ id, ownerId, chatId: chat.id, sessionId: chat.sessionId, query: id, selection: {} }).run
    create('settled')
    database.db.prepare("UPDATE runs SET status='completed',queue_order=999,mcp_tools_json=?").run(JSON.stringify([{ schema: 'x'.repeat(1024 * 1024) }]))
    expect(create('first').queueOrder).toBe(1)
    database.transitionRun(ownerId, 'first', 'running')
    const queries = []
    const prepare = database.db.prepare.bind(database.db)
    database.db.prepare = sql => { queries.push(sql); return prepare(sql) }
    expect(create('second').queueOrder).toBe(2)
    const query = queries.find(sql => sql.includes('MAX(queue_order)'))
    const plan = prepare('EXPLAIN QUERY PLAN ' + query).all(chat.id).map(row => row.detail).join('\n')
    expect(plan).toContain('runs_active_queue')
    expect(database.getRun(ownerId, 'settled').mcpTools[0].schema).toHaveLength(1024 * 1024)
  })

  it('reads pending notification metadata through a covering index and acknowledges without rewriting frozen resources', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const selection = { schedule_notification_pending: true, schedule_occurrences: [{ jobId: 'task', occurrenceAt: 123 }], model: 'p/m' }
    for (const id of ['pending', 'older', 'settled']) {
      database.createRun({ id, ownerId, chatId: chat.id, sessionId: chat.sessionId, query: id,
        selection: id === 'settled' ? {} : selection, now: id === 'older' ? 1 : 2 })
    }
    const frozen = '[\n  { "description": "' + 'x'.repeat(1024 * 1024) + '" }\n]'
    database.db.prepare('UPDATE runs SET mcp_tools_json=?').run(frozen)
    const queries = []
    const prepare = database.db.prepare.bind(database.db)
    database.db.prepare = sql => { queries.push(sql); return prepare(sql) }
    expect(database.pendingScheduleNotifications(ownerId).map(run => run.id)).toEqual(['older', 'pending'])
    expect(database.pendingScheduleNotifications('foreign')).toEqual([])
    const sql = queries.find(sql => sql.includes('ORDER BY r.created_at,r.id'))
    const plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(ownerId).map(row => row.detail).join('\n')
    expect(plan).toContain('COVERING INDEX runs_pending_notifications')
    expect(plan).not.toContain('TEMP B-TREE')
    database.acknowledgeScheduleNotification('foreign', 'pending')
    expect(database.pendingScheduleNotifications(ownerId)).toHaveLength(2)
    database.acknowledgeScheduleNotification(ownerId, 'pending')
    expect(database.getRun(ownerId, 'pending').selection).toEqual({ ...selection, schedule_notification_pending: false })
    const before = prepare('SELECT total_changes() AS n').get().n
    database.acknowledgeScheduleNotification(ownerId, 'pending')
    expect(prepare('SELECT total_changes() AS n').get().n).toBe(before)
    expect(prepare('SELECT COUNT(*) AS n FROM runs WHERE mcp_tools_json=?').get(frozen).n).toBe(3)
    database.db.prepare('UPDATE chats SET deleted_at=1 WHERE id=?').run(chat.id)
    database.acknowledgeScheduleNotification(ownerId, 'older')
    expect(JSON.parse(prepare('SELECT selection_json FROM runs WHERE id=?').get('older').selection_json)).toEqual(selection)
    expect(database.pendingScheduleNotifications(ownerId)).toEqual([])
  })

  it('indexes state metadata without scanning unrelated history payloads', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const { run } = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {}, now: 2 })
    database.appendEvent(ownerId, run.id, { event: 'workbench_status', status: 'running' }, 1000)
    database.appendEvent(ownerId, run.id, { event: 'workbench_context', used_tokens: 7 }, 1100)
    for (let i = 0; i < 64; i++) database.appendEvent(ownerId, run.id, { event: 'text', text: 'x'.repeat(128 * 1024) }, 1200 + i)
    database.appendEvent(ownerId, run.id, { event: 'workbench_end' }, 2000)
    database.transitionRun(ownerId, run.id, 'running')
    database.transitionRun(ownerId, run.id, 'completed')
    const queries = []
    const prepare = database.db.prepare.bind(database.db)
    database.db.prepare = sql => { queries.push(sql); return prepare(sql) }
    expect(database.runTiming(ownerId, run.id)).toEqual({ started_at: 1, completed_at: 2, elapsed_seconds: 1 })
    expect(database.latestContextEvent(ownerId, run.id)).toMatchObject({ used_tokens: 7 })
    expect(database.steeringEvents(ownerId, run.id)).toEqual([])
    database.db.prepare = prepare
    const indexes = []
    for (const sql of queries.filter(sql => sql.includes('json_extract'))) {
      const params = sql.startsWith('WITH endings') ? [run.id, run.id, run.id] : sql.includes('seq <= ?') ? [run.id, Number.MAX_SAFE_INTEGER] : [run.id]
      indexes.push(...prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail))
    }
    for (const name of ['run_events_end', 'run_events_started', 'run_events_context', 'run_events_steering'])
      expect(indexes.some(detail => detail.includes(name)), indexes.join('\n')).toBe(true)
  })
  it('keeps inherited-history markers on copied rows only, never on new goal or child runs', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const selection = { model: 'p/m', fork_source: { sessionId: 'original', endSeq: 9 }, command: 'goal' }
    for (const native_child of [undefined, 'new-child']) {
      const { run } = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId,
        query: 'new work', selection: { ...selection, native_child } })
      expect(run.selection.fork_source).toBeUndefined()
      expect(run.selection).toMatchObject({ model: 'p/m', command: 'goal' })
    }
    expect(selection.fork_source).toEqual({ sessionId: 'original', endSeq: 9 })
  })

  it('returns the newest question when consecutive inputs share the same millisecond', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const { run } = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {}, now: 2 })
    database.createPendingInput(ownerId, run.id, { requestId: 'old', payload: { tool_name: 'ask_user_question' } }, 100)
    database.settlePendingInput(ownerId, run.id, 'old', 'skipped', undefined, 100)
    database.createPendingInput(ownerId, run.id, { requestId: 'new', payload: { tool_name: 'ask_user_question' } }, 100)
    expect(database.getPendingInput(ownerId, run.id)).toMatchObject({ requestId: 'new', status: 'pending' })
    expect(database.listPendingInputs(ownerId, run.id).map(input => input.requestId)).toEqual(['old', 'new'])
    database.settlePendingInput(ownerId, run.id, 'new', 'submitted', { answers: [] }, 101)
    expect(database.getPendingInput(ownerId, run.id)).toMatchObject({ requestId: 'new', status: 'submitted' })
  })

  it('isolates chats and runs by owner', () => {
    const database = open()
    const { chat } = seed(database)
    const { run } = database.createRun({ ownerId: 'user-a', chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {}, now: 2 })
    expect(database.getChat('user-b', chat.id)).toBeUndefined()
    expect(database.getRun('user-b', run.id)).toBeUndefined()
    expect(database.getRunState('user-b', run.id)).toBeUndefined()
    expect(() => database.eventsAfter('user-b', run.id, 0)).toThrow('任务不存在')
  })

  it('flushes accepted text before returning the current stream cursor and status', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const { run } = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
    database.appendStreamEvent(ownerId, run.id, { event: 'text', text: 'accepted tail' }, 1, 1)
    expect(database.getRunState(ownerId, run.id)).toEqual({ id: run.id, status: 'queued', seq: 1 })
    expect(database.eventsAfter(ownerId, run.id, 0)).toEqual([{ event: 'text', text: 'accepted tail', _id: '1-0' }])
    database.transitionRun(ownerId, run.id, 'waiting_input')
    expect(database.getRunState(ownerId, run.id)).toEqual({ id: run.id, status: 'waiting_input', seq: 1 })
  })

  it('allocates monotonic event cursors transactionally', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const { run } = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {}, now: 2 })
    expect(database.appendEvent(ownerId, run.id, { event: 'one' }, 3)._id).toBe('1-0')
    expect(database.appendEvent(ownerId, run.id, { event: 'two' }, 4)._id).toBe('2-0')
    expect(database.eventsAfter(ownerId, run.id, 1)).toEqual([{ event: 'two', _id: '2-0' }])
  })

  it('deduplicates request keys and keeps FIFO active runs', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const first = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'first', selection: {}, requestKey: 'same', now: 2 })
    const replay = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'ignored', selection: {}, requestKey: 'same', now: 3 })
    const second = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'second', selection: {}, requestKey: 'other', now: 4 })
    expect(first.created).toBe(true)
    expect(replay).toMatchObject({ created: false, run: { id: first.run.id } })
    expect(database.activeRun(ownerId, chat.id)?.id).toBe(first.run.id)
    database.transitionRun(ownerId, first.run.id, 'completed', undefined, 5)
    expect(database.activeRun(ownerId, chat.id)?.id).toBe(second.run.id)
  })

  it('marks live runs interrupted after a real database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gxzs-harness-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'workbench.sqlite3')
    const first = new WorkbenchDatabase(filename)
    const { chat, ownerId } = seed(first)
    const { run } = first.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {}, now: 2 })
    first.transitionRun(ownerId, run.id, 'running', undefined, 3)
    first.requireRunFence(ownerId, run.id)
    first.confirmRunFence(ownerId, run.id, { fenced: true, uncertain: true })
    first.requireRunFence(ownerId, run.id)
    first.close()

    const reopened = new WorkbenchDatabase(filename)
    opened.push(reopened)
    expect(reopened.pendingRunFences(ownerId).map(value => value.id)).toEqual([run.id])
    expect(reopened.getRun(ownerId, run.id).stopConfirmation).toEqual({ fenced: true, uncertain: true })
    expect(reopened.recoverInterrupted(4)).toEqual([{ id: run.id, owner_id: ownerId }])
    expect(reopened.getRun(ownerId, run.id)).toMatchObject({ status: 'interrupted', error: '适配层进程重启，任务已中断' })
    expect(reopened.pendingRunFences(ownerId).map(value => value.id)).toEqual([run.id])
    reopened.confirmRunFence(ownerId, run.id)
    expect(reopened.pendingRunFences(ownerId)).toEqual([])
  })

  it('does not rewrite followup terminal states during recovery', () => {
    const database = open()
    const { chat, ownerId } = seed(database)
    const { run } = database.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {}, now: 2 })
    database.transitionRun(ownerId, run.id, 'steered', undefined, 3)
    database.recoverInterrupted(4)
    expect(database.getRun(ownerId, run.id)?.status).toBe('steered')
  })

  it('keeps event cursors unique across concurrent database connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gxzs-harness-'))
    temporaryDirectories.push(directory)
    const filename = join(directory, 'workbench.sqlite3')
    const first = new WorkbenchDatabase(filename)
    const second = new WorkbenchDatabase(filename)
    opened.push(first, second)
    const { chat, ownerId } = seed(first)
    const { run } = first.createRun({ ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {}, now: 2 })
    expect(first.appendEvent(ownerId, run.id, { event: 'one' }, 3)._id).toBe('1-0')
    expect(second.appendEvent(ownerId, run.id, { event: 'two' }, 4)._id).toBe('2-0')
    expect(first.eventsAfter(ownerId, run.id, 0).map((event) => event._id)).toEqual(['1-0', '2-0'])
  })
})

it('uses completion receipt time for conversation recency instead of later feedback or configuration edits', () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    const chat = db.createChat({ ownerId: 'owner', sessionId: 'session', selection: {} })
    const { run } = db.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: 'session', selection: {}, query: 'schedule' })
    db.transitionRun('owner', run.id, 'completed', undefined, 200)
    db.appendEvent('owner', run.id, { event: 'workbench_end', status: 'completed' }, 200)
    db.setFeedback('owner', run.id, 'like', 900)
    expect(db.chatCompletions('owner').get('session')).toEqual({ id: run.id, status: 'completed', at: 200 })
    expect(db.chatCompletions('other').size).toBe(0)
  } finally { db.close() }
})

it('orders completion by its native receipt even when a newer queued run cancelled first', () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    const chat = db.createChat({ ownerId: 'owner', sessionId: 'session', selection: {} })
    const create = now => db.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: chat.sessionId, query: 'task', selection: {}, now }).run
    const first = create(10)
    const newer = create(20)
    db.transitionRun('owner', first.id, 'running', undefined, 30)
    db.transitionRun('owner', newer.id, 'cancelled', undefined, 100)
    db.appendEvent('owner', newer.id, { event: 'workbench_end', status: 'cancelled', occurred_at: 100 }, 500)
    expect(db.chatCompletions('owner').get('session').id).toBe(newer.id)
    db.transitionRun('owner', first.id, 'completed', undefined, 200)
    db.appendEvent('owner', first.id, { event: 'workbench_end', status: 'completed', occurred_at: 200 }, 600)
    db.setFeedback('owner', newer.id, 'like', 900)
    expect(db.chatCompletions('owner').get('session')).toEqual({ id: first.id, status: 'completed', at: 200 })
    // An old cache without a terminal event has no reliable completion time.
    const legacy = create(40)
    db.transitionRun('owner', legacy.id, 'completed', undefined, 999)
    db.setFeedback('owner', legacy.id, 'like', 1000)
    expect(db.chatCompletions('owner').get('session').id).toBe(first.id)
  } finally { db.close() }
})
