import http from 'node:http'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, it } from 'vitest'
import { createRelayServer } from './relay.mjs'

const cleanup = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return server.address().port
}
function request(port, { method = 'GET', body = '', path = '/ai/workbench/control' } = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({ host: '127.0.0.1', port, path, method, agent: false }, response => {
      let text = ''
      response.on('data', data => { text += data })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, text }))
    })
    call.on('error', reject)
    call.end(body)
  })
}

it('survives a native idle-connection expiry while its event loop is blocked', async () => {
  const worker = new Worker(`
    const http = require('node:http')
    const { parentPort } = require('node:worker_threads')
    const server = http.createServer((req, res) => {
      res.setHeader('Keep-Alive', 'timeout=60')
      res.end('ok')
    })
    server.keepAliveTimeout = 100
    server.keepAliveTimeoutBuffer = 0
    server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port))
    parentPort.on('message', () => {
      parentPort.postMessage('blocked')
      const until = performance.now() + 350
      while (performance.now() < until) {}
    })
  `, { eval: true })
  cleanup.push(() => worker.terminate())
  const upstreamPort = await new Promise(resolve => worker.once('message', resolve))
  const relayPort = await listen(createRelayServer({ port: upstreamPort }))
  expect((await request(relayPort)).status).toBe(200)
  const blocked = new Promise(resolve => worker.once('message', resolve))
  worker.postMessage('block')
  await blocked
  await new Promise(resolve => setTimeout(resolve, 150))
  expect(await request(relayPort)).toEqual({ status: 200, text: 'ok' })
})

it('never replays a mutation after an upstream disconnect and returns a structured error', async () => {
  let mutations = 0
  const upstreamPort = await listen(http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Admit the complete body before disconnect. */ }
    mutations++
    res.destroy()
  }))
  const relayPort = await listen(createRelayServer({ port: upstreamPort }))
  const result = await request(relayPort, { method: 'POST', body: '{"prompt":"once"}' })
  expect(mutations).toBe(1)
  expect(result.status).toBe(503)
  expect(JSON.parse(result.text)).toEqual({ code: 'WORKBENCH_HOST_UNAVAILABLE', message: '工作台连接暂时中断，请稍后重试' })
})

it('uses distinct upstream connections and keeps the API boundary closed', async () => {
  const connections = new Set()
  const upstreamPort = await listen(http.createServer((req, res) => { connections.add(req.socket); res.end('ok') }))
  const relayPort = await listen(createRelayServer({ port: upstreamPort }))
  expect((await request(relayPort, { path: '/native-api' })).status).toBe(404)
  for (let i = 0; i < 4; i++) expect((await request(relayPort)).status).toBe(200)
  expect(connections.size).toBe(4)
})
