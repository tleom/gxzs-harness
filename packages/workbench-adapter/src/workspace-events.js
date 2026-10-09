// Snapshot transport over DSH-owned workspace/list notifications. Only one
// projection may be in flight; slow readers retain a single dirty bit.
export function streamWorkspaceEvents({ workspaces, owner, res, subscribe, heartbeatMs = 15000, drainTimeoutMs = 30000 }) {
  const abort = new AbortController()
  let dirty = true, pumping = false, blocked = false, closed = false
  let drainTimeout, scheduled, unsubscribe
  const finish = () => {
    if (closed) return
    closed = true
    abort.abort()
    clearInterval(heartbeat)
    clearTimeout(drainTimeout)
    clearImmediate(scheduled)
    unsubscribe?.()
    res.off('close', finish)
    res.off('error', finish)
    res.off('drain', drain)
    res.end()
  }
  const write = value => {
    if (closed) return
    if (!res.write(value)) {
      blocked = true
      drainTimeout = setTimeout(finish, drainTimeoutMs)
      drainTimeout.unref?.()
    }
  }
  const pump = async () => {
    scheduled = undefined
    if (closed || pumping || blocked || !dirty) return
    pumping = true
    dirty = false
    try {
      const value = await workspaces.baseline(owner, abort.signal)
      if (!closed) write(`data: ${JSON.stringify({ event: 'workspace_snapshot', value })}\n\n`)
    } catch { finish() }
    finally { pumping = false; if (dirty) schedule() }
  }
  const schedule = () => {
    if (!closed && !blocked && !pumping && !scheduled) scheduled = setImmediate(pump)
  }
  const changed = () => { dirty = true; schedule() }
  const drain = () => { blocked = false; clearTimeout(drainTimeout); schedule() }
  res.writeHead(200, { 'content-type':'text/event-stream; charset=utf-8', 'cache-control':'no-store', 'x-accel-buffering':'no' })
  res.on('close', finish); res.on('error', finish); res.on('drain', drain)
  const heartbeat = setInterval(() => { try { if (!blocked) write(': heartbeat\n\n') } catch { finish() } }, heartbeatMs)
  heartbeat.unref?.()
  try { unsubscribe = subscribe(changed) } catch { finish(); return finish }
  void (async () => {
    try { for await (const _frame of workspaces.controller.follow(abort.signal)) changed() }
    catch { if (!closed) finish() }
    finally { if (!closed) finish() }
  })()
  schedule()
  return finish
}
