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
    first.close()

    const reopened = new WorkbenchDatabase(filename)
    opened.push(reopened)
    expect(reopened.recoverInterrupted(4)).toEqual([{ id: run.id, owner_id: ownerId }])
    expect(reopened.getRun(ownerId, run.id)).toMatchObject({ status: 'interrupted', error: '适配层进程重启，任务已中断' })
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
