import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.each(['history', 'sse'])('projects legacy context rows before retaining a %s page', mode => {
  const source = `
    import { WorkbenchDatabase } from ${JSON.stringify(new URL('../src/persistence.js', import.meta.url).href)};
    import { WorkbenchService } from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)};
    import { RunEventBus } from ${JSON.stringify(new URL('../src/events.js', import.meta.url).href)};
    import { streamRunEvents } from ${JSON.stringify(new URL('../src/sse.js', import.meta.url).href)};
    import { EventEmitter } from 'node:events';
    const database = new WorkbenchDatabase(':memory:');
    try {
      const owner = { ownerId: 'audit' };
      const chat = database.createChat({ ownerId: owner.ownerId, sessionId: 'native', selection: {} });
      const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id,
        sessionId: chat.sessionId, query: 'legacy history', selection: {} });
      const description = 'x'.repeat(512 * 1024);
      for (let index = 0; index < 200; index++) database.appendEvent(owner.ownerId, run.id, {
        event: 'workbench_context', phase: 'usage', used_tokens: index + 1,
        mcpTools: [{ inputSchema: { description } }], mcpCatalogReady: true,
      });
      global.gc();
      if (${JSON.stringify(mode)} === 'history') {
        const result = new WorkbenchService({ database }).getRun(owner, run.id, true);
        if (result.events.length !== 200 || JSON.stringify(result).length > 20000) throw new Error('invalid history');
        if (result.events.some((event, index) => event._id !== (index + 1) + '-0')) throw new Error('cursor changed');
      } else {
        database.transitionRun(owner.ownerId, run.id, 'completed');
        const res = new EventEmitter();
        let frames = 0, ended = false;
        res.writeHead = () => {};
        res.write = frame => { if (frame.length > 1024) throw new Error('large frame'); frames++; return true; };
        res.end = () => { ended = true; };
        const eventBus = new RunEventBus();
        streamRunEvents({ database, eventBus, ownerId: owner.ownerId, runId: run.id, cursor: '0-0', res });
        if (!ended || frames !== 200 || eventBus.listeners.size !== 0) throw new Error('invalid SSE lifecycle');
      }
      if (database.latestContextEvent(owner.ownerId, run.id).mcpTools[0].inputSchema.description !== description)
        throw new Error('durable source changed');
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

it.each(['pending', 'steering'])('bounds %s metadata before a state read can exhaust the Host', mode => {
  const source = `
    import { WorkbenchDatabase } from ${JSON.stringify(new URL('../src/persistence.js', import.meta.url).href)};
    import { WorkbenchService } from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)};
    import assert from 'node:assert/strict';
    const database = new WorkbenchDatabase(':memory:');
    try {
      const owner = { ownerId: 'audit' };
      const chat = database.createChat({ ownerId: owner.ownerId, sessionId: 'native', selection: {} });
      const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'metadata', selection: {} });
      database.transitionRun(owner.ownerId, run.id, 'running');
      const value = 'x'.repeat(512 * 1024);
      for (let i = 0; i < 200; i++) {
        if (${JSON.stringify(mode)} === 'pending') database.db.prepare(
          "INSERT INTO pending_inputs (request_id, run_id, payload_json, status, created_at) VALUES (?, ?, ?, 'submitted', ?)"
        ).run('q-' + i, run.id, JSON.stringify({ questions: [{ id: 'q', question: value, options: [] }] }), i);
        else database.appendEvent(owner.ownerId, run.id, { event: 'workbench_steering', steering_id: 's-' + i, query: value });
      }
      global.gc();
      const service = new WorkbenchService({ database });
      assert.throws(() => service.getRun(owner, run.id), { status: 413, code: 'RUN_METADATA_TOO_LARGE' });
      assert.equal(database.getRun(owner.ownerId, run.id).status, 'running');
      if (${JSON.stringify(mode)} === 'pending') {
        assert.equal(database.getPendingInput(owner.ownerId, run.id, 'q-1').payload.questions[0].question, value);
        assert.equal(database.getPendingInput(owner.ownerId, run.id, 'missing'), null);
        assert.throws(() => database.getPendingInput('another', run.id, 'q-1'), { status: 404 });
        assert.equal(database.db.prepare('SELECT count(*) AS n FROM pending_inputs WHERE run_id=?').get(run.id).n, 200);
      } else assert.equal(database.db.prepare('SELECT count(*) AS n FROM run_events WHERE run_id=?').get(run.id).n, 200);
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

it.each(['paged', 'legacy', 'sse'])('bounds legitimate large tool history in %s reads without stopping the run', mode => {
  const source = `
    import { WorkbenchDatabase } from ${JSON.stringify(new URL('../src/persistence.js', import.meta.url).href)};
    import { WorkbenchService } from ${JSON.stringify(new URL('../src/service.js', import.meta.url).href)};
    import { RunEventBus } from ${JSON.stringify(new URL('../src/events.js', import.meta.url).href)};
    import { streamRunEvents } from ${JSON.stringify(new URL('../src/sse.js', import.meta.url).href)};
    import { EventEmitter } from 'node:events';
    import assert from 'node:assert/strict';
    const database = new WorkbenchDatabase(':memory:');
    try {
      const owner = { ownerId: 'audit' };
      const chat = database.createChat({ ownerId: owner.ownerId, sessionId: 'native', selection: {} });
      const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id,
        sessionId: chat.sessionId, query: 'large valid history', selection: {} });
      database.transitionRun(owner.ownerId, run.id, 'running');
      const output = 'x'.repeat(512 * 1024);
      for (let index = 0; index < 200; index++) database.appendEvent(owner.ownerId, run.id, {
        event: 'workbench_activity', data: { stage: 'returned', tool_name: 'read', output, index },
      });
      const service = new WorkbenchService({ database });
      global.gc();
      if (${JSON.stringify(mode)} === 'paged') {
        let after = '0-0', through, seen = 0, pages = 0;
        do {
          const page = service.getRun(owner, run.id, true, { after, through });
          assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4 * 1024 * 1024 + 10000);
          assert.equal(page.status, 'running');
          through ??= page.events_through_cursor;
          assert.equal(through, '200-0');
          if (pages++ === 0) database.appendEvent(owner.ownerId, run.id, { event: 'workbench_context', used_tokens: 1 });
          for (const event of page.events) {
            assert.equal(event._id, (++seen) + '-0');
            assert.equal(event.data.output, output);
          }
          assert.equal(page.events_cursor, seen + '-0');
          assert.equal(page.history_complete, !page.events_next_cursor);
          after = page.events_next_cursor;
        } while (after);
        assert.equal(seen, 200);
        assert.ok(pages > 1);
        assert.throws(() => service.getRun(owner, run.id, true, { after: '201-0', through: '200-0' }), { status: 400 });
        assert.throws(() => service.getRun(owner, run.id, true, { after: '0-0', through: '202-0' }), { status: 400 });
        assert.throws(() => service.getRun({ ownerId: 'another' }, run.id, true, { after: '0-0' }), { status: 404 });
        database.appendEvent(owner.ownerId, run.id, { event: 'workbench_activity', data: { output: 'y'.repeat(9 * 1024 * 1024) } });
        global.gc();
        assert.throws(() => service.getRun(owner, run.id, true, { after: '201-0' }), { status: 413 });
        assert.equal(service.getRun(owner, run.id).status, 'running');
        database.appendEvent(owner.ownerId, run.id, { event: 'workbench_context', mcpTools: [{ description: 'z'.repeat(9 * 1024 * 1024) }] });
        global.gc();
        assert.throws(() => service.getRun(owner, run.id), { status: 413 });
        assert.equal(database.getRun(owner.ownerId, run.id).status, 'running');
      } else if (${JSON.stringify(mode)} === 'legacy') {
        assert.throws(() => service.getRun(owner, run.id, true), { status: 413, code: 'HISTORY_PAGE_REQUIRED' });
        assert.equal(service.getRun(owner, run.id).status, 'running');
        assert.equal(database.db.prepare('SELECT count(*) AS n FROM run_events WHERE run_id=?').get(run.id).n, 200);
      } else {
        database.transitionRun(owner.ownerId, run.id, 'completed');
        const res = new EventEmitter();
        let count = 0;
        res.writeHead = () => {};
        res.write = frame => {
          const event = JSON.parse(/^data: (.+)$/m.exec(frame)[1]);
          assert.equal(event.data.output, output);
          assert.equal(/^id: (.+)$/m.exec(frame)[1], (++count) + '-0');
          return true;
        };
        const bus = new RunEventBus();
        await new Promise(resolve => {
          res.end = resolve;
          streamRunEvents({ database, eventBus: bus, ownerId: owner.ownerId, runId: run.id, cursor: '0-0', res });
        });
        assert.equal(count, 200);
        assert.equal(bus.listeners.size, 0);
      }
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
