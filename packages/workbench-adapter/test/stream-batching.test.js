import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { createAssistantStreamProjector, projectSessionEvent, reconcileNativeSessions } from '../src/projection.js'

const databases = []
const directories = []
const temporaryRoot = resolve('.tmp', 'stream-batching')
afterEach(() => {
  vi.useRealTimers()
  databases.splice(0).forEach(database => database.close())
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(temporaryRoot + sep)) throw new Error('temporary directory escaped the test root')
    rmSync(directory, { recursive: true, force: true })
  }
})
function temporary() {
  mkdirSync(temporaryRoot, { recursive: true })
  const directory = mkdtempSync(join(temporaryRoot, 'case-'))
  directories.push(directory)
  return directory
}
function fixture(options = {}) {
  const database = new WorkbenchDatabase(':memory:', options)
  databases.push(database)
  const chat = database.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
  const run = database.createRun({ id: 'run', ownerId: chat.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} }).run
  database.bindRunMessage(chat.sessionId, run.id, 1, 'message')
  const projector = createAssistantStreamProjector(database, chat.ownerId)
  const agent = { id: chat.sessionId }
  projector({ agent, frame: { type: 'start', attemptId: 'a1', turn: 1, step: 1 } })
  const delta = text => projector({ agent, frame: { type: 'chunk', attemptId: 'a1', chunk: { type: 'text-delta', index: 0, text } } })
  return { database, chat, run, projector, agent, delta }
}

it('commits a whole delta batch before publishing any cursor, without changing event boundaries', () => {
  const published = []
  const test = fixture({ onEvent: (id, event) => published.push({ id, event, visible: test.database.db.prepare('SELECT COUNT(*) AS n FROM run_events').get().n }) })
  const exec = vi.spyOn(test.database.db, 'exec')
  for (let index = 0; index < 100; index++) test.delta(String(index))
  expect(published).toEqual([])
  expect(test.database.db.prepare('SELECT COUNT(*) AS n FROM run_events').get().n).toBe(0)
  test.database.flushStreamEvents()
  expect(exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(1)
  expect(exec.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1)
  expect(published).toHaveLength(100)
  expect(published.every(item => item.visible === 100)).toBe(true)
  expect(published.map(item => item.event._id)).toEqual(Array.from({ length: 100 }, (_, index) => `${index + 1}-0`))
  expect(test.database.db.prepare('PRAGMA synchronous').get().synchronous).toBe(2)
})

it('flushes by deadline and byte limit, and getters expose the latest committed cursor', async () => {
  vi.useFakeTimers()
  const test = fixture({ streamFlushMs: 20, streamBatchBytes: 1024 })
  test.delta('small')
  await vi.advanceTimersByTimeAsync(19)
  expect(test.database.db.prepare('SELECT COUNT(*) AS n FROM run_events').get().n).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(test.database.db.prepare('SELECT COUNT(*) AS n FROM run_events').get().n).toBe(1)
  test.delta('x'.repeat(1024))
  expect(test.database.db.prepare('SELECT COUNT(*) AS n FROM run_events').get().n).toBe(2)
  test.delta('getter flush')
  expect(test.database.getRun('owner', 'run').seq).toBe(3)
})

it('publishes nothing on a failed commit and retries the same batch without cursor gaps', () => {
  const published = []
  const test = fixture({ onEvent: (_id, event) => published.push(event) })
  test.delta('one')
  test.delta('two')
  const execute = test.database.db.exec.bind(test.database.db)
  let fail = true
  vi.spyOn(test.database.db, 'exec').mockImplementation(sql => {
    if (sql === 'COMMIT' && fail) { fail = false; throw new Error('simulated commit failure') }
    return execute(sql)
  })
  expect(() => test.database.flushStreamEvents()).toThrow('simulated commit failure')
  expect(published).toEqual([])
  expect(test.database.db.prepare('SELECT next_seq FROM runs WHERE id=?').get('run').next_seq).toBe(1)
  expect(test.database.getRun('owner', 'run').seq).toBe(2)
  expect(published.map(event => event._id)).toEqual(['1-0', '2-0'])
})

it('orders buffered deltas before reset, final message and terminal events on reconnect', () => {
  const test = fixture()
  test.delta('discarded partial')
  test.projector({ agent: test.agent, frame: { type: 'end', attemptId: 'a1', outcome: { kind: 'abandoned' } } })
  projectSessionEvent(test.database, 'session', { type: 'assistant/message', seq: 10,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'complete answer' }] } } })
  projectSessionEvent(test.database, 'session', { type: 'turn/end', seq: 11, data: { turn: 1, reason: { kind: 'completed' } } })
  const events = test.database.eventsAfter('owner', 'run', 1)
  expect(events[0]).toMatchObject({ event: 'workbench_stream_reset', _id: '2-0' })
  expect(events.at(-1).event).toBe('workbench_end')
  expect(events.filter(event => event.data?.kind === 'text').map(event => event.data.text)).toEqual(['complete answer'])
  expect(events.map(event => event._id)).toEqual(events.map((_, index) => `${index + 2}-0`))
})

it('flushes a pending delta before closing its persistent database', () => {
  const path = join(temporary(), 'projection.sqlite')
  const database = new WorkbenchDatabase(path)
  database.createChat({ id: 'chat', ownerId: 'owner', sessionId: 'session', selection: {} })
  database.createRun({ id: 'run', ownerId: 'owner', chatId: 'chat', sessionId: 'session', query: 'q', selection: {} })
  database.appendStreamEvent('owner', 'run', { event: 'workbench_activity', data: { kind: 'text', text: 'last' } }, 1, 1)
  database.close()
  const reopened = new WorkbenchDatabase(path)
  databases.push(reopened)
  expect(reopened.eventsAfter('owner', 'run', 0)).toMatchObject([{ _id: '1-0', data: { text: 'last' } }])
})

it('recovers a native final message after abrupt exit between committed and unpublished delta batches', async () => {
  const directory = temporary()
  const path = join(directory, 'projection.sqlite')
  const nativePath = join(directory, 'native-final.json')
  const source = new URL('../src/persistence.js', import.meta.url).href
  const script = `
    import { WorkbenchDatabase } from ${JSON.stringify(source)};
    import { writeFileSync } from 'node:fs';
    const db = new WorkbenchDatabase(${JSON.stringify(path)}, { streamFlushMs: 60000 });
    db.createChat({ id:'chat', ownerId:'owner', sessionId:'session', selection:{} });
    db.createRun({ id:'run', ownerId:'owner', chatId:'chat', sessionId:'session', query:'q', selection:{} });
    db.bindRunMessage('session','run',1,'message');
    const delta = text => ({event:'workbench_activity',data:{kind:'text',segment_id:'t1s1aattempt:b0',text}});
    db.appendStreamEvent('owner','run',delta('Hel'),1,1);
    db.flushStreamEvents();
    db.appendStreamEvent('owner','run',delta('lo'),1,1);
    writeFileSync(${JSON.stringify(nativePath)}, JSON.stringify([
      {type:'turn/start',seq:0,data:{turn:1}},
      {type:'user/message',seq:1,data:{id:'message',source:{kind:'user',rpcId:'run'},content:[{type:'text',text:'q'}]}},
      {type:'assistant/message',seq:2,data:{turn:1,step:1,message:{content:[{type:'text',text:'Hello'}]}}},
      {type:'turn/end',seq:3,data:{turn:1,reason:{kind:'completed'}}}
    ]));
    process.exit(0);
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  expect(child.status, child.stderr).toBe(0)
  const reopened = new WorkbenchDatabase(path)
  databases.push(reopened)
  expect(reopened.eventsAfter('owner', 'run', 0).map(event => event.data?.text)).toEqual(['Hel'])
  const nativeEvents = JSON.parse(readFileSync(nativePath, 'utf8'))
  const query = { observeSession: async () => ({ events: nativeEvents, [Symbol.dispose]() {} }) }
  await reconcileNativeSessions(reopened, query, 'owner')
  const replay = reopened.eventsAfter('owner', 'run', 1)
  expect(replay.some(event => event.event === 'workbench_stream_reset' && event.segment_prefix === 't1s1a')).toBe(true)
  expect(replay.filter(event => event.data?.kind === 'text').map(event => event.data.text)).toEqual(['Hello'])
  const cursor = reopened.getRun('owner', 'run').seq
  await reconcileNativeSessions(reopened, query, 'owner')
  expect(reopened.getRun('owner', 'run').seq).toBe(cursor)
  expect(reopened.eventsAfter('owner', 'run', cursor)).toEqual([])
})
