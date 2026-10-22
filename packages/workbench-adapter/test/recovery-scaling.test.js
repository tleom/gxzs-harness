import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { WorkbenchDatabase } from '../src/persistence.js'
import { reconcileNativeSessions } from '../src/projection.js'

it.each([100, 250])('recovers %s messages without loading complete run inventories', async count => {
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
    expect(calls).toBe(0)
    expect(decoded).toBe(0)
    expect(receiptReads).toBeLessThanOrEqual(count)
    expect(original(ownerId, chatId).every(run => run.status === 'completed')).toBe(true)
  } finally { database.close() }
})

it('keeps large historical resource snapshots out of the recovery heap and preserves them on disk', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { WorkbenchDatabase } from ${JSON.stringify(new URL('../src/persistence.js', import.meta.url).href)};
    import { reconcileNativeSessions } from ${JSON.stringify(new URL('../src/projection.js', import.meta.url).href)};
    const database = new WorkbenchDatabase(':memory:');
    try {
      const owner = 'owner', chat = 'chat', session = 'session';
      database.createChat({ id: chat, ownerId: owner, sessionId: session, selection: {} });
      const snapshot = JSON.stringify([{ description: 'x'.repeat(512 * 1024) }]);
      for (let i = 0; i < 200; i++) {
        database.createRun({ id: 'run-' + i, ownerId: owner, chatId: chat, sessionId: session, query: 'preserved', selection: {} });
        database.transitionRun(owner, 'run-' + i, 'completed');
      }
      database.db.prepare('UPDATE runs SET mcp_tools_json=?').run(snapshot);
      database.db.prepare('UPDATE runs SET message_id=? WHERE id=?').run('pending-message', 'run-199');
      const refs = database.listRunReferences(owner, chat);
      assert.equal(refs.length, 200);
      assert.equal(refs[199].messageId, 'pending-message');
      assert.equal(refs[0].messageId, null);
      assert.deepEqual(database.listRunReferences('foreign', chat), []);
      assert.deepEqual(database.listRunReferences(owner, 'foreign'), []);
      const events = [{ seq: 1, type: 'agent/inbox/spliced', data: {
        target: 'next-turn', start: 0, removedCount: 0,
        inserted: [{ id: 'pending-message', source: { kind: 'user' }, role: 'user', content: [] }],
      } }];
      const queued = await reconcileNativeSessions(database, { observeSession: async () => ({ events }) }, owner);
      assert.deepEqual(queued, ['run-199']);
      assert.equal(database.getRun(owner, 'run-199').status, 'queued');
      assert.equal(database.getRun(owner, 'run-0').mcpTools[0].description.length, 512 * 1024);
      assert.equal(database.db.prepare('SELECT count(*) AS n FROM runs WHERE mcp_tools_json=?').get(snapshot).n, 200);
      global.gc();
      console.log(JSON.stringify({ completed: true, heapUsed: process.memoryUsage().heapUsed }));
    } finally { database.close(); }
  `
  const child = spawnSync(process.execPath, ['--max-old-space-size=96', '--expose-gc', '--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  })
  expect(child.status, child.stderr).toBe(0)
  expect(JSON.parse(child.stdout)).toMatchObject({ completed: true })
  expect(JSON.parse(child.stdout).heapUsed).toBeLessThan(40 * 1024 * 1024)
}, 35000)
