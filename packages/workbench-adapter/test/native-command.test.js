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
