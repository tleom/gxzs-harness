import { httpError } from './http.js'

// Same window as DSH Session.loadOlder. The native controller owns the cut,
// source-message grouping, surface replacement records and cold-session reads.
export const historyWindow = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }

/** Native pagination counts log metadata too; the UI only offers earlier display content. */
export async function hasEarlierContent(sessions, sessionId, throughSeq, beforeSeq, signal) {
  let before = beforeSeq
  while (before > 0) {
    const page = await sessions.page({ address: { kind: 'session', sessionId },
      throughSeq, beforeSeq: before, maxMessages: 1 }, signal)
    signal.throwIfAborted()
    if (page.records.some(({ event }) =>
      ['assistant/message', 'tool/call', 'tool/result', 'compaction/summary', 'workspace/changes', 'deliverables/presented'].includes(event.type)
      || (event.type === 'user/message' && ['user', 'goal', 'schedule'].includes(event.data?.source?.kind)))) return true
    if (!page.hasMore) return false
    const next = page.records[0]?.event.seq
    if (!Number.isSafeInteger(next) || next >= before) throw httpError(502, '历史消息分页未向前推进')
    before = next
  }
  return false
}

/** Read one native history window after the caller has authorized the chat. */
export async function loadNativeHistoryPage({ sessions, sessionQuery }, sessionId, cursor, signal) {
  signal.throwIfAborted()
  if (cursor !== undefined && (!cursor || typeof cursor !== 'object'
    || cursor.sessionId !== sessionId
    || !Number.isSafeInteger(cursor.throughSeq) || cursor.throughSeq < -1
    || !Number.isSafeInteger(cursor.beforeSeq) || cursor.beforeSeq < 0
    || cursor.beforeSeq > cursor.throughSeq + 1)) {
    throw httpError(400, '历史消息游标无效，请重新打开对话')
  }
  let throughSeq = cursor?.throughSeq
  if (throughSeq === undefined) {
    // Only the log cursor is needed here; avoid reconstructing every projection
    // before the native controller reads the requested page.
    const observation = await sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
    try {
      signal.throwIfAborted()
      throughSeq = observation.events.at(-1)?.seq ?? -1
    } finally { observation[Symbol.dispose]() }
  }
  const page = await sessions.page({
    address: { kind: 'session', sessionId }, throughSeq,
    ...(cursor ? { beforeSeq: cursor.beforeSeq } : {}),
    ...historyWindow,
  }, signal)
  signal.throwIfAborted()
  const beforeSeq = page.records[0]?.event.seq
  if (page.hasMore && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1
    || beforeSeq >= (cursor?.beforeSeq ?? throughSeq + 1))) {
    throw httpError(502, '历史消息分页未向前推进')
  }
  const more = page.hasMore && await hasEarlierContent(sessions, sessionId, throughSeq, beforeSeq, signal)
  return {
    through_seq: throughSeq,
    records: page.records,
    cursor: more ? { sessionId, throughSeq, beforeSeq } : null,
  }
}
