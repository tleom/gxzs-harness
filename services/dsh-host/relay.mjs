import http from 'node:http'

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']
function endToEndHeaders(headers) {
  const connection = String(headers.connection ?? '').split(',').map(value => value.trim().toLowerCase())
  const excluded = new Set([...HOP_HEADERS, ...connection])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())))
}

// Expose only the signed adapter API. DSH's native UI/API stays on loopback.
http.createServer((req, res) => {
  if (!req.url?.startsWith('/ai/workbench/')) { res.writeHead(404); res.end(); return }
  // Connection lifetime belongs to each hop. Forwarding a client's `close`
  // while SSE advertises `keep-alive` can reuse an already-closed parser.
  const upstream = http.request({ host: '127.0.0.1', port: 3080, path: req.url, method: req.method, headers: endToEndHeaders(req.headers) }, (response) => {
    res.writeHead(response.statusCode, endToEndHeaders(response.headers))
    response.on('error', () => res.destroy())
    response.pipe(res)
  })
  upstream.on('error', () => {
    if (res.headersSent) res.destroy()
    else { res.writeHead(503); res.end() }
  })
  res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
  req.pipe(upstream)
}).listen(3081, '0.0.0.0')
