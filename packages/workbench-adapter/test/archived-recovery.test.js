import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { reconcileNativeSessions } from '../src/projection.js'

const opened = []
afterEach(() => opened.splice(0).forEach(database => database.close()))
function fixture(status = 'failed') {
  const database = new WorkbenchDatabase(':memory:'); opened.push(database)
  const owner = 'owner'
  const chat = database.createChat({ ownerId: owner, sessionId: 'archived', selection: {} })
  const run = database.createRun({ ownerId: owner, chatId: chat.id, sessionId: chat.sessionId,
    query: 'original task', selection: {} }).run
  database.transitionRun(owner, run.id, status)
  const error = Object.assign(new Error('invalid native tool result'), { code: 'SESSION_QUERY_CORRUPT_SESSION' })
  const query = { observeSession: vi.fn(async () => { throw error }) }
  return { database, owner, chat, run, error, query }
}

it.each(['completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered'])(
  'isolates a corrupt directly archived %s task while recovering healthy history once', async status => {
    const test = fixture(status)
    const healthy = test.database.createChat({ ownerId: test.owner, sessionId: 'healthy', selection: {} })
    const message = { id: 'healthy-schedule', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'timer' }] }
    const dispose = vi.fn()
    test.query.observeSession.mockImplementation(async id => {
      if (id === test.chat.sessionId) throw test.error
      return { events: [
        { type: 'turn/start', seq: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 2, data: message },
        { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      ], [Symbol.dispose]: dispose }
    })
    const original = test.database.getRun(test.owner, test.run.id)
    for (let attempt = 0; attempt < 2; attempt++)
      await reconcileNativeSessions(test.database, test.query, test.owner, undefined, undefined, () => [test.chat.sessionId])
    expect(test.database.getRun(test.owner, test.run.id)).toEqual(original)
    expect(test.database.listRuns(test.owner, test.chat.id)).toHaveLength(1)
    expect(test.database.listRuns(test.owner, healthy.id)).toHaveLength(1)
    expect(test.database.getRun(test.owner, message.id).status).toBe('completed')
    expect(test.database.allEvents(test.owner, message.id).filter(event => event.event === 'workbench_end')).toHaveLength(1)
    expect(dispose).toHaveBeenCalledTimes(2)
  })

it.each(['queued', 'running', 'waiting_input', 'stopping'])('does not isolate an archive with %s work', async status => {
  const test = fixture(status)
  await expect(reconcileNativeSessions(test.database, test.query, test.owner, undefined, undefined,
    () => [test.chat.sessionId])).rejects.toBe(test.error)
  expect(test.database.getRun(test.owner, test.run.id).status).toBe(status)
})

it.each([undefined, 'SESSION_QUERY_STORAGE_UNAVAILABLE', 'SESSION_QUERY_SESSION_NOT_READY'])(
  'does not hide other archive read failures (%s)', async code => {
    const test = fixture(); test.error.code = code
    await expect(reconcileNativeSessions(test.database, test.query, test.owner, undefined, undefined,
      () => [test.chat.sessionId])).rejects.toBe(test.error)
  })

it('does not isolate an unarchived session or infer archival from its parent', async () => {
  const test = fixture()
  for (const archive of [undefined, () => ['parent-session']])
    await expect(reconcileNativeSessions(test.database, test.query, test.owner, undefined, undefined, archive)).rejects.toBe(test.error)
})

it('rechecks archival and unfinished work after a suspended native history read', async () => {
  const test = fixture()
  for (const change of ['unarchive', 'new-run']) {
    let reject, archived = [test.chat.sessionId]
    test.query.observeSession.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    const recovering = reconcileNativeSessions(test.database, test.query, test.owner, undefined, undefined, () => archived)
    if (change === 'unarchive') archived = []
    else test.database.createRun({ ownerId: test.owner, chatId: test.chat.id, sessionId: test.chat.sessionId, query: 'new work', selection: {} })
    reject(test.error)
    await expect(recovering).rejects.toBe(test.error)
  }
})
