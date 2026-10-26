import { describe, expect, it } from 'vitest'
import { presentContextPressure } from '../src/context-usage.js'

const pressure = { pressureTokens: 424564, projectedTokens: 176173, contextWindow: 1050000 }
const breakdown = { systemTokens: 4084, toolsTokens: 10194, messageTokens: 1652 }
const usage = { inputTokens: 19800, outputTokens: 100 }
const sample = { type: 'assistant/message', data: { usage, stream: [] } }
const compact = type => [
  { type, data: { shadowedRange: { start: 10, end: 174 }, shadowedTokenCount: 250043 } },
  { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 10, endSeq: 174 }, data: {} },
]

describe('context occupancy after compaction', () => {
  it.each(['compaction/summary', 'compaction/prune'])('uses the native retained estimate after %s without changing native state', type => {
    const events = [sample, ...compact(type), { type: 'compaction/end', data: {} }]
    const result = presentContextPressure(events, pressure, breakdown)
    expect(result).toEqual({ ...pressure, projectedTokens: 15930 })
    expect(pressure.projectedTokens).toBe(176173)
    expect(presentContextPressure(events, pressure, { ...breakdown, messageTokens: 2000 }).projectedTokens).toBe(16278)
  })

  it.each([
    sample,
    { type: 'assistant/attempt', data: { stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] } },
    { type: 'assistant/message', data: { stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] } },
  ])('restores provider-anchored occupancy after fresh usage', event => {
    const current = { pressureTokens: 19800, projectedTokens: 19900, contextWindow: 1050000 }
    expect(presentContextPressure([...compact('compaction/summary'), event], current, breakdown)).toBe(current)
  })

  it('does not treat a failed, unfinished or unrelated replacement as completed compaction', () => {
    const [summary, replacement] = compact('compaction/summary')
    for (const events of [[], [sample], [summary], [summary, { type: 'compaction/error' }],
      [replacement], [summary, { ...replacement, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 9 } }]]) {
      expect(presentContextPressure(events, pressure, breakdown)).toBe(pressure)
    }
  })

  it('keeps estimating across usage-free output and another compaction, but requires native projections', () => {
    const events = [...compact('compaction/summary'), { type: 'assistant/message', data: { stream: [] } }]
    expect(presentContextPressure(events, pressure, breakdown).projectedTokens).toBe(15930)
    expect(presentContextPressure([...events, sample, ...compact('compaction/prune')], pressure, breakdown).projectedTokens).toBe(15930)
    expect(presentContextPressure(events, pressure, undefined)).toBe(pressure)
    expect(presentContextPressure(events, null, breakdown)).toBeNull()
  })
})
