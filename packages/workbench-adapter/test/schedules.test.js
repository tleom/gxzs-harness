import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchSchedules } from '../src/schedules.js'
import { projectInboxClaim, projectSessionEvent, reconcileNativeSessions } from '../src/projection.js'
const opened = []
afterEach(() => opened.splice(0).forEach(db => db.close()))
function fixture() {
  const db = new WorkbenchDatabase(':memory:'); opened.push(db)
  const owner = { ownerId: 'owner' }
  const chat = db.createChat({ ownerId: owner.ownerId, sessionId: 'native', selection: { model: 'chosen/model' } })
  const foreign = db.createChat({ ownerId: 'foreign', sessionId: 'other', selection: {} })
  const task = { sessionId: chat.sessionId, record: { id: 'task', title: '提醒', prompt: '该打卡了', kind: 'daily' }, status: 'active' }
  const native = { catalog: vi.fn(async () => [{ ...task.record, sessionId: task.sessionId, status: task.status }, { ...task.record, sessionId: foreign.sessionId, status: task.status, id: 'foreign-task' }]),
    create: vi.fn(async () => task.record), history: vi.fn(async () => ({ records: [] })), update: vi.fn(async () => ({ updated: true })), delete: vi.fn(async () => ({ deleted: true })) }
  const service = { requireChat: (owner, id) => { const value = db.getChat(owner.ownerId, id); if (!value) throw Object.assign(new Error('missing'), { status: 404 }); return value } }
  return { db, owner, chat, task, foreign, native, gateway: new WorkbenchSchedules({ native, database: db, service }) }
}
it('scopes native tasks and their history/deletion to the signed chat owner', async () => {
  const test = fixture()
  expect(await test.gateway.catalog(test.owner)).toEqual([{ ...test.task.record, sessionId: test.chat.sessionId, status: test.task.status, chat_id: test.chat.id, chat_title: test.chat.title, chat_deleted: false }])
  for (const method of ['history', 'delete', 'update']) await expect(test.gateway[method](test.owner, 'foreign-task', {})).rejects.toMatchObject({ status: 404 })
  expect(test.native.history).not.toHaveBeenCalled(); expect(test.native.delete).not.toHaveBeenCalled(); expect(test.native.update).not.toHaveBeenCalled()
})
it('retains native delivery names without admitting another session task or overwriting later catalog edits', async () => {
  const test = fixture()
  const {run} = test.db.createRun({ownerId:test.owner.ownerId,chatId:test.chat.id,sessionId:test.chat.sessionId,query:'reminders_json: [{"schedule_id":"task"},{"schedule_id":"foreign-task"}]',selection:{native_source:'schedule'},mcpTools:[]})
  await test.gateway.rememberRun(run)
  expect(test.db.getRun(test.owner.ownerId,run.id).selection.schedule_titles).toEqual(['提醒'])
  test.native.catalog.mockResolvedValue([])
  await test.gateway.rememberRun(test.db.getRun(test.owner.ownerId,run.id))
  expect(test.native.catalog).toHaveBeenCalledOnce()
  expect(test.db.getRun(test.owner.ownerId,run.id).selection.schedule_titles).toEqual(['提醒'])
})
it('uses the owning native Session and preserves compare-and-update without accepting a body binding', async () => {
  const test = fixture(); const signal = new AbortController().signal
  await test.gateway.create(test.owner, test.chat.id, { title: '提醒', prompt: '内容', daily: { time: '08:00:00', time_zone: 'Asia/Shanghai' }, sessionId: test.foreign.sessionId }, signal)
  expect(test.native.create).toHaveBeenCalledWith(test.chat.sessionId, { title: '提醒', prompt: '内容', daily: { time: '08:00:00', time_zone: 'Asia/Shanghai' } }, signal)
  const expected = test.task.record
  await test.gateway.update(test.owner, 'task', { expected, title: '新名称', sessionId: 'foreign' }, signal)
  expect(test.native.update).toHaveBeenCalledWith({ sessionId: test.chat.sessionId, id: 'task', expected, title: '新名称' }, signal)
  await test.gateway.history(test.owner, 'task', 'cursor')
  expect(test.native.history).toHaveBeenCalledWith({ sessionId: test.chat.sessionId, id: 'task', limit: 50, before: 'cursor' })
})
it('keeps retained receipts owner-scoped after a chat is soft-deleted', async () => {
  const test = fixture()
  test.db.deleteChat(test.owner.ownerId, test.chat.id)
  expect(await test.gateway.catalog(test.owner)).toEqual([expect.objectContaining({ id: 'task', chat_deleted: true })])
  await test.gateway.history(test.owner, 'task')
  expect(test.native.history).toHaveBeenCalledWith({ sessionId: test.chat.sessionId, id: 'task', limit: 50 })
  await expect(test.gateway.history({ ownerId: 'unknown' }, 'task')).rejects.toMatchObject({ status: 404 })
})
it('adopts one native scheduled delivery for admission without re-enqueuing it or renaming the chat', () => {
  const { db, chat, owner } = fixture()
  const message = { id: 'delivery-id', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'reminder' }] }
  const context = { mcpTools: [{ id: 'mcp', version: 'v1' }] }
  projectSessionEvent(db, chat.sessionId, { seq: 1, type: 'agent/inbox/spliced', data: { inserted: [message] } }, owner.ownerId, context)
  projectSessionEvent(db, chat.sessionId, { seq: 2, type: 'turn/start', data: { turn: 1 } }, owner.ownerId)
  const claimed = projectInboxClaim(db, { agent: { id: chat.sessionId }, message, turn: 1 }, owner.ownerId, context)
  expect(claimed.id).toBe(message.id); expect(db.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
  expect(db.runForTurn(chat.sessionId, 1)).toMatchObject({ status: 'running', mcpTools: context.mcpTools })
  expect(db.submissions(owner.ownerId)).toEqual([])
  expect(db.getChat(owner.ownerId, chat.id).title).toBe(chat.title)
  projectInboxClaim(db, { agent: { id: chat.sessionId }, message, turn: 1 }, owner.ownerId, context)
  expect(db.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
})
it('rejects unknown or already-fenced native child notifications', () => {
  const {db,chat,owner} = fixture()
  const {run} = db.createRun({ownerId:owner.ownerId,chatId:chat.id,sessionId:chat.sessionId,query:'task',selection:{subagent_ids:['child']},mcpTools:[]})
  db.transitionRun(owner.ownerId,run.id,'running')
  const message = sender => ({id:`notice-${sender}`,source:{kind:'subagent-settled',senderSessionId:sender},content:[{type:'text',text:'done'}]})
  expect(projectInboxClaim(db,{agent:{id:chat.sessionId},message:message('foreign'),turn:2},owner.ownerId)).toBeUndefined()
  db.requireRunFence(owner.ownerId,run.id)
  db.confirmRunFence(owner.ownerId,run.id,{fenced:true})
  expect(projectInboxClaim(db,{agent:{id:chat.sessionId},message:message('child'),turn:2},owner.ownerId)).toBeUndefined()
  expect(db.listRuns(owner.ownerId,chat.id)).toHaveLength(1)
})
it('replays an acknowledged scheduled turn after restart without generating another delivery', async () => {
  const { db, chat, owner } = fixture()
  const message = { id: 'restored-delivery', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'reminder' }] }
  const sessionQuery = { observeSession: async () => ({ events: [
    { type: 'turn/start', seq: 1, data: { turn: 1 } }, { type: 'user/message', seq: 2, data: message },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } } ], [Symbol.dispose]() {} }) }
  await reconcileNativeSessions(db, sessionQuery, owner.ownerId)
  await reconcileNativeSessions(db, sessionQuery, owner.ownerId)
  expect(db.listRuns(owner.ownerId, chat.id)).toHaveLength(1)
  expect(db.runForTurn(chat.sessionId, 1)).toMatchObject({ id: message.id, status: 'completed' })
  expect(db.submissions(owner.ownerId)).toEqual([])
})

it('reconstructs multiple native schedule messages in one completed turn with one steering receipt', async () => {
  const { db, chat, owner } = fixture()
  const first = { id: 'same-turn-schedule-first', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'first reminder' }] }
  const second = { id: 'same-turn-schedule-second', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'second reminder' }] }
  const query = { observeSession: async () => ({ events: [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: first },
    { type: 'user/message', seq: 3, data: second },
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ], [Symbol.dispose]() {} }) }
  await reconcileNativeSessions(db, query, owner.ownerId, undefined, [])
  expect(db.getRun(owner.ownerId, first.id)).toMatchObject({ status: 'completed' })
  expect(db.getRun(owner.ownerId, second.id)).toMatchObject({ status: 'steered' })
  await reconcileNativeSessions(db, query, owner.ownerId, undefined, [])
  expect(db.allEvents(owner.ownerId, second.id).filter(event => event.event === 'workbench_steered')).toHaveLength(1)
  expect(db.allEvents(owner.ownerId, first.id).filter(event => event.event === 'workbench_steering')).toHaveLength(1)
})

it('replays completed native turns whose events arrived before autonomous receipt admission was ready', async () => {
  const { db, chat, owner } = fixture()
  const first = { id: 'early-completed-schedule', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'first reminder' }] }
  const second = { id: 'early-second-schedule', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'second reminder' }] }
  const events = [
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [first] } },
    { type: 'turn/start', seq: 2, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [second] } },
    { type: 'user/message', seq: 4, data: first },
    { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 6, data: { turn: 2 } },
    { type: 'agent/inbox/spliced', seq: 7, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'user/message', seq: 8, data: second },
    { type: 'turn/end', seq: 9, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  for (const event of events) projectSessionEvent(db, chat.sessionId, event, owner.ownerId, { mcpCatalogReady: false })
  expect(db.hasProjectedEvent(chat.sessionId, 5)).toBe(false)
  expect(db.hasProjectedEvent(chat.sessionId, 9)).toBe(false)
  // The current autonomous claim is verified before cold recovery adopts the
  // earlier delivery, matching the actual startup receipt ordering.
  projectInboxClaim(db, { agent: { id: chat.sessionId }, message: second, turn: 2 }, owner.ownerId, { mcpTools: [] })
  const query = { observeSession: async () => ({ events, [Symbol.dispose]() {} }) }
  await reconcileNativeSessions(db, query, owner.ownerId, () => ({ mcpTools: [] }), [])
  expect(db.getRun(owner.ownerId, first.id)).toMatchObject({ status: 'completed', sourceEndSeq: 5 })
  expect(db.getRun(owner.ownerId, second.id)).toMatchObject({ status: 'completed', sourceEndSeq: 9 })
  await reconcileNativeSessions(db, query, owner.ownerId, () => ({ mcpTools: [] }), [])
  for (const message of [first, second])
    expect(db.allEvents(owner.ownerId, message.id).filter(event => event.event === 'workbench_end')).toHaveLength(1)
  expect(db.listRuns(owner.ownerId, chat.id)).toHaveLength(2)
  expect(db.submissions(owner.ownerId)).toEqual([])
})

it('repairs a previously acknowledged native completion that had no bound receipt output', async () => {
  const { db, chat, owner } = fixture()
  const message = { id: 'formerly-unbound-schedule', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'reminder' }] }
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: message },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  for (const event of events) db.markProjectedEvent(chat.sessionId, event.seq)
  projectInboxClaim(db, { agent: { id: chat.sessionId }, message, turn: 1 }, owner.ownerId)
  const query = { observeSession: async () => ({ events, [Symbol.dispose]() {} }) }
  await reconcileNativeSessions(db, query, owner.ownerId, undefined, [])
  await reconcileNativeSessions(db, query, owner.ownerId, undefined, [])
  expect(db.getRun(owner.ownerId, message.id)).toMatchObject({ status: 'completed', sourceEndSeq: 3 })
  expect(db.allEvents(owner.ownerId, message.id).filter(event => event.event === 'workbench_end')).toHaveLength(1)
})

it('does not interrupt a new native schedule delivery arriving during cold history recovery', async () => {
  const { db, chat, owner } = fixture()
  const old = db.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
    query: 'old unfinished work', selection: {} }).run
  db.transitionRun(owner.ownerId, old.id, 'running')
  let releaseHistory
  const coldSnapshot = new Promise(resolve => { releaseHistory = resolve })
  const recovering = reconcileNativeSessions(db, { observeSession: () => coldSnapshot }, owner.ownerId)
  const message = { id: 'new-schedule-during-recovery', source: { kind: 'schedule' },
    content: [{ type: 'text', text: 'new timer delivery' }] }
  projectSessionEvent(db, chat.sessionId, { type: 'agent/inbox/spliced', seq: 1,
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] } }, owner.ownerId)
  projectSessionEvent(db, chat.sessionId, { type: 'turn/start', seq: 2, data: { turn: 2 } }, owner.ownerId)
  projectInboxClaim(db, { agent: { id: chat.sessionId }, message, turn: 2 }, owner.ownerId)
  expect(db.getRun(owner.ownerId, message.id)).toMatchObject({ status: 'running' })
  // The original history read began before this live delivery was committed.
  releaseHistory({ events: [], [Symbol.dispose]() {} })
  await recovering
  expect(db.getRun(owner.ownerId, old.id)).toMatchObject({ status: 'interrupted' })
  expect(db.getRun(owner.ownerId, message.id)).toMatchObject({ status: 'running' })
  projectSessionEvent(db, chat.sessionId, { type: 'turn/end', seq: 4,
    data: { turn: 2, reason: { kind: 'completed' } } }, owner.ownerId)
  expect(db.getRun(owner.ownerId, message.id)).toMatchObject({ status: 'completed', error: undefined })
})

it('keeps the same startup recovery boundary when MCP recovery retries after a new native claim', async () => {
  const { db, chat, owner } = fixture()
  const stale = db.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: chat.sessionId,
    query: 'unfinished before startup', selection: {} }).run
  db.transitionRun(owner.ownerId, stale.id, 'running')
  const startupRunIds = [stale.id]
  const oldPending = { id: 'cold-pending-schedule', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'old pending' }] }
  const query = { observeSession: async () => ({ events: [
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [oldPending] } },
  ], [Symbol.dispose]() {} }) }
  await expect(reconcileNativeSessions(db, query, owner.ownerId,
    () => { throw new Error('catalog unavailable') }, startupRunIds)).rejects.toThrow('catalog unavailable')
  const message = { id: 'new-claimed-before-recovery-retry', source: { kind: 'schedule' }, content: [{ type: 'text', text: 'new timer' }] }
  projectSessionEvent(db, chat.sessionId, { type: 'turn/start', seq: 2, data: { turn: 2 } }, owner.ownerId)
  projectInboxClaim(db, { agent: { id: chat.sessionId }, message, turn: 2 }, owner.ownerId)
  await reconcileNativeSessions(db, query, owner.ownerId, () => ({ mcpTools: [] }), startupRunIds)
  expect(db.getRun(owner.ownerId, message.id)).toMatchObject({ status: 'running' })
  expect(db.getRun(owner.ownerId, stale.id)).toMatchObject({ status: 'interrupted' })
  expect(db.getRun(owner.ownerId, oldPending.id)).toMatchObject({ status: 'queued' })
})

it('waits for verified MCP resources before creating a recovered schedule receipt and freezes them once', async () => {
  const {db,chat,owner}=fixture()
  const message={id:'unclaimed-delivery',source:{kind:'schedule'},content:[{type:'text',text:'reminder'}]}
  const sessionQuery={observeSession:async()=>({events:[
    {type:'agent/inbox/spliced',seq:1,data:{target:'next-turn',start:0,removedCount:0,inserted:[message]}},
  ],[Symbol.dispose]() {}})}
  const unavailable=()=>{throw new Error('catalog unavailable')}
  await expect(reconcileNativeSessions(db,sessionQuery,owner.ownerId,unavailable)).rejects.toThrow('catalog unavailable')
  expect(db.listRuns(owner.ownerId,chat.id)).toHaveLength(0)
  const mcpTools=[{id:'personal:tool',version:'v1',manifest_version:'m1'}]
  await reconcileNativeSessions(db,sessionQuery,owner.ownerId,()=>({mcpTools}))
  expect(db.getRun(owner.ownerId,message.id).mcpTools).toEqual(mcpTools)
  await reconcileNativeSessions(db,sessionQuery,owner.ownerId,unavailable)
  expect(db.getRun(owner.ownerId,message.id).mcpTools).toEqual(mcpTools)
  expect(db.listRuns(owner.ownerId,chat.id)).toHaveLength(1)
})
