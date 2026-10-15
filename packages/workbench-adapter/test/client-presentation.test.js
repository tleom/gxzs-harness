import { expect, it } from 'vitest'
import { presentSessionWindow } from '../src/client/index.js'

const context = { sessionId: 'child', chatId: 'chat', parentSessionId: 'parent', running: false }
const record = (type, seq, data, extra = {}) => ({ type: 'event', event: { type, seq, time: 1000 + seq, data, ...extra } })
it('projects messages, tool results, native notices and stopped turns without adding a journal or consuming the source', () => {
  const entries = [record('turn/start', 0, { turn: 1 }),
    record('user/message', 1, { turn: 1, id: 'message', source: { kind: 'user' }, content: [{ type: 'text', text: 'work' }] }),
    record('tool/call', 2, { turn: 1, callId: 'call', name: 'edit', arguments: '{}' }),
    record('tool/result', 3, { turn: 1, message: { source: { callId: 'call' }, content: [{ type: 'text', text: 'done' }] } }),
    record('assistant/message', 4, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'finished' }] } }),
    record('turn/end', 5, { turn: 1, reason: { kind: 'interrupted' } })]
  const before = JSON.stringify(entries)
  const [run] = presentSessionWindow(entries, context)
  expect(run.query).toBe('work')
  expect(run.status).toBe('interrupted')
  expect(run.events.find(value => value.data?.stage === 'returned').data.tool_name).toBe('edit')
  expect(run.events.some(value => value.data?.text === 'finished')).toBe(true)
  expect(JSON.stringify(entries)).toBe(before)
  expect(presentSessionWindow(entries, context)).toEqual([run])
})
it('uses the native window after transient retirement instead of keeping a second stale text buffer', () => {
  const start = record('turn/start', 0, { turn: 1 })
  const live = { type: 'transient', event: { type: 'assistant/live-chunk', seq: 0.5, time: 2,
    data: { turn: 1, step: 1, attemptId: 'attempt', chunk: { type: 'text-delta', index: 0, text: 'draft' } } } }
  const final = record('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final' }] } })
  expect(presentSessionWindow([start, live], context)[0].events[0].data.text).toBe('draft')
  const [retained] = presentSessionWindow([start, live, final], context)
  expect(retained.events.filter(value => ['text','reasoning'].includes(value.data?.kind))).toHaveLength(1)
  expect(retained.events.some(value => value.event === 'workbench_assistant_final' && value.has_reply)).toBe(true)
  const [settled] = presentSessionWindow([start, final], context)
  expect(settled.events.some(value => value.data?.text === 'draft')).toBe(false)
  expect(settled.events.some(value => value.data?.text === 'final')).toBe(true)
})
