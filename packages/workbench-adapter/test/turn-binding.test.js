import { expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'

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
