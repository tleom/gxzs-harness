import { decodeCursor } from './cursor.js'
import { encodeSse, httpError } from './http.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered'])

export function streamRunEvents({ database, eventBus, ownerId, runId, cursor, req, res, heartbeatMs = 15_000 }) {
  const run = database.getRun(ownerId, runId)
  if (!run) throw httpError(404, '任务不存在')
  let sequence = decodeCursor(cursor)
  if (sequence > run.seq) throw httpError(400, '事件游标超过任务最新位置')
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  })
  let closed = false
  let replaying = true
  let heartbeat
  let unsubscribe
  const queued = []
  const finish = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe?.()
    req?.off?.('close', finish)
    req?.off?.('aborted', finish)
    res.off?.('close', finish)
    res.off?.('error', finish)
    res.end()
  }
  const write = (entry) => {
    if (closed) return
    const current = entry._id ? decodeCursor(entry._id) : undefined
    if (current !== undefined && current <= sequence) return
    res.write(encodeSse(entry))
    if (current !== undefined) sequence = current
  }
  const live = (entry) => {
    if (replaying) { queued.push(entry); return }
    try {
      write(entry)
      if (entry.event === 'workbench_end' || (entry.event === 'workbench_status' && entry.status === 'waiting_input')) finish()
    } catch { finish() }
  }
  unsubscribe = eventBus.subscribe(runId, live)
  req?.on?.('close', finish)
  req?.on?.('aborted', finish)
  res.on?.('close', finish)
  res.on?.('error', finish)
  try {
    while (!closed) {
      const page = database.eventsAfter(ownerId, runId, sequence, 1000)
      if (page.length === 0) break
      for (const entry of page) write(entry)
    }
    replaying = false
    for (const entry of queued) live(entry)
    const latest = database.getRun(ownerId, runId)
    if (TERMINAL.has(latest.status)) {
      finish()
    } else if (latest.status === 'waiting_input') {
      finish()
    } else if (!closed) {
      heartbeat = setInterval(() => {
        try { res.write(': keepalive\n\n') }
        catch { finish() }
      }, heartbeatMs)
      heartbeat.unref?.()
    }
  } catch (error) {
    finish()
    throw error
  }
  return finish
}
