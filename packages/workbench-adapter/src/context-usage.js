import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'

const readingFields = ['used_tokens', 'window_tokens', 'estimated', 'model']
const eventFields = ['event', '_id', 'workbench_run_id', 'phase', ...readingFields,
  'compaction_id', 'before_tokens', 'after_tokens', 'summary', 'items', 'tokens', 'error', 'occurred_at']

/** Execution/admission context contains the private frozen tool catalog too. */
export function contextUsage(value) {
  if (value?.used_tokens === undefined) return undefined
  return pick(value, readingFields)
}

/** Bound legacy snapshots on read; the durable source record stays untouched. */
export function presentContextEvent(event) {
  return pick(event, eventFields)
}

/** After a metered replacement, display DSH's retained composition until fresh provider usage arrives. */
export function presentContextPressure(events, pressure, breakdown) {
  if (!pressure || !breakdown) return pressure ?? null
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const usage = event.type === 'assistant/message' && event.data.usage
        || lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
      if (usage) return pressure
    }
    const previous = events[index - 1]
    const op = event.surfaceOp
    if (op?.op === 'replace'
      && ['compaction/summary', 'compaction/prune'].includes(previous?.type)
      && op.startSeq === previous.data.shadowedRange.start
      && op.endSeq === previous.data.shadowedRange.end) {
      return { ...pressure, projectedTokens: breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens }
    }
  }
  return pressure
}

function pick(value, fields) {
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}
