import { encodeSse } from './http.js'

/** Carry DSH's snapshot/follow protocol without another event log or replay cursor. */
export async function streamHistoryEvents({ service, owner, chatId, res, heartbeatMs = 15000, drainTimeoutMs = 30000 }) {
  const abort = new AbortController()
  let heartbeat, drainTimeout, releaseDrain
  const close = () => { abort.abort(); releaseDrain?.() }
  res.on('close', close)
  res.on('error', close)
  const source = service.followHistory(owner, chatId, abort.signal)
  const write = async value => {
    if (abort.signal.aborted) return
    if (res.write(value) !== false) return
    await new Promise(resolve => {
      const drain = () => { clearTimeout(drainTimeout); res.off('drain', drain); releaseDrain = undefined; resolve() }
      releaseDrain = drain
      res.once('drain', drain)
      drainTimeout = setTimeout(close, drainTimeoutMs)
      drainTimeout.unref?.()
      if (abort.signal.aborted) drain()
    })
  }
  try {
    // Authorization and native opening failures retain their actual HTTP status.
    const first = await source.next()
    if (abort.signal.aborted) return
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store', 'x-accel-buffering': 'no' })
    heartbeat = setInterval(() => {
      if (releaseDrain || abort.signal.aborted) return
      try { if (res.write(': heartbeat\n\n') === false) close() }
      catch { close() }
    }, heartbeatMs)
    heartbeat.unref?.()
    if (!first.done) await write(encodeSse(first.value))
    while (!first.done && !abort.signal.aborted) {
      const next = await source.next()
      if (next.done) break
      await write(encodeSse(next.value))
    }
  } catch (error) {
    if (!abort.signal.aborted && !res.headersSent) throw error
    // Reopening receives a fresh native baseline; never invent a success frame.
  } finally {
    close()
    clearInterval(heartbeat)
    clearTimeout(drainTimeout)
    res.off('close', close)
    res.off('error', close)
    await source.return?.()
    if (res.headersSent && !res.writableEnded) res.end()
  }
}
