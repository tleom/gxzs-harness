import { httpError } from './http.js'

// Same window as DSH Session.loadOlder. The native controller owns the cut,
// source-message grouping, surface replacement records and cold-session reads.
export const historyWindow = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }

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
    const observation = await sessionQuery.observeSession(sessionId, { signal })
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
  return {
    through_seq: throughSeq,
    records: page.records,
    cursor: page.hasMore ? { sessionId, throughSeq, beforeSeq } : null,
  }
}
