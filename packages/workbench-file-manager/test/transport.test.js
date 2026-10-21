import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { FileManagerClient } from '../src/index.js'
import { managerFetch } from '../src/transport.js'

const servers = [], directories = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)) }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
async function listen(server) {
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

it.each([3, 4, 5, 10])('retains backpressured bodies after FIN during %i concurrent responses', async count => {
  const bytes = Buffer.alloc(64 * 1024, 97)
  const base = await listen(createTcpServer(socket => socket.once('data', () => {
    socket.end(Buffer.concat([Buffer.from(`HTTP/1.0 200 OK\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`), bytes]))
  })))
  const responses = await Promise.all(Array.from({ length: count }, () => managerFetch(base)))
  await delay(100)
  for (const response of responses) expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
})

it.each([3, 4, 5, 10])('uploads %i small files through the default client without replay or shared body corruption', async count => {
  const received = []
  const base = await listen(createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks), newline = body.indexOf(10)
    const metadata = JSON.parse(body.subarray(0, newline).toString())
    received.push([metadata.path, body.subarray(newline + 1).toString()])
    const bytes = Buffer.from(JSON.stringify({ ok: true, padding: 'a'.repeat(64 * 1024) }))
    response.writeHead(200, { 'content-length': bytes.length, connection: 'close' }); response.end(bytes)
  }))
  for (const [key, value] of Object.entries({ TEST_MANAGER_TOKEN: 'fixture', GXZS_HOST_OWNER_ID: 't:1', GXZS_HOST_GENERATION: '1', GXZS_HOST_INSTANCE_ID: 'host-1' })) vi.stubEnv(key, value)
  const client = new FileManagerClient({ baseUrl: base, workspaceId: '00000000-0000-4000-8000-000000000001', tokenEnv: 'TEST_MANAGER_TOKEN' })
  const directory = await mkdtemp(join(tmpdir(), 'gxzs-batch-')); directories.push(directory)
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    const path = join(directory, String(i)), value = `file-${i}`; await writeFile(path, value)
    await expect(client.upload('files', { path, size: Buffer.byteLength(value), offset: 0, metadata: { operation: 'upload', path: `${i}.txt` } })).resolves.toMatchObject({ ok: true })
  }))
  expect(received.sort()).toEqual(Array.from({ length: count }, (_, i) => [`${i}.txt`, `file-${i}`]))
})

it('rejects truncated bodies and aborts a stalled response without process-level errors', async () => {
  const base = await listen(createServer((_request, response) => {
    response.writeHead(200, { 'content-length': 1024, connection: 'close' }); response.write('partial')
  }))
  const abort = new AbortController(), response = await managerFetch(base, { signal: abort.signal })
  const reading = response.arrayBuffer(); abort.abort()
  await expect(reading).rejects.toThrow()
  const truncated = await listen(createTcpServer(socket => socket.once('data', () => socket.end('HTTP/1.0 200 OK\r\nContent-Length: 1024\r\n\r\npartial'))))
  const result = await managerFetch(truncated)
  await expect(result.arrayBuffer()).rejects.toThrow()
})

it('keeps response backpressure bounded in bytes while the download consumer pauses', async () => {
  const size = 32 * 1024 * 1024, chunk = Buffer.alloc(64 * 1024)
  let sent = 0
  const base = await listen(createServer(async (_request, response) => {
    response.writeHead(200, { 'content-length': size, connection: 'close' })
    while (sent < size) { sent += chunk.length; if (!response.write(chunk)) await once(response, 'drain') }
    response.end()
  }))
  const response = await managerFetch(base)
  await delay(100)
  expect(sent).toBeLessThan(size)
  let received = 0
  for await (const part of response.body) received += part.byteLength
  expect(received).toBe(size)
})

it('does not follow redirects with the owner bearer or continue an aborted upload', async () => {
  let redirected = false
  const target = await listen(createServer((_request, response) => { redirected = true; response.end() }))
  const base = await listen(createServer((_request, response) => { response.writeHead(302, { location: target }); response.end() }))
  await expect(managerFetch(base, { redirect: 'error', headers: { authorization: 'Bearer fixture' } })).rejects.toThrow('redirect')
  expect(redirected).toBe(false)
  const abort = new AbortController(); abort.abort()
  await expect(managerFetch(base, { method: 'POST', body: Readable.from(['small']), signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
})
