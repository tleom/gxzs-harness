import http from 'node:http'
import { pathToFileURL } from 'node:url'

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
function endToEndHeaders(headers) {
  const connection = String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())
  const excluded = new Set([...HOP_HEADERS, ...connection])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())))
}

// Expose only the signed adapter API. DSH's native UI/API stays on loopback.
export function createRelayServer({ host = '127.0.0.1', port = 3080 } = {}) {
  return http.createServer((req, res) => {
    if (!req.url?.startsWith('/ai/workbench/')) { res.writeHead(404); res.end(); return }
    // Connection lifetime belongs to each hop. Forwarding a client's `close`
    // while SSE advertises `keep-alive` can reuse an already-closed parser.
    // A busy native event loop can expire an idle socket before reading the next
    // request already queued on it. A fresh loopback connection avoids that race
    // without replaying a POST whose effects may already have been accepted.
    const upstream = http.request({ host, port, agent: false, path: req.url, method: req.method, headers: endToEndHeaders(req.headers) }, (response) => {
      res.writeHead(response.statusCode, endToEndHeaders(response.headers))
      response.on('error', () => res.destroy())
      response.pipe(res)
    })
    upstream.on('error', (error) => {
      if (res.headersSent) res.destroy()
      else if (!res.destroyed) {
        console.warn(JSON.stringify({ event: 'workbench-relay-error', code: error.code ?? 'UPSTREAM_ERROR' }))
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ code: 'WORKBENCH_HOST_UNAVAILABLE', message: '工作台连接暂时中断，请稍后重试' }))
      }
    })
    res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
    req.pipe(upstream)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createRelayServer().listen(3081, '0.0.0.0')
