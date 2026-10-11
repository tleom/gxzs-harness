import { decodeCursor } from './cursor.js'
import { encodeSse, httpError } from './http.js'
import { presentRunEvent } from './run-failure.js'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'steered'])

export function streamRunEvents({ database, eventBus, ownerId, runId, cursor, req, res,
  heartbeatMs = 15_000, drainTimeoutMs = 30_000, pageSize = 256 }) {
  const run = database.getRun(ownerId, runId)
  if (!run) throw httpError(404, '任务不存在')
  let sequence = decodeCursor(cursor)
  if (sequence > run.seq) throw httpError(400, '事件游标超过任务最新位置')
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  })
  let closed = false
  let heartbeat
  let drainTimeout
  let scheduled
  let unsubscribe
  let blocked = false
  let pumping = false
  const finish = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    clearTimeout(drainTimeout)
    clearImmediate(scheduled)
    unsubscribe?.()
    req?.off?.('close', finish)
    req?.off?.('aborted', finish)
    res.off?.('close', finish)
    res.off?.('error', finish)
    res.off?.('drain', drain)
    res.end()
  }
  const pause = () => {
    blocked = true
    drainTimeout = setTimeout(finish, drainTimeoutMs)
    drainTimeout.unref?.()
  }
  const schedule = () => {
    if (closed || blocked || scheduled) return
    scheduled = setImmediate(() => { scheduled = undefined; pump() })
  }
  // The durable event log is the queue. A slow socket never accumulates live
  // events in memory; drain resumes from the last accepted cursor.
  const pump = () => {
    if (closed || blocked || pumping) return
    pumping = true
    try {
      const page = database.eventsAfter(ownerId, runId, sequence, Math.max(1, Math.min(pageSize, 1000)))
      for (const entry of page) {
        const accepted = res.write(encodeSse(presentRunEvent(entry)))
        sequence = decodeCursor(entry._id)
        if (closed) return
        if (accepted === false) { pause(); return }
      }
      const latest = database.getRun(ownerId, runId)
      if (!latest) { finish(); return }
      if (sequence < latest.seq) schedule()
      else if (TERMINAL.has(latest.status) || latest.status === 'waiting_input') finish()
    } catch { finish() }
    finally { pumping = false }
  }
  const drain = () => {
    if (!blocked || closed) return
    clearTimeout(drainTimeout)
    blocked = false
    pump()
  }
  unsubscribe = eventBus.subscribe(runId, pump)
  req?.on?.('close', finish)
  req?.on?.('aborted', finish)
  res.on?.('close', finish)
  res.on?.('error', finish)
  res.on?.('drain', drain)
  pump()
  if (!closed) {
    heartbeat = setInterval(() => {
      if (blocked) return
      try { if (res.write(': keepalive\n\n') === false) pause() }
      catch { finish() }
    }, heartbeatMs)
    heartbeat.unref?.()
  }
  return finish
}
