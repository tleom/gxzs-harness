import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { WorkbenchDatabase } from '../src/persistence.js'
import { reconcileNativeSessions } from '../src/projection.js'

it.each([
  ['user', 'missing'], ['user', 'steered'], ['user', 'discarded'],
  ['schedule', 'missing'], ['schedule', 'steered'], ['schedule', 'discarded'],
])('repairs the durable binding of a settled %s receipt after startup (%s)', async (kind, retiredStatus) => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    const ownerId = 'owner', sessionId = 'session', chatId = 'chat', id = 'valid'
    db.createChat({ id: chatId, ownerId, sessionId, selection: {} })
    db.createRun({ id: 'retired', ownerId, sessionId, chatId, query: 'retired', selection: {} })
    db.createRun({ id, ownerId, sessionId, chatId, query: 'preserved', selection: {},
      requestKey: kind === 'schedule' ? `schedule:${id}` : undefined,
      mcpTools: [{ schema: 'x'.repeat(512 * 1024) }] })
    db.bindRunMessage(sessionId, id, 1, id)
    db.setRunSourceSeq(ownerId, id, 'source_start_seq', 1)
    db.setRunSourceSeq(ownerId, id, 'source_end_seq', 3)
    db.transitionRun(ownerId, id, 'completed')
    if (retiredStatus === 'missing') db.db.prepare('DELETE FROM run_turns').run()
    else {
      db.db.prepare('UPDATE runs SET status=? WHERE id=?').run(retiredStatus, 'retired')
      db.db.prepare('UPDATE run_turns SET run_id=?').run('retired')
    }
    const events = [
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, type: 'user/message', data: { id, source: { kind, rpcId: id }, content: [] } },
      { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    for (const event of events) db.markProjectedEvent(sessionId, event.seq)
    db.migrate()
    const binding = () => db.db.prepare('SELECT run_id FROM run_turns WHERE session_id=? AND turn_number=1').get(sessionId)?.run_id
    expect(binding()).toBe(retiredStatus === 'missing' ? id : 'retired')
    const expected = db.getRun(ownerId, id)
    for (let replay = 0; replay < 2; replay++) {
      expect(await reconcileNativeSessions(db, { observeSession: async () => ({ events }) }, ownerId)).toEqual([])
      expect(binding()).toBe(id)
      expect(db.getRun(ownerId, id)).toMatchObject({ status: 'completed', sourceStartSeq: 1, sourceEndSeq: 3,
        mcpTools: expected.mcpTools })
      expect(db.listRunReferences(ownerId, chatId)).toHaveLength(2)
      expect(db.db.prepare('SELECT COUNT(*) AS n FROM pending_turns').get().n).toBe(0)
    }
  } finally { db.close() }
})

it.each([false, true])('reuses settled schedule receipts while repairing missing completion cursors (%s)', missingEnd => {
  return (async () => {
    const db = new WorkbenchDatabase(':memory:')
    try {
      const ownerId = 'owner', sessionId = 'session', chatId = 'chat', id = 'scheduled-message'
      const message = { id, source: { kind: 'schedule' }, content: [{ type: 'text', text: 'schedule_id_json: "task"\noccurrence_at: 2026-10-23T01:00:00Z' }] }
      db.createChat({ id: chatId, ownerId, sessionId, selection: {} })
      db.createRun({ id, ownerId, sessionId, chatId, requestKey: `schedule:${id}`, query: message.content[0].text,
        selection: { schedule_notification_pending: true }, mcpTools: [{ schema: 'x'.repeat(512 * 1024) }] })
      db.bindRunMessage(sessionId, id, 1, id)
      db.setRunSourceSeq(ownerId, id, 'source_start_seq', 3)
      if (!missingEnd) db.setRunSourceSeq(ownerId, id, 'source_end_seq', 6)
      db.transitionRun(ownerId, id, 'completed')
      db.observeTurnStart(sessionId, 1, 3)
      const events = [
        { seq: 1, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } },
        { seq: 2, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
        { seq: 3, type: 'turn/start', data: { turn: 1 } },
        { seq: 4, type: 'user/message', data: message },
        { seq: 5, type: 'assistant/message', data: { turn: 1, step: 1, content: [] } },
        { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      for (const event of events) db.markProjectedEvent(sessionId, event.seq)
      let receipts = 0
      for (const name of ['getRun', 'createRun', 'runForTurn']) {
        const original = db[name].bind(db)
        db[name] = (...args) => { receipts++; return original(...args) }
      }
      expect(await reconcileNativeSessions(db, { observeSession: async () => ({ events }) }, ownerId)).toEqual([])
      if (missingEnd) expect(receipts).toBeGreaterThan(0)
      else expect(receipts).toBe(0)
      expect(db.getRun(ownerId, id)).toMatchObject({ status: 'completed', sourceStartSeq: 3, sourceEndSeq: 6,
        selection: { schedule_notification_pending: true } })
      expect(db.getRun(ownerId, id).mcpTools[0].schema).toHaveLength(512 * 1024)
      expect(db.listRunReferences(ownerId, chatId)).toHaveLength(1)
      expect(db.db.prepare('SELECT COUNT(*) AS n FROM pending_turns').get().n).toBe(0)
    } finally { db.close() }
  })()
})

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
    let heartbeat, heartbeats = 0, replaying = true, disposed = false
    const pulse = () => { heartbeats++; if (replaying) heartbeat = setImmediate(pulse) }
    heartbeat = setImmediate(pulse)
    try {
      await reconcileNativeSessions(database, { observeSession: async () => ({ events, [Symbol.dispose]() { disposed = true } }) }, ownerId)
    } finally { replaying = false; clearImmediate(heartbeat) }
    expect(heartbeats).toBeGreaterThan(1)
    expect(disposed).toBe(true)
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
    import { WorkbenchService } from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)};
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
      database.db.prepare('UPDATE runs SET source_start_seq=2 WHERE id=?').run('run-0');
      database.db.prepare('UPDATE runs SET selection_json=?,created_at=1 WHERE id IN (?,?)')
        .run(JSON.stringify({ subagent_ids: ['child'] }), 'run-197', 'run-198');
      database.requireRunFence(owner, 'run-198');
      database.confirmRunFence(owner, 'run-198');
      const refs = database.listRunReferences(owner, chat);
      assert.equal(refs.length, 200);
      assert.equal(refs.find(r => r.id === 'run-199').messageId, 'pending-message');
      assert.equal(refs.find(r => r.id === 'run-0').messageId, null);
      assert.deepEqual(database.listRunReferences('foreign', chat), []);
      assert.deepEqual(database.listRunReferences(owner, 'foreign'), []);
      assert.equal(database.runForSubagent(owner, chat, 'child').id, 'run-198');
      assert.equal(database.runForSubagent(owner, chat, 'child').stopConfirmation.fenced, true);
      assert.equal(database.runForSubagent('foreign', chat, 'child'), undefined);
      assert.equal(database.runForSubagent(owner, 'foreign', 'child'), undefined);
      const service = new WorkbenchService({ database, agents: new Map(), sessionQuery: { observeSession: async () => ({
        events: [{ seq: 1, type: 'command/run', data: { commandId: 'command', name: 'plan', args: '' } }],
      }) } });
      assert.equal(service.getChat({ ownerId: owner }, chat).runs.length, 200);
      const control = await service.getControl({ ownerId: owner }, chat);
      assert.equal(control.commands[0].before_run_id, 'run-0');
      const view = service.historyPageView({ ownerId: owner }, database.getChat(owner, chat), { records: [], through_seq: 1000 }, true, true);
      assert.equal(view.runs.length, 199);
      assert.equal(view.runs.some(run => run.id === 'run-0'), false);
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
