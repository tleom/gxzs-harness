/** The UI consumes display payloads, plus native coordinates for paging/steering.
 * Keep the original native records intact for the controller and presentation. */
export function historyEventMetadata(event) {
  const rpcId = event.type === 'user/message' ? event.data?.source?.rpcId : undefined
  return { seq: event.seq, type: event.type,
    ...(typeof rpcId === 'string' ? { data: { source: { rpcId } } } : {}) }
}

export function historyFrameMetadata(frame) {
  if (frame.type === 'snapshot') return {
    type: frame.type, cursor: frame.cursor, hasMore: frame.hasMore,
    records: frame.records.map(({ event }) => ({ event: historyEventMetadata(event) })),
  }
  if (frame.type === 'event') return { type: frame.type, event: historyEventMetadata(frame.event) }
  return { type: frame.type }
}

/** Same native coordinates retained by the UI's prepareRunEvent. The projected
 * input/output already holds the content; sending native.data repeats it. */
export function historyDisplayEvent(event) {
  if (!event.native || typeof event.native !== 'object' || !('data' in event.native)) return event
  const { data, ...coordinates } = event.native
  return { ...event, native: { ...coordinates, ...(Number.isInteger(data?.turn) ? { turn: data.turn } : {}) } }
}
