import { EventEmitter } from 'node:events'
import { errorResponse, httpError } from './http.js'

const maxSources = 48
const maxQueued = 32 * 1024 * 1024
const maxPiece = 16 * 1024
const sseHeaders = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store', 'x-accel-buffering': 'no',
}
const id = '[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}'
const sourcePath = new RegExp('^(?:native/sessions/(?:control|events)|workspaces/events|'
  + `chats/${id}/(?:events|native/session/follow|jobs(?:/[\\w-]{1,128})?/events)|runs/${id}/events|`
  + `browsers/${id}/events|chats/(?:${id}|draft:(?:${id}|[a-fA-F0-9]{32}))/terminals/${id}/events)$`)

function selectSources(sources, routes) {
  if (!Array.isArray(sources) || sources.length > maxSources)
    throw httpError(400, '工作台订阅数量无效')
  const ids = new Set()
  return sources.map(source => {
    if (!source || typeof source.id !== 'string' || !/^[0-9]{1,12}$/.test(source.id) || ids.has(source.id)
      || typeof source.path !== 'string' || source.path.length > 8192 || /[\u0000-\u001f\u007f#]/.test(source.path))
      throw httpError(400, '工作台订阅标识无效')
    ids.add(source.id)
    const [path] = source.path.split('?')
    if (!sourcePath.test(path)) throw httpError(400, '工作台订阅类型无效')
    const url = new URL(`/${source.path}`, 'http://workbench')
    const route = routes.find(([method, pattern]) => method === 'GET' && pattern.test(url.pathname))
    if (!route) throw httpError(400, '工作台订阅类型无效')
    return { id: source.id, path: source.path, url, route }
  })
}

export function openWorkbenchStreams({ context, res, routes, onClose, heartbeatMs = 15_000 }) {
  const initial = selectSources(context.json.sources, routes)
  const channels = new Map()
  const queue = []
  let queued = 0, writing = false, closed = false, timer, drainTimeout
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    clearTimeout(drainTimeout)
    queue.length = 0
    for (const channel of channels.values()) channel.emit('close')
    channels.clear()
    onClose()
    res.off('drain', drain)
    res.off('close', close)
    res.off('error', close)
    if (!res.destroyed && !res.writableEnded) res.end()
  }
  const enqueue = (frame, onWritten) => {
    if (closed) return
    const size = frame.chunk?.length ?? 128
    if (size + queued > maxQueued) { close(); return }
    queued += size
    queue.push({ frame, size, offset: 0, onWritten })
    flush()
  }
  const flush = () => {
    if (writing || closed) return
    while (queue.length && !writing && !closed) {
      const item = queue[0]
      const frame = item.frame
      const limit = item.offset + maxPiece
      const piece = frame.chunk === undefined ? frame : { id: frame.id, chunk: frame.chunk.slice(item.offset, limit) }
      try {
        writing = !res.write(`data: ${JSON.stringify(piece)}\n\n`)
      } catch { close(); return }
      item.offset = limit
      if (item.offset >= (frame.chunk?.length ?? 0)) {
        queue.shift()
        queued -= item.size
        if (item.onWritten) setImmediate(item.onWritten)
      }
      if (writing) {
        drainTimeout = setTimeout(close, 30_000)
        drainTimeout.unref?.()
      }
    }
  }
  const drain = () => { clearTimeout(drainTimeout); writing = false; flush() }
  res.writeHead(200, sseHeaders)
  res.on('drain', drain)
  res.on('close', close)
  res.on('error', close)
  timer = setInterval(() => {
    if (!writing && !queue.length && !closed) enqueue({ heartbeat: true })
  }, heartbeatMs)
  timer.unref?.()
  enqueue({ ready: true })

  const attach = item => {
    const channel = new EventEmitter()
    channels.set(item.id, channel)
    channel.path = item.path
    channel.headersSent = false
    channel.writeHead = () => { channel.headersSent = true }
    Object.defineProperty(channel, 'destroyed', { get: () => closed || channel.writableEnded })
    channel.write = chunk => {
      if (closed || channel.writableEnded) return false
      // Child probes share the multiplexed heartbeat and drain window.
      if (chunk.startsWith(':')) return true
      enqueue({ id: item.id, chunk }, () => {
        if (!closed && !channel.writableEnded) channel.emit('drain')
      })
      return false
    }
    channel.end = () => {
      if (channel.writableEnded) return
      channel.writableEnded = true
      if (channels.get(item.id) === channel) enqueue({ id: item.id, end: true })
    }
    const [, pattern, handler] = item.route
    Promise.resolve().then(() => {
      if (!closed && !channel.writableEnded)
        return handler({ owner: context.owner, req: { headers: {} }, url: item.url }, channel, pattern.exec(item.url.pathname))
    }).catch(error => {
      if (channel.writableEnded || closed) return
      const failure = errorResponse(error)
      enqueue({ id: item.id, status: failure.status, code: failure.body.code })
      channel.end()
    })
  }
  const apply = selected => {
    const remaining = new Map(selected.map(item => [item.id, item]))
    for (const [id, channel] of channels) {
      const keep = remaining.get(id)
      if (keep?.path === channel.path) {
        remaining.delete(id)
        continue
      }
      channels.delete(id)
      channel.emit('close')
      channel.end()
    }
    for (const item of remaining.values()) {
      if (closed) break
      attach(item)
    }
  }
  apply(initial)
  return { close, replace: sources => apply(selectSources(sources, routes)) }
}
