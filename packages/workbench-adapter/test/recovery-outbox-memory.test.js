import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

it('drains recovery fences and lists notifications without retaining historical resource payloads', () => {
  const source = `
    import assert from 'node:assert/strict';
    import { WorkbenchDatabase } from ${JSON.stringify(new URL('../src/persistence.js', import.meta.url).href)};
    import { TaskScheduler } from ${JSON.stringify(new URL('../src/scheduler.js', import.meta.url).href)};
    const db = new WorkbenchDatabase(':memory:');
    try {
      const ownerId='owner', sessionId='session', chatId='chat', count=200;
      db.createChat({ id:chatId, ownerId, sessionId, selection:{} });
      for(let i=0;i<count;i++) {
        db.createRun({ id:'run-'+i, ownerId, chatId, sessionId, query:'preserved', selection:{
          schedule_notification_pending:true, schedule_occurrences:[{jobId:'schedule', occurrenceAt:i}],
        } });
        db.transitionRun(ownerId,'run-'+i,'completed');
        db.requireRunFence(ownerId,'run-'+i);
      }
      db.createChat({id:'deleted',ownerId,sessionId:'deleted-session',selection:{}});
      db.createRun({id:'deleted-run',ownerId,chatId:'deleted',sessionId:'deleted-session',query:'',selection:{schedule_notification_pending:true}});
      db.transitionRun(ownerId,'deleted-run','completed');
      db.requireRunFence(ownerId,'deleted-run');
      db.db.prepare('UPDATE chats SET deleted_at=1 WHERE id=?').run('deleted');
      const snapshot=JSON.stringify([{description:'x'.repeat(512*1024)}]);
      db.db.prepare('UPDATE runs SET mcp_tools_json=?,attachments_json=?').run(snapshot,snapshot);
      const fences=db.pendingRunFences(ownerId);
      assert.equal(fences.length,count);
      assert.ok(fences.every(run=>run.sessionId===sessionId));
      assert.equal(db.pendingRunFences(ownerId,{includeDeleted:true}).length,count+1);
      assert.deepEqual(db.pendingRunFences('foreign'),[]);
      const notifications=db.pendingScheduleNotifications(ownerId);
      assert.equal(notifications.length,count);
      assert.ok(notifications.every(run=>run.ownerId===ownerId && run.chatId===chatId && run.sessionId===sessionId && run.query==='preserved' && run.status==='completed' && run.selection.schedule_occurrences.length===1 && typeof run.updatedAt==='number'));
      assert.deepEqual(db.pendingScheduleNotifications('foreign'),[]);
      let active=0,peak=0;const cancelled=new Set();
      const scheduler=new TaskScheduler({database:db,ownerId,agents:new Map(),sessions:{},platformClient:{json:async request=>{
        assert.equal(request.route,'mcp/cancel');
        assert.equal(request.owner.ownerId,ownerId);
        const id=JSON.parse(request.body).run_id;
        active++;peak=Math.max(peak,active);
        await new Promise(resolve=>setImmediate(resolve));
        cancelled.add(id);active--;
        return {fenced:true,uncertain:false};
      }}});
      await scheduler.flushFences();
      assert.equal(cancelled.size,count);assert.ok(peak<=4);
      assert.deepEqual(db.pendingRunFences(ownerId),[]);
      assert.equal(db.pendingRunFences(ownerId,{includeDeleted:true}).length,1);
      assert.equal(db.pendingScheduleNotifications(ownerId).length,count);
      assert.equal(db.db.prepare('SELECT count(*) AS n FROM runs WHERE mcp_tools_json=? AND attachments_json=?').get(snapshot,snapshot).n,count+1);
      assert.equal(db.getRun(ownerId,'run-0').mcpTools[0].description.length,512*1024);
      global.gc();
      console.log(JSON.stringify({completed:true,heapBytes:process.memoryUsage().heapUsed}));
    } finally {db.close();}
  `
  const child = spawnSync(process.execPath, ['--max-old-space-size=96', '--expose-gc', '--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  })
  expect(child.status, child.stderr).toBe(0)
  expect(JSON.parse(child.stdout)).toMatchObject({ completed: true })
  expect(JSON.parse(child.stdout).heapBytes).toBeLessThan(40 * 1024 * 1024)
}, 35000)
