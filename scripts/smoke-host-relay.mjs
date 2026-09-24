#!/usr/bin/env node
// Run in an isolated host image with --network none. No credentials or model calls.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const errors = []
const requests = []
let hangClosed = false
const upstream = http.createServer(async (req, res) => {
  for await (const chunk of req) { /* Match the adapter's request-body admission. */ }
  requests.push({ url: req.url, headers: req.headers })
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive, x-upstream-hop',
    'x-upstream-hop': 'must-not-leak', 'x-end-to-end': 'preserved' })
  if (req.url.endsWith('/hang')) {
    res.on('close', () => { hangClosed = true })
    res.write('id: 1-0\ndata: {}\n\n')
  } else if (req.url.endsWith('/abort')) {
    res.write('id: 1-0\ndata: {}\n\n')
    setTimeout(() => res.destroy(), 10)
  } else {
    const cursor = req.headers['last-event-id'] || new URL(req.url, 'http://fixture').searchParams.get('cursor') || '0-0'
    const sequence = Number(cursor.split('-')[0])
    res.end([1, 2].filter(value => value > sequence).map(value => `id: ${value}-0\ndata: {}\n\n`).join(''))
  }
})
upstream.on('clientError', (error, socket) => {
  errors.push(error.code)
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
})
let child
const pooled = new http.Agent({ keepAlive: true })
async function request(path, headers, { agent = false, abort = false, expectAborted = false } = {}) {
  return new Promise((resolve, reject) => {
    const call = http.get({ host: '127.0.0.1', port: 3081, path, headers, agent }, response => {
      if (abort) {
        response.once('data', () => { response.destroy(); resolve({ status: response.statusCode, headers: response.headers }) })
        return
      }
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.once('error', error => expectAborted ? resolve({ aborted: true }) : reject(error))
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body, aborted: false }))
    })
    call.once('error', reject)
    call.setTimeout(5000, () => call.destroy(new Error('Relay request timed out')))
  })
}
try {
  await new Promise(resolve => upstream.listen(3080, '127.0.0.1', resolve))
  child = spawn(process.execPath, ['/opt/workbench/relay.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    if (child.exitCode !== null) throw new Error('Relay exited during bootstrap')
    try { ready = (await request('/not-exposed', {})).status === 404 }
    catch { await delay(20) }
  }
  assert.ok(ready, 'Relay must listen')
  for (const connection of ['close', 'keep-alive']) {
    for (let index = 0; index < 6; index++) {
      const kind = index % 3
      const result = await request('/ai/workbench/runs/synthetic/events' + (kind === 2 ? '?cursor=1-0' : ''), {
        connection: `${connection}, x-downstream-hop`, 'x-downstream-hop': 'must-not-forward',
        ...(kind === 1 ? { 'Last-Event-ID': '1-0' } : {}), 'X-GXZS-Assertion': 'synthetic-assertion',
      }, { agent: connection === 'close' ? false : pooled })
      assert.equal(result.status, 200, `Sequential ${connection} SSE request ${index + 1}`)
      assert.equal(result.headers['x-upstream-hop'], undefined)
      assert.equal(result.headers['x-end-to-end'], 'preserved')
      assert.equal(result.headers.connection, connection)
      const ids = result.body.split('\n').filter(line => line.startsWith('id:')).map(line => line.slice(4))
      assert.deepEqual(ids, kind === 0 ? ['1-0', '2-0'] : ['2-0'], 'Full replay and either resume cursor must preserve the exact suffix')
    }
  }
  assert.equal(requests.length, 12)
  for (const [index, { headers }] of requests.entries()) {
    assert.equal(headers.connection, 'keep-alive', 'The upstream owns its own reusable connection')
    assert.equal(headers['x-downstream-hop'], undefined)
    assert.equal(headers['last-event-id'], index % 3 === 1 ? '1-0' : undefined)
    assert.equal(headers['x-gxzs-assertion'], 'synthetic-assertion')
  }
  assert.equal((await request('/ai/workbench/hang', { connection: 'close' }, { abort: true })).status, 200)
  for (let attempt = 0; attempt < 100 && !hangClosed; attempt++) await delay(20)
  assert.ok(hangClosed, 'Disconnecting downstream must cancel its open upstream stream')
  assert.equal((await request('/ai/workbench/abort', { connection: 'close' }, { expectAborted: true })).aborted, true,
    'An interrupted upstream response must not become a clean SSE EOF')
  assert.deepEqual(errors, [], 'Upstream parser must never receive a request after its close boundary')
  process.stdout.write('PASS relay: 12 sequential close/keep-alive SSE full/header/query replays; hop headers stripped; assertion/cursor preserved; disconnect cancels upstream; upstream abort remains an error\n')
} finally {
  pooled.destroy()
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM'); await exited
  }
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
}
