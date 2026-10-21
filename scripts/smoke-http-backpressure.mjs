import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { managerFetch } from '/opt/workbench/packages/workbench-file-manager/src/transport.js'

const bytes = Buffer.alloc(64 * 1024, 97)
const server = createServer(socket => socket.once('data', () => {
  socket.end(Buffer.concat([Buffer.from(`HTTP/1.0 200 OK\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`), bytes]))
}))
server.listen(0, '127.0.0.1'); await once(server, 'listening')
try {
  const url = `http://127.0.0.1:${server.address().port}`
  for (const count of [3, 4, 5, 10]) {
    const responses = await Promise.all(Array.from({ length: count }, () => managerFetch(url)))
    await delay(100)
    for (const response of responses) assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  }
  console.log('PASS production Node HTTP: 3/4/5/10 non-keepalive backpressured responses survive FIN without Parser.finish crash')
} finally { await new Promise(resolve => server.close(resolve)) }
