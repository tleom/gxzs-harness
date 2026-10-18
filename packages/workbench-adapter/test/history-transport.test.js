import { expect, it } from 'vitest'
import { HistoryPresentation } from '../src/history-presentation.js'
import { historyDisplayEvent, historyFrameMetadata } from '../src/history-transport.js'

it('sends tool content once while retaining paging, steering and native coordinates', () => {
  const payload = '合成大正文😀'.repeat(100_000)
  const records = [
    { event: { seq: 20, time: 1000, type: 'user/message', data: {
      turn: 1, id: 'm', source: { kind: 'user', rpcId: 'steering' }, content: [{ type: 'text', text: '补充' }],
    }, surfaceOp: 'append' } },
    { event: { seq: 21, time: 1001, type: 'tool/call', data: {
      turn: 1, callId: 'write', name: 'write', arguments: { file_path: 'large.txt', content: payload },
    }, surfaceOp: 'append' } },
  ]
  const original = JSON.stringify(records)
  const frame = { type: 'snapshot', cursor: 21, hasMore: true, records, assistantStream: { revision: 0 } }
  const display = new HistoryPresentation('session', () => ({ id: 'run', selection: {} })).accept(frame)
  const wire = { value: historyFrameMetadata(frame), display }
  expect(wire.value).toEqual({ type: 'snapshot', cursor: 21, hasMore: true, records: [
    { event: { seq: 20, type: 'user/message', data: { source: { rpcId: 'steering' } } } },
    { event: { seq: 21, type: 'tool/call' } },
  ] })
  const tool = display.events.find(item => item.event.data?.tool_name === 'write').event
  expect(JSON.parse(tool.data.input).content).toBe(payload)
  expect(tool.native).toEqual({ seq: 21, time: 1001, type: 'tool/call', surfaceOp: 'append', turn: 1 })
  expect(JSON.stringify(wire).split(payload)).toHaveLength(2)
  expect(JSON.stringify(records)).toBe(original)
})

it('retains consumed steering metadata in deltas without sending the source body', () => {
  const frame = { type: 'event', event: { seq: 7, type: 'user/message', data: {
    source: { rpcId: 'queued-message', kind: 'agent-message' }, content: [{ type: 'text', text: 'body' }],
  } } }
  expect(historyFrameMetadata(frame)).toEqual({ type: 'event', event: {
    seq: 7, type: 'user/message', data: { source: { rpcId: 'queued-message' } },
  } })
  expect(historyFrameMetadata({ type: 'assistant-stream', frame: { chunk: { argumentsDelta: 'body' } } })).toEqual({ type: 'assistant-stream' })
  expect(frame.event.data.content[0].text).toBe('body')
})

it('keeps existing display payloads and native replacement coordinates unchanged', () => {
  const source = { event: 'workbench_activity', data: { output: 'result' }, native: {
    seq: 42, time: 100, type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 8, endSeq: 9 },
    data: { turn: 3, message: { content: [{ text: 'result' }] } },
  } }
  const result = historyDisplayEvent(source)
  expect(result.data).toBe(source.data)
  expect(result.native).toEqual({ seq: 42, time: 100, type: 'tool/result', turn: 3, surfaceOp: source.native.surfaceOp })
  expect(source.native.data.message.content[0].text).toBe('result')
})
