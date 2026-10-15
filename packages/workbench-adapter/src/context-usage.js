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

function pick(value, fields) {
  return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
}
