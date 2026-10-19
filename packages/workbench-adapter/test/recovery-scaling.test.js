import { expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { reconcileNativeSessions } from '../src/projection.js'

it.each([100, 250])('decodes at most two run inventories when recovering %s messages', async count => {
  const database = new WorkbenchDatabase(':memory:')
  try {
    const ownerId = 'owner', sessionId = 'session', chatId = 'chat', events = []
    database.createChat({ id: chatId, ownerId, sessionId, selection: {} })
    database.transaction(() => {
      for (let i = 1; i <= count; i++) {
        const id = `run-${i}`, messageId = `message-${i}`
        database.createRun({ id, ownerId, chatId, sessionId, query: 'test', selection: {}, mcpTools: [{ schema: 'x'.repeat(1024) }] })
        database.bindRunMessage(sessionId, id, i, messageId)
        database.transitionRun(ownerId, id, 'completed')
        for (const event of [
          { seq: i * 4, type: 'turn/start', data: { turn: i } },
          { seq: i * 4 + 1, type: 'user/message', data: { id: messageId, source: { kind: 'rpc', rpcId: id }, content: [] } },
          { seq: i * 4 + 2, type: 'assistant/message', data: { turn: i, step: 1, content: [] } },
          { seq: i * 4 + 3, type: 'turn/end', data: { turn: i, reason: { kind: 'completed' } } },
        ]) { events.push(event); database.markProjectedEvent(sessionId, event.seq) }
        database.setRunSourceSeq(ownerId, id, 'source_end_seq', i * 4 + 3)
      }
    })()
    let calls = 0, decoded = 0
    const original = database.listRuns.bind(database)
    database.listRuns = (...args) => { calls++; const rows = original(...args); decoded += rows.length; return rows }
    let receiptReads = 0
    const receipt = database.runForTurn.bind(database)
    database.runForTurn = (...args) => { receiptReads++; return receipt(...args) }
    await reconcileNativeSessions(database, { observeSession: async () => ({ events, [Symbol.dispose]() {} }) }, ownerId)
    expect(calls).toBeLessThanOrEqual(2)
    expect(decoded).toBeLessThanOrEqual(count * 2)
    expect(receiptReads).toBeLessThanOrEqual(count)
    expect(original(ownerId, chatId).every(run => run.status === 'completed')).toBe(true)
  } finally { database.close() }
})
