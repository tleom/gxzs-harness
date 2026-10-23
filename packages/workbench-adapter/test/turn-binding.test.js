import { expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'

it('looks up absent and legacy turns without scanning other historical receipts', () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', sessionId: 'session', ownerId: 'owner', selection: {} })
    for (let i = 0; i < 20; i++) {
      db.createRun({ id: `run-${i}`, sessionId: 'session', chatId: 'chat', ownerId: 'owner', query: '', selection: {} })
      db.db.prepare('UPDATE runs SET turn_number=? WHERE id=?').run(i, `run-${i}`)
    }
    const queries = []
    const prepare = db.db.prepare.bind(db.db)
    db.db.prepare = sql => { queries.push(sql); return prepare(sql) }
    expect(db.runForTurn('session', 99)).toBeUndefined()
    expect(db.streamRunForTurn('session', 99)).toBeUndefined()
    expect(db.runForTurn('session', 12).id).toBe('run-12')
    expect(db.streamRunForTurn('session', 12).id).toBe('run-12')
    const fallbacks = queries.filter(sql => sql.includes('ORDER BY') && sql.includes('queue_order'))
    expect(fallbacks.length).toBeGreaterThan(0)
    for (const sql of fallbacks) {
      const plan = prepare('EXPLAIN QUERY PLAN ' + sql).all('session', 99).map(row => row.detail).join('\n')
      expect(plan).toContain('runs_session_turn (session_id=? AND turn_number=?)')
      expect(plan).not.toContain('SCAN r')
    }
  } finally { db.close() }
})

it.each(['message', 'native'])('replaying an existing %s binding does not rewrite the frozen history row', kind => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', sessionId: 'session', ownerId: 'owner', selection: {} })
    db.createRun({ id: 'run', sessionId: 'session', chatId: 'chat', ownerId: 'owner', query: '', selection: {}, mcpTools: [{ schema: 'x'.repeat(512 * 1024) }] })
    const bind = () => kind === 'message' ? db.bindRunMessage('session', 'run', 1, 'message') : db.bindNativeTurn(db.getRun('owner', 'run'), 1)
    bind()
    const before = db.db.prepare('SELECT total_changes() AS count').get().count
    expect(bind().id).toBe('run')
    expect(db.db.prepare('SELECT total_changes() AS count').get().count).toBe(before)
    // A durable start discovered after the binding still fills the missing cursor.
    db.observeTurnStart('session', 1, 8)
    bind()
    expect(db.getRun('owner', 'run').sourceStartSeq).toBe(8)
  } finally { db.close() }
})

it('uses the durable native binding while retaining legacy and excluded-receipt recovery', () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    for (const sessionId of ['session', 'other']) db.createChat({ id: sessionId, sessionId, ownerId: 'owner', selection: {} })
    for (const [id, sessionId] of [['legacy', 'session'], ['bound', 'session'], ['foreign', 'other']])
      db.createRun({ id, sessionId, chatId: sessionId, ownerId: 'owner', query: id, selection: {} })
    db.db.prepare('UPDATE runs SET turn_number=1 WHERE id=?').run('legacy')
    expect(db.runForTurn('session', 1).id).toBe('legacy')
    expect(db.streamRunForTurn('session', 1).id).toBe('legacy')
    db.bindRunMessage('session', 'bound', 2, 'message')
    expect(db.db.prepare('SELECT run_id FROM run_turns WHERE session_id=? AND turn_number=?').get('session', 2).run_id).toBe('bound')
    expect(db.streamRunForTurn('session', 2).id).toBe('bound')
    db.db.prepare('INSERT INTO run_turns VALUES (?, ?, ?)').run('session', 1, 'bound')
    db.db.prepare('INSERT INTO run_turns VALUES (?, ?, ?)').run('other', 1, 'foreign')
    expect(db.runForTurn('session', 1).id).toBe('bound')
    expect(db.streamRunForTurn('session', 1).id).toBe('bound')
    expect(db.runForTurn('other', 1).id).toBe('foreign')
    db.db.prepare("UPDATE runs SET status='steered' WHERE id='bound'").run()
    expect(db.runForTurn('session', 1).id).toBe('legacy')
    expect(db.streamRunForTurn('session', 1).id).toBe('legacy')
    db.db.prepare("UPDATE chats SET deleted_at=1 WHERE id='session'").run()
    expect(db.streamRunForTurn('session', 1)).toBeUndefined()
  } finally { db.close() }
})

it('rejects a turn binding whose run belongs to another native session', () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', sessionId: 'other', ownerId: 'owner', selection: {} })
    db.createRun({ id: 'run', sessionId: 'other', chatId: 'chat', ownerId: 'owner', query: '', selection: {} })
    db.db.prepare('INSERT INTO run_turns VALUES (?, ?, ?)').run('session', 1, 'run')
    expect(db.runForTurn('session', 1)).toBeUndefined()
    expect(db.streamRunForTurn('session', 1)).toBeUndefined()
  } finally { db.close() }
})

it.each([
  ['message', 'steered'], ['message', 'discarded'],
  ['native', 'steered'], ['native', 'discarded'],
])('%s binding replaces an excluded %s receipt and preserves a valid turn owner', (kind, status) => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', sessionId: 'session', ownerId: 'owner', selection: {} })
    for (const id of ['previous', 'replacement', 'later'])
      db.createRun({ id, sessionId: 'session', chatId: 'chat', ownerId: 'owner', query: '', selection: {} })
    const bind = (id) => kind === 'message' ? db.bindRunMessage('session', id, 1, id + '-message') : db.bindNativeTurn(db.getRun('owner', id), 1)
    bind('previous')
    db.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, 'previous')
    bind('replacement')
    expect(db.db.prepare('SELECT run_id FROM run_turns WHERE session_id=? AND turn_number=?').get('session', 1).run_id).toBe('replacement')
    expect(db.runForTurn('session', 1).id).toBe('replacement')
    expect(db.streamRunForTurn('session', 1).id).toBe('replacement')
    bind('later')
    expect(db.db.prepare('SELECT run_id FROM run_turns WHERE session_id=? AND turn_number=?').get('session', 1).run_id).toBe('replacement')
    expect(db.runForTurn('session', 1).id).toBe('replacement')
    expect(db.getRun('owner', 'previous').status).toBe(status)
  } finally { db.close() }
})
