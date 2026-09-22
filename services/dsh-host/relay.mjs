import http from 'node:http'

// Expose only the signed adapter API. DSH's native UI/API stays on loopback.
http.createServer((req, res) => {
  if (!req.url?.startsWith('/ai/workbench/')) { res.writeHead(404); res.end(); return }
  const upstream = http.request({ host: '127.0.0.1', port: 3080, path: req.url, method: req.method, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode, response.headers)
    response.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end() })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}).listen(3081, '0.0.0.0')
