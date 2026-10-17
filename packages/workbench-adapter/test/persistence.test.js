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
    expect(() => database.eventsAfter('user-b', run.id, 0)).toThrow('任务不存在')
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
