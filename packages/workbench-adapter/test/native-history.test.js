import { afterEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadNativeHistoryPage } from '../src/history-page.js'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchService } from '../src/service.js'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { default: Llm, createMessage, createUserMessage }, { default: Sessions },
  { default: Projections }, { default: Prompt }, { default: Tools }, { default: Agents }, { default: Query }] = await Promise.all([
  native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'),
  native('dsh-system-prompt'), native('dsh-tools'), native('dsh-agent'), native('dsh-session-query'),
])
// Exact published implementation, as used by SessionController.page().
const { SessionHistoryController } = await import(pathToFileURL(join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller')), 'types/history.js')).href)
const contexts = []

it.each([false, true])('retains a terminal query that failed before native turn admission (live=%s)', async nativeLive => {
  const { session, services } = await fixture()
  const database = new WorkbenchDatabase(':memory:')
  const owner = { ownerId: 'owner' }
  try {
    const chat = database.createChat({ ownerId: owner.ownerId, sessionId: session.id, selection: {} })
    const { run } = database.createRun({ ownerId: owner.ownerId, chatId: chat.id, sessionId: session.id,
      query: 'Keep my failed question', selection: {} })
    database.transitionRun(owner.ownerId, run.id, 'failed', 'Model selection failed')
    const service = new WorkbenchService({ database, sessionController: services.sessions, sessionQuery: services.sessionQuery })
    const page = await service.historyPage(owner, chat.id, undefined, new AbortController().signal, nativeLive)
    expect(page.runs).toEqual([expect.objectContaining({ id: run.id, query: 'Keep my failed question', status: 'failed', error: 'Model selection failed' })])
  } finally { database.close() }
})
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents, Query]) await ctx.plugin(plugin)
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
  return { ctx, session, services: { sessions: new SessionHistoryController(ctx, observation => observation[Symbol.dispose]()), sessionQuery: ctx.sessionQuery } }
}
function turn(session, number, count) {
  session.append('turn/start', { turn: number })
  session.append('user/message', createUserMessage({content:[{type:'text',text:`question ${number}`}],source:{kind:'user'}}), {surfaceOp:'append'})
  for (let step=1;step<=count;step++) session.append('assistant/message', {
    turn:number,step,message:createMessage({role:'assistant',content:[{type:'text',text:`answer ${number}/${step}`}],source:{kind:'model',provider:'fixture',model:'fixture'}}),
    stream:[],
  }, {surfaceOp:'append'})
  session.append('turn/end', {turn:number,reason:{kind:'completed'}})
}
it('uses real DSH turn-aligned pages with no duplicate or missing offsets across 160 rounds', async () => {
  const {session,services}=await fixture()
  for(let i=1;i<=160;i++)turn(session,i,1)
  const originalCount=session.seq
  let page=await loadNativeHistoryPage(services,session.id,undefined,new AbortController().signal)
  expect(page.records[0].event.type).toBe('turn/start')
  expect(page.records.filter(item=>['user/message','assistant/message'].includes(item.event.type))).toHaveLength(50)
  const seen=page.records.map(item=>item.event.seq)
  // New live messages must not drift the backwards cursor's opening cut.
  turn(session,161,1)
  while(page.cursor) {
    page=await loadNativeHistoryPage(services,session.id,page.cursor,new AbortController().signal)
    seen.unshift(...page.records.map(item=>item.event.seq))
  }
  expect(seen).toEqual(Array.from({length:originalCount},(_,i)=>i))
})
it('respects the native 500-message ceiling within a single oversized turn', async () => {
  const {session,services}=await fixture()
  turn(session,1,610)
  const page=await loadNativeHistoryPage(services,session.id,undefined,new AbortController().signal)
  expect(page.records.filter(item=>['user/message','assistant/message'].includes(item.event.type))).toHaveLength(500)
  expect(page.cursor).not.toBeNull()
  const older=await loadNativeHistoryPage(services,session.id,page.cursor,new AbortController().signal)
  expect(older.cursor).toBeNull()
  expect([...older.records,...page.records].map(item=>item.event.seq)).toEqual(Array.from({length:session.seq},(_,i)=>i))
})
it('keeps native compaction replacement metadata without counting its model-only checkpoint as a new prompt', async () => {
  const {session,services}=await fixture()
  turn(session,1,610)
  const shadowed=[...session.surface.nodes]
  const summary=session.append('compaction/summary',{
    summary:[{type:'text',text:'context summary'}],shadowedRange:{start:shadowed[0],end:shadowed.at(-1)},
    shadowedSeqs:shadowed,shadowedTokenCount:12000,provider:'fixture',model:'fixture',
  })
  const checkpoint=session.append('user/message',createUserMessage({
    content:[{type:'text',text:'<context_checkpoint>summary</context_checkpoint>'}],
    source:{kind:'compact-checkpoint',compactionId:'history-checkpoint'},
  }),{surfaceOp:{op:'replace',startSeq:shadowed[0],endSeq:shadowed.at(-1)},sourceEventSeqs:[...shadowed,summary.seq]})
  const page=await loadNativeHistoryPage(services,session.id,undefined,new AbortController().signal)
  const appendMessages=page.records.filter(({event})=>['user/message','assistant/message'].includes(event.type)
    && (event.surfaceOp==null||event.surfaceOp==='append'))
  expect(appendMessages).toHaveLength(500)
  expect(page.records.at(-1).event).toEqual(checkpoint)
  expect(page.records.at(-2).event).toEqual(summary)
  expect(page.cursor).not.toBeNull()
})

it('reconnects an oversized live turn with a bounded native snapshot and continuous unfinished output', async () => {
  const {ctx,session,services}=await fixture()
  turn(session,1,610)
  session.append('turn/start',{turn:2})
  const agent={session}
  const emit=frame=>ctx.emit('agent/assistant-stream',{agent,frame})
  emit({type:'start',attemptId:'live',revision:1,turn:2,step:1})
  emit({type:'chunk',attemptId:'live',revision:2,index:0,time:1,chunk:{type:'text-delta',index:0,text:'before reconnect'}})
  const abort=new AbortController()
  const follow=services.sessions.follow({address:{kind:'session',sessionId:session.id},
    maxMessages:500,turnWindow:{minMessages:50,minTurns:2},assistantStream:true},abort.signal)
  try {
    const {value:snapshot}=await follow.next()
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot.hasMore).toBe(true)
    expect(snapshot.records.filter(({event})=>['user/message','assistant/message'].includes(event.type))).toHaveLength(500)
    expect(snapshot.assistantStream).toMatchObject({revision:2,activeAttempt:{attemptId:'live',turn:2,step:1,nextIndex:1,startedAfterSeq:snapshot.cursor}})
    expect(JSON.stringify(snapshot.assistantStream.activeAttempt.stream)).toContain('before reconnect')
    emit({type:'chunk',attemptId:'live',revision:3,index:1,time:2,chunk:{type:'text-delta',index:0,text:' after reconnect'}})
    const delta=await follow.next()
    expect(delta.value).toMatchObject({type:'assistant-stream',frame:{revision:3,index:1,chunk:{text:' after reconnect'}}})
    const committed=session.append('assistant/message',{turn:2,step:1,
      message:createMessage({role:'assistant',content:[{type:'text',text:'before reconnect after reconnect'}],source:{kind:'model',provider:'fixture',model:'fixture'}}),stream:[]},{surfaceOp:'append'})
    expect((await follow.next()).value).toMatchObject({type:'event',event:{seq:committed.seq,type:'assistant/message'}})
    expect(committed.seq).toBe(snapshot.cursor+1)
    emit({type:'end',attemptId:'live',revision:4,index:2,outcome:{kind:'committed',eventType:'assistant/message',seq:committed.seq}})
    expect((await follow.next()).value).toMatchObject({type:'assistant-stream',frame:{revision:4,type:'end'}})
  } finally {
    abort.abort()
    await follow.return()
  }
})

it('cancels one native history follower without interrupting another and reopens at a fresh cut', async () => {
  const {session,services}=await fixture()
  turn(session,1,1)
  const request={address:{kind:'session',sessionId:session.id},maxMessages:500,assistantStream:true}
  const firstAbort=new AbortController(), secondAbort=new AbortController()
  const first=services.sessions.follow(request,firstAbort.signal)
  const second=services.sessions.follow(request,secondAbort.signal)
  try {
    const opening=await Promise.all([first.next(),second.next()])
    expect(opening[0].value.cursor).toBe(opening[1].value.cursor)
    const waiting=first.next()
    firstAbort.abort()
    expect(await waiting).toMatchObject({done:true})
    const event=session.append('turn/start',{turn:2})
    expect((await second.next()).value).toMatchObject({type:'event',event:{seq:event.seq,type:'turn/start'}})
    const reconnect=services.sessions.follow(request,new AbortController().signal)
    try {
      const {value:snapshot}=await reconnect.next()
      expect(snapshot.cursor).toBe(event.seq)
      expect(snapshot.records.at(-1).event.seq).toBe(event.seq)
    } finally { await reconnect.return() }
  } finally {
    firstAbort.abort(); secondAbort.abort()
    await first.return(); await second.return()
  }
})

it('carries a real native oversized snapshot and settlement through the Workbench service without full-run reads', async () => {
  const {ctx,session,services}=await fixture()
  const database=new WorkbenchDatabase(':memory:')
  const owner={ownerId:'owner'}
  const chat=database.createChat({ownerId:owner.ownerId,sessionId:session.id,selection:{}})
  const {run}=database.createRun({ownerId:owner.ownerId,chatId:chat.id,sessionId:session.id,query:'goal',selection:{}})
  database.bindRunMessage(session.id,run.id,1,'first')
  database.bindNativeTurn(run,2)
  database.transitionRun(owner.ownerId,run.id,'running')
  const service=new WorkbenchService({database,agents:ctx.agents,sessionController:services.sessions,sessionQuery:services.sessionQuery})
  const abort=new AbortController()
  const stream=service.followHistory(owner,chat.id,abort.signal)
  try {
    turn(session,1,610)
    session.append('turn/start',{turn:2})
    ctx.emit('agent/assistant-stream',{agent:{session},frame:{type:'start',attemptId:'real',revision:1,turn:2,step:1}})
    ctx.emit('agent/assistant-stream',{agent:{session},frame:{type:'chunk',attemptId:'real',revision:2,index:0,time:1,chunk:{type:'text-delta',index:0,text:'partial'}}})
    database.allEvents=()=>{throw new Error('full-run history must not be read')}
    const opening=(await stream.next()).value
    expect(opening.value.records.filter(({event})=>['user/message','assistant/message'].includes(event.type))).toHaveLength(500)
    expect(opening.runs).toHaveLength(1)
    expect(opening.display.events.at(-1).event.data).toMatchObject({text:'partial',native_attempt:'real'})
    const committed=session.append('assistant/message',{turn:2,step:1,message:createMessage({role:'assistant',content:[{type:'text',text:'partial complete'}],source:{kind:'model',provider:'fixture',model:'fixture'}}),stream:[]},{surfaceOp:'append'})
    expect((await stream.next()).value.display.events).toEqual([])
    ctx.emit('agent/assistant-stream',{agent:{session},frame:{type:'end',attemptId:'real',revision:3,index:1,outcome:{kind:'committed',eventType:'assistant/message',seq:committed.seq}}})
    const final=(await stream.next()).value.display
    expect(final.retire_attempts).toContain('real')
    expect(final.events.at(-1).event.data.text).toBe('partial complete')
  } finally {
    abort.abort(); await stream.return(); database.close()
  }
})
