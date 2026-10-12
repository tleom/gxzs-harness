import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { HistoryPresentation } from '../src/history-presentation.js'

const run={id:'run',selection:{},mcpTools:[{runtime_name:'mcp__search',server_id:'法律资料',tool_name:'检索'}]}
const snapshot=(records=[],assistantStream={revision:0})=>({type:'snapshot',records,assistantStream})
const durable=(seq,type,data)=>({type:'event',event:{seq,type,data,surfaceOp:'append'}})
const frame=value=>({type:'assistant-stream',frame:value})
it('shows file preparation immediately and updates its native KB counter before tool execution', () => {
  const view = new HistoryPresentation('session', () => run)
  view.accept(snapshot())
  view.accept(frame({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1, startedAfterSeq: 0 }))
  const delta = (index, chunk) => view.accept(frame({ type: 'chunk', attemptId: 'a', revision: index + 2, index, time: index + 1, chunk }))
  const first = delta(0, { type: 'tool-call-delta', index: 0, id: 'write-call', name: 'write', argumentsDelta: '' })
  expect(first.events[0].event.data).toMatchObject({ call_id: 'write-call', tool_name: 'write', stage: 'preparing', argument_chars: 0, native_attempt: 'a' })
  const content = '{"path":"data.js","content":"' + 'x'.repeat(5000)
  expect(delta(1, { type: 'tool-call-delta', index: 0, id: 'write-call', argumentsDelta: content }).events[0].event.data.argument_chars).toBe(content.length)
  expect(delta(2, { type: 'tool-call-delta', index: 0, id: 'write-call', argumentsDelta: 'x' }).events).toEqual([])
  const call = view.accept(durable(1, 'tool/call', { turn: 1, callId: 'write-call', name: 'write', arguments: content + 'x"}' }))
  expect(call.events[0].event.data).toMatchObject({ call_id: 'write-call', stage: 'started' })
  expect(JSON.stringify(first)).not.toContain('content')
})
it('restores a preparing file counter from the native reconnect prefix and retires failed attempts', () => {
  const view = new HistoryPresentation('session', () => run)
  const opened = view.accept(snapshot([], { revision: 2, activeAttempt: { attemptId: 'a', turn: 1, step: 1, startedAfterSeq: 0, nextIndex: 1,
    stream: [{ type: 'tool-call-chunks', time0: 1, index: 0, id: 'edit-call', name: 'edit', dt: [], args: ['x'.repeat(2300)] }] } }))
  expect(opened.events[0].event.data).toMatchObject({ call_id: 'edit-call', stage: 'preparing', argument_chars: 2300 })
  expect(view.accept(frame({ type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'abandoned' } })).retire_attempts).toEqual(['a'])
  expect(view.preparations.size).toBe(0)
  view.accept(frame({ type: 'start', attemptId: 'retry', revision: 4, turn: 1, step: 1, startedAfterSeq: 0 }))
  expect(view.accept(frame({ type: 'chunk', attemptId: 'retry', revision: 5, index: 0, time: 2,
    chunk: { type: 'tool-call-delta', index: 0, id: 'edit-call', name: 'edit', argumentsDelta: '' } })).events[0].event.data.argument_chars).toBe(0)
})
it('keeps simultaneous file preparation counters separate and leaves other tools unchanged', () => {
  const view = new HistoryPresentation('session', () => run)
  view.accept(snapshot())
  view.accept(frame({ type: 'start', attemptId: 'a', revision: 1, turn: 1, step: 1, startedAfterSeq: 0 }))
  const chunks = [{ index: 0, id: 'a', name: 'write', argumentsDelta: 'x'.repeat(1025) },
    { index: 1, id: 'b', name: 'edit', argumentsDelta: 'x'.repeat(10) },
    { index: 2, id: 'c', name: 'bash', argumentsDelta: 'x'.repeat(2000) }]
  const events = chunks.flatMap((chunk, index) => view.accept(frame({ type: 'chunk', attemptId: 'a', revision: index + 2, index, time: index + 1,
    chunk: { type: 'tool-call-delta', ...chunk } })).events)
  expect(events.map(item => [item.event.data.call_id, item.event.data.argument_chars])).toEqual([['a', 1025], ['b', 10]])
})
it('renders automatic compaction once at its checkpoint in both live and restored history', () => {
  const records = [durable(1, 'turn/start', { turn: 1 }),
    durable(2, 'compaction/summary', { compactionId: 'compact', summary: [{ type: 'text', text: '保留事实' }], shadowedSeqs: [0], shadowedTokenCount: 500 }),
    { ...durable(3, 'user/message', { source: { kind: 'compact-checkpoint', compactionId: 'compact' } }),
      event: { seq: 3, type: 'user/message', data: { source: { kind: 'compact-checkpoint', compactionId: 'compact' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } } }]
  const restored = new HistoryPresentation('s', () => run).accept(snapshot(records)).events
  const live = new HistoryPresentation('s', () => run)
  live.accept(snapshot())
  expect(records.flatMap(record => live.accept(record).events)).toEqual(restored)
  expect(restored).toEqual([{ run_id: 'run', event: expect.objectContaining({ event: 'workbench_compaction', summary: '保留事实', items: 1, tokens: 500 }) }])
  records[2].event.data.source.sourceCommandId = 'manual'
  expect(new HistoryPresentation('s', () => run).accept(snapshot(records)).events).toHaveLength(0)
})
it('maps inherited native message identities to forked runs without duplicating the original prompt', () => {
  const fork = { ...run, id: 'fork-run', messageId: 'original-message' }
  const view = new HistoryPresentation('fork-session', () => fork, undefined,
    id => id === 'supplement-message' ? { id: 'fork-supplement', query: 'extra' } : undefined)
  const result = view.accept(snapshot([
    durable(1, 'turn/start', { turn: 1 }),
    durable(2, 'user/message', { id: 'original-message', source: { rpcId: 'original-run' }, content: [{ type: 'text', text: 'original' }] }),
    durable(3, 'user/message', { id: 'supplement-message', source: { rpcId: 'original-supplement' }, content: [{ type: 'text', text: 'extra' }] }),
  ]))
  expect(result.events).toHaveLength(1)
  expect(result.events[0].event).toMatchObject({ steering_id: 'fork-supplement', query: 'extra' })
})
it('uses the same consumed user-message position in a snapshot and live follow even without a turn on the message', () => {
  const records = [durable(1, 'turn/start', { turn: 1 }),
    durable(2, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'before' }] } }),
    durable(3, 'user/message', { source: { kind: 'user', rpcId: 'supplement' }, content: [{ type: 'text', text: 'extra' }] }),
    durable(4, 'assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'after' }] } })]
  const resolve = turn => turn === 1 ? run : undefined
  const baseline = new HistoryPresentation('session', resolve).accept(snapshot(records)).events
  const live = new HistoryPresentation('session', resolve)
  live.accept(snapshot())
  expect(records.flatMap(record => live.accept(record).events)).toEqual(baseline)
  expect(baseline.findIndex(item => item.event.event === 'workbench_steering')).toBe(2)
  expect(baseline[2].event).toMatchObject({ steering_id: 'supplement', query: 'extra' })
})
it('keeps the vendored publication fold identical to the pinned native package except its source-map reference',async()=>{
  const require=createRequire(new URL('../../../profiles/workbench/package.json',import.meta.url))
  const original=join(dirname(require.resolve('@deepseek-ai/dsh-api-session-controller')),'types/client/sessions/assistant-stream.js')
  const executable=value=>value.replace(/^\/\/# sourceMappingURL=.*\r?\n?/gm,'')
  expect(executable(await readFile(new URL('../src/dsh/client-assistant-stream.js',import.meta.url),'utf8'))).toBe(executable(await readFile(original,'utf8')))
})
it('restores partial text and replaces it once the native committed settlement is released',()=>{
  const view=new HistoryPresentation('session',()=>run)
  const opening=view.accept(snapshot([],{revision:2,activeAttempt:{attemptId:'a',turn:1,step:1,startedAfterSeq:5,nextIndex:1,
    stream:[{type:'text-chunks',time0:1,index:0,dt:[],texts:['before']} ]}}))
  expect(opening.events[0].event.data).toMatchObject({text:'before',native_attempt:'a'})
  const delta=view.accept(frame({type:'chunk',attemptId:'a',revision:3,index:1,time:2,chunk:{type:'text-delta',index:0,text:' after'}}))
  expect(delta.events[0].event.data.text).toBe(' after')
  expect(view.accept(durable(6,'assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'before after'}]}})).events).toEqual([])
  const settled=view.accept(frame({type:'end',attemptId:'a',revision:4,index:2,outcome:{kind:'committed',eventType:'assistant/message',seq:6}}))
  expect(settled.retire_attempts).toContain('a')
  expect(settled.events.map(item=>item.event.event)).toEqual(['workbench_assistant_final','workbench_activity'])
  expect(settled.events[1].event).toMatchObject({_id:'history:session:6:1',data:{text:'before after'}})
})
it('preserves custom plugin display names in historical and live native tool records',()=>{
  const view=new HistoryPresentation('session',()=>run)
  const opened=view.accept(snapshot([durable(1,'tool/call',{turn:1,callId:'call',name:'mcp__search',arguments:'{}'})]))
  expect(opened.events[0].event.data).toMatchObject({provider_name:'法律资料',display_name:'检索'})
  const result=view.accept(durable(2,'tool/result',{turn:1,message:{source:{callId:'call'},content:[{type:'tool-result',content:[{type:'text',text:'result'}]}]}}))
  expect(result.events[0].event.data).toMatchObject({tool_name:'mcp__search',output:'result'})
})
it('retires abandoned output and requires a new baseline on a revision gap',()=>{
  const view=new HistoryPresentation('session',()=>run)
  view.accept(snapshot())
  view.accept(frame({type:'start',attemptId:'a',revision:1,turn:1,step:1,startedAfterSeq:0}))
  expect(view.accept(frame({type:'end',attemptId:'a',revision:2,index:0,outcome:{kind:'abandoned'}})).retire_attempts).toEqual(['a'])
  expect(()=>view.accept(frame({type:'start',attemptId:'b',revision:4,turn:1,step:1,startedAfterSeq:0}))).toThrow('fresh baseline')
})
