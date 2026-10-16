import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { claimNeedsResources, projectInboxClaim, reconcileNativeSessions } from '../src/projection.js'

const opened = []
afterEach(() => opened.splice(0).forEach(database => database.close()))
function fixture() {
  const database = new WorkbenchDatabase(':memory:'); opened.push(database)
  const owner = 'owner'
  const chat = database.createChat({ ownerId: owner, sessionId: 'native', selection: { model: 'current/model' } })
  const message = { id: 'job-notice', source: { kind: 'tool-jobs', form: 'notice', summary: 'Background work settled' },
    content: [{ type: 'text', text: 'Native completion notice' }] }
  const resources = { mcpCatalogReady: true, mcpTools: [{ id: 'currently-permitted' }] }
  return { database, owner, chat, message, resources }
}

it('binds an idle owner notice using current resources without reviving an earlier cancelled run', () => {
  const test = fixture()
  const old = test.database.createRun({ ownerId: test.owner, chatId: test.chat.id, sessionId: test.chat.sessionId,
    query: 'previous work', selection: { model: 'old/model' }, mcpTools: [{ id: 'revoked' }] }).run
  test.database.bindNativeTurn(old, 1)
  test.database.transitionRun(test.owner, old.id, 'cancelled')
  const claim = () => projectInboxClaim(test.database, { agent: { id: test.chat.sessionId }, message: test.message, turn: 2 }, test.owner, test.resources)
  const run = claim()
  expect(run).toMatchObject({ id: test.message.id, messageId: test.message.id,
    selection: { model: 'current/model', native_source: 'tool-jobs', native_notice: true }, mcpTools: test.resources.mcpTools })
  expect(test.database.runForTurn(test.chat.sessionId, 2).id).toBe(run.id)
  expect(claim().id).toBe(run.id)
  expect(test.database.listRuns(test.owner, test.chat.id)).toHaveLength(2)
  expect(test.database.getRun(test.owner, old.id).status).toBe('cancelled')
})

it('consumes busy-owner notices in the existing turn without another submission or new permissions', () => {
  const test = fixture()
  const current = test.database.createRun({ ownerId: test.owner, chatId: test.chat.id, sessionId: test.chat.sessionId,
    query: 'working', selection: {}, mcpTools: [{ id: 'turn-permission' }] }).run
  test.database.bindNativeTurn(current, 1)
  const run = projectInboxClaim(test.database, { agent: { id: test.chat.sessionId }, message: test.message, turn: 1 }, test.owner, test.resources)
  expect(run.id).toBe(current.id)
  expect(run.mcpTools).toEqual(current.mcpTools)
  expect(test.database.listRuns(test.owner, test.chat.id)).toHaveLength(1)
  expect(test.database.submissions(test.owner)).toEqual([])
})

it('does not adopt a foreign owner or freeze a missing MCP catalog', () => {
  const test = fixture()
  const payload = { agent: { id: test.chat.sessionId }, message: test.message, turn: 1 }
  expect(projectInboxClaim(test.database, payload, 'foreign', test.resources)).toBeUndefined()
  expect(projectInboxClaim(test.database, payload, test.owner, { mcpCatalogReady: false })).toBeUndefined()
  expect(test.database.listRuns(test.owner, test.chat.id)).toEqual([])
  expect(projectInboxClaim(test.database, payload, test.owner, test.resources).mcpTools).toEqual(test.resources.mcpTools)
})

it('replays claimed native job notices once and preserves the original captured resources', async () => {
  const test = fixture()
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 2 } },
    { type: 'user/message', seq: 2, time: 1000, data: test.message }]
  const query = { observeSession: async () => ({ events, [Symbol.dispose]() {} }) }
  const unavailable = vi.fn(() => { throw new Error('catalog unavailable') })
  await expect(reconcileNativeSessions(test.database, query, test.owner, unavailable)).rejects.toThrow('catalog unavailable')
  expect(test.database.listRuns(test.owner, test.chat.id)).toEqual([])
  await reconcileNativeSessions(test.database, query, test.owner, () => test.resources)
  await reconcileNativeSessions(test.database, query, test.owner, unavailable)
  expect(unavailable).toHaveBeenCalledTimes(1)
  expect(test.database.listRuns(test.owner, test.chat.id)).toHaveLength(1)
  expect(test.database.runForTurn(test.chat.sessionId, 2)).toMatchObject({ id: test.message.id, mcpTools: test.resources.mcpTools })
})

it('recovers a pending native inbox notice without redelivering or editing the native message', async () => {
  const test = fixture()
  const events = [{ type: 'agent/inbox/spliced', seq: 1,
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [test.message] } }]
  const before = JSON.stringify(events)
  await reconcileNativeSessions(test.database, { observeSession: async () => ({ events }) }, test.owner, test.resources)
  expect(test.database.getRun(test.owner, test.message.id)).toMatchObject({ status: 'queued', messageId: test.message.id })
  expect(JSON.stringify(events)).toBe(before)
})

it.each(['agent-message', 'subagent-settled'])('freezes current permissions for a recovered queued %s before its live claim', async kind => {
  const test = fixture()
  const parent = test.database.createRun({ ownerId: test.owner, chatId: test.chat.id, sessionId: test.chat.sessionId,
    query: 'delegate', selection: { subagent_ids: ['owned-child'] }, mcpTools: [{ id: 'revoked' }] }).run
  test.database.transitionRun(test.owner, parent.id, 'completed')
  const message = { ...test.message, id: 'queued-child', source: { kind, senderSessionId: 'owned-child' } }
  const events = [{ type: 'agent/inbox/spliced', seq: 1,
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } }]
  const query = { observeSession: async () => ({ events }) }
  const unavailable = vi.fn(() => { throw new Error('catalog unavailable') })
  await expect(reconcileNativeSessions(test.database, query, test.owner, unavailable)).rejects.toThrow('catalog unavailable')
  expect(test.database.getRun(test.owner, message.id)).toBeUndefined()
  await reconcileNativeSessions(test.database, query, test.owner, () => test.resources)
  expect(test.database.getRun(test.owner, message.id)).toMatchObject({ status: 'queued', mcpTools: test.resources.mcpTools })
  const claimed = projectInboxClaim(test.database, { agent: { id: test.chat.sessionId }, message, turn: 2 }, test.owner,
    { mcpCatalogReady: true, mcpTools: [{ id: 'later-catalog' }] })
  expect(claimed.mcpTools).toEqual(test.resources.mcpTools)
  await reconcileNativeSessions(test.database, query, test.owner, unavailable)
  expect(unavailable).toHaveBeenCalledTimes(1)
  expect(test.database.listRuns(test.owner, test.chat.id)).toHaveLength(2)
})

it.each(['agent-message', 'subagent-settled'])('ignores unowned %s notices before reading unavailable resources during recovery', async kind => {
  const test = fixture()
  const foreign = test.database.createChat({ ownerId: 'other-owner', sessionId: 'foreign-root', selection: {} })
  test.database.createRun({ ownerId: foreign.ownerId, chatId: foreign.id, sessionId: foreign.sessionId,
    query: 'foreign delegate', selection: { subagent_ids: ['foreign-child'] } })
  const message = { ...test.message, id: 'foreign-child-notice', source: { kind, senderSessionId: 'foreign-child' } }
  const payload = { agent: { id: test.chat.sessionId }, message, turn: 1 }
  expect(claimNeedsResources(test.database, payload, test.owner)).toBe(false)
  const unavailable = vi.fn(() => { throw new Error('catalog unavailable') })
  for (const events of [
    [{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } }],
    [{ type: 'turn/start', seq: 2, data: { turn: 1 } }, { type: 'user/message', seq: 3, data: message }],
  ]) {
    await expect(reconcileNativeSessions(test.database, { observeSession: async () => ({ events }) }, test.owner, unavailable)).resolves.toEqual([])
  }
  expect(unavailable).not.toHaveBeenCalled()
  expect(test.database.listRuns(test.owner, test.chat.id)).toEqual([])
})
