import { expect, it } from 'vitest'
import { nativeCommandRecords } from '../src/native-command.js'

it('projects durable native command outcomes in session order without storing a second lifecycle', () => {
  const events = [
    { type: 'command/run', seq: 0, data: { commandId: 'plan', name: 'plan', args: 'Inspect records' } },
    { type: 'command/done', seq: 1, data: { commandId: 'plan', kind: 'success', text: 'Plan mode on.' } },
    { type: 'command/run', seq: 8, data: { commandId: 'compact', name: 'compact' } },
    { type: 'command/done', seq: 10, data: { commandId: 'compact', kind: 'error', text: 'Compaction cancelled.' } },
    { type: 'command/run', seq: 11, data: { commandId: 'pending', name: 'compact' } },
  ]
  expect(nativeCommandRecords(events, [{ id: 'run', sourceStartSeq: 2 }])).toEqual([
    { id: 'plan', name: 'plan', args: 'Inspect records', before_run_id: 'run', outcome: events[1].data },
    { id: 'compact', name: 'compact', args: undefined, before_run_id: null, outcome: events[3].data },
    { id: 'pending', name: 'compact', args: undefined, before_run_id: null, outcome: null },
  ])
})

it('folds each manual checkpoint and its own summary into one durable command', () => {
  const events = [
    { type: 'command/run', seq: 1, data: { name: 'compact', commandId: 'c' } },
    { type: 'compaction/summary', seq: 2, data: { compactionId: 'x', sourceCommandId: 'c', shadowedSeqs: [0], shadowedTokenCount: 100, summary: [{ type: 'text', text: '摘要' }] } },
    { type: 'user/message', seq: 3, surfaceOp: { op: 'replace' }, data: { source: { kind: 'compact-checkpoint', compactionId: 'x', sourceCommandId: 'c' } } },
    { type: 'command/done', seq: 4, data: { commandId: 'c', kind: 'success', text: 'done' } },
  ]
  expect(nativeCommandRecords(events, [{ id: 'next', sourceStartSeq: 5 }])).toEqual([
    expect.objectContaining({ id: 'c', before_run_id: 'next', compaction: { summary: '摘要', items: 1, tokens: 100 }, outcome: expect.objectContaining({ kind: 'success' }) }),
  ])
})
