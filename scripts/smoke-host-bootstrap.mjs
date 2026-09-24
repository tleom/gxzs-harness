#!/usr/bin/env node
// Run inside the built host image with --network none and this script mounted
// read-only. All HTTP fixtures, state and child processes stay in the container.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { access, constants, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'linux') throw new Error('Host bootstrap smoke requires the Linux host image')

const root = await mkdtemp(path.join(os.tmpdir(), 'gxzs-host-bootstrap-'))
const owner = 'bootstrap-smoke:1'
const workspace = '11111111-1111-4111-8111-111111111111'
const instance = 'bootstrap-smoke-host'
const platformToken = 'synthetic-bootstrap-platform-token'
const managerToken = 'synthetic-bootstrap-manager-token'
const signingKey = Buffer.alloc(32, 7).toString('base64')
const secrets = [platformToken, managerToken, signingKey]
let registered = false
let deniedCatalogs = 0
let acceptedCatalogs = 0
let fixtureFailure
let child
let childError
let hostLogs = ''
let passed = false
const sessionCreate = process.argv.includes('--session-create')
const remoteDirectories = new Set()

const sanitize = (text) => secrets.reduce((value, secret) => value.replaceAll(secret, '[fixture-redacted]'), String(text))
  .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
  .replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')
const respond = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
const checkIdentity = (req, token) => {
  assert.equal(req.headers.authorization, `Bearer ${token}`, 'Fixture bearer mismatch')
  assert.equal(req.headers['x-gxzs-owner'], owner, 'Fixture owner mismatch')
  assert.equal(req.headers['x-gxzs-host-generation'], '1', 'Fixture generation mismatch')
  assert.equal(req.headers['x-gxzs-host-instance'], instance, 'Fixture instance mismatch')
}
const fixture = (handler) => http.createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    req.fixtureBody = body.length ? JSON.parse(body) : undefined
    handler(req, res)
  }
  catch (error) {
    fixtureFailure ??= error
    respond(res, 500, { message: 'Bootstrap fixture rejected the request' })
  }
})
const platform = fixture((req, res) => {
  checkIdentity(req, platformToken)
  if (req.method === 'GET' && req.url === '/internal/workbench/mcp/catalog') {
    if (!registered) {
      deniedCatalogs += 1
      respond(res, 401, { code: 'HOST_NOT_REGISTERED', message: 'Synthetic host registration pending' })
    } else {
      acceptedCatalogs += 1
      respond(res, 200, { data: { tools: [] } })
    }
    return
  }
  if (req.method === 'GET' && req.url === '/internal/workbench/workbench/config') {
    // Readiness has no models. The creation check uses a deliberately unreachable
    // synthetic route; neither check may perform a model call or submit a task.
    respond(res, 200, { data: sessionCreate ? {
      enabled: true, system_prompt: '', models: { default: 'smoke/smoke', providers: { smoke: {
        api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1',
        models: [{ id: 'smoke', name: 'Smoke', input: ['text'], contextWindow: 8192, maxTokens: 1024 }],
      } } },
    } : { enabled: false, system_prompt: '', models: { providers: {}, default: '' } } })
    return
  }
  throw new Error(`Unexpected platform fixture request: ${req.method} ${req.url}`)
})
const manager = fixture((req, res) => {
  checkIdentity(req, managerToken)
  assert.equal(req.method, 'POST', 'Manager fixture only accepts POST')
  const base = `/sandboxes/${workspace}/`
  if (req.url === `${base}personal-resources`) { respond(res, 200, { skills: [] }); return }
  if (req.url === `${base}personal-mcp`) { respond(res, 200, { mcp: [] }); return }
  if (req.url === `${base}files`) {
    if (sessionCreate) {
      assert.equal(req.fixtureBody?.operation, 'mkdir')
      assert.match(req.fixtureBody.path, /^conversations\/[a-f0-9-]{36}$/)
      remoteDirectories.add(req.fixtureBody.path)
    }
    respond(res, 200, { path: '.', entries: [] }); return
  }
  throw new Error(`Unexpected manager fixture request: ${req.method} ${req.url}`)
})
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}
async function waitForHealth(predicate, stage, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fixtureFailure) throw fixtureFailure
    if (childError) throw childError
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Host exited during ${stage} (exit=${child.exitCode}, signal=${child.signalCode})`)
    try {
      const response = await fetch('http://127.0.0.1:3081/ai/workbench/health', { signal: AbortSignal.timeout(1500) })
      const body = await response.json()
      if (predicate(response.status, body)) return body
    } catch { /* Relay can be listening before DSH mounts the adapter route. */ }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${stage}`)
}
async function liveGroupMembers(group) {
  const members = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) === group && !['Z', 'X'].includes(fields[0])) members.push(Number(name))
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error }
  }
  return members
}
function signalGroup(signal) {
  try { process.kill(-child.pid, signal) }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}
async function stopHost() {
  if (!child?.pid) return
  signalGroup('SIGTERM')
  let deadline = Date.now() + 5000
  while ((await liveGroupMembers(child.pid)).length && Date.now() < deadline) await delay(50)
  if ((await liveGroupMembers(child.pid)).length) signalGroup('SIGKILL')
  deadline = Date.now() + 2000
  while ((await liveGroupMembers(child.pid)).length && Date.now() < deadline) await delay(50)
  assert.equal((await liveGroupMembers(child.pid)).length, 0, 'Host process group did not exit')
}

async function signedRequest(method, route, value) {
  const now = Math.floor(Date.now() / 1000)
  const body = value === undefined ? '' : JSON.stringify(value)
  const contentType = value === undefined ? '' : 'application/json'
  const claims = { iss: 'bootstrap-smoke', aud: 'agent-workbench', sub: owner,
    tenant_id: 'bootstrap-smoke', user_id: '1', iat: now, exp: now + 60, jti: randomUUID(),
    method, target: `/ai/workbench${route}`, body_sha256: createHash('sha256').update(body).digest('hex'),
    content_type: contentType, last_event_id: '' }
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  const token = `${unsigned}.${createHmac('sha256', Buffer.from(signingKey, 'base64')).update(unsigned).digest('base64url')}`
  return fetch(`http://127.0.0.1:3081/ai/workbench${route}`, {
    method, headers: { 'X-GXZS-Assertion': token, ...(contentType ? { 'content-type': contentType } : {}) },
    ...(body ? { body } : {}), signal: AbortSignal.timeout(30_000),
  })
}

try {
  const platformPort = await listen(platform)
  const managerPort = await listen(manager)
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  const sandboxWorkspace = sessionCreate ? '/workspace' : path.join(root, 'workspace')
  const helper = '/opt/workbench/profiles/workbench/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'
  await Promise.all([mkdir(home), mkdir(bin), sessionCreate ? Promise.resolve() : mkdir(sandboxWorkspace)])
  if (sessionCreate) {
    assert.equal(process.getuid(), 1000, 'Run the host smoke as its production non-root user')
    assert.equal((await stat('/')).uid, 0, 'The parent remains owned by root')
    await assert.rejects(access('/', constants.W_OK), { code: 'EACCES' })
    assert.equal((await stat('/workspace')).uid, 1000, 'Native cwd placeholder must belong to node')
    await access('/workspace', constants.W_OK)
    assert.deepEqual(await readdir('/workspace'), [], 'The image must not include user workspace data')
    const patch = await readFile('/opt/workbench/profiles/workbench/cordis.patch.yml', 'utf8')
    for (const name of ['fs-sandbox', 'subprocess', 'spill-local'])
      assert.match(patch, new RegExp(`- id: ${name}\\s+disabled: true`))
    for (const name of ['gxzs-fs-ssh', 'gxzs-subprocess-ssh', 'gxzs-spill-sandbox'])
      assert.ok(patch.includes(`- id: ${name}`), `Missing SSH tool override: ${name}`)
  }
  // Exercise the real helper handshake without an SSH daemon or another image.
  // Only the initial RPC channel is needed: user tasks/forwarded streams are
  // outside this readiness smoke. Reject any unexpected SSH control request.
  await writeFile(path.join(bin, 'ssh'), '#!/bin/sh\n[ "$1" = "-T" ] && [ "$2" = "-M" ] || exit 70\nexec "$GXZS_SANDBOX_NODE" --disable-sigusr1 "$GXZS_SANDBOX_HELPER"\n', { mode: 0o700 })
  const helperHash = createHash('sha256').update(await readFile(helper)).digest('hex')
  const env = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
    HOME: home, USER: 'node', LANG: 'C.UTF-8',
    DSH_HOME: path.join(root, 'dsh'), DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access',
    GXZS_HOST_OWNER_ID: owner, GXZS_HOST_GENERATION: '1', GXZS_HOST_INSTANCE_ID: instance,
    GXZS_ASSERTION_ISSUER: 'bootstrap-smoke', GXZS_ASSERTION_SIGNING_KEY: signingKey,
    GXZS_ASSERTION_AUDIENCE_PATH: '/ai/workbench',
    GXZS_PLATFORM_INTERNAL_URL: `http://127.0.0.1:${platformPort}/internal/workbench`,
    GXZS_PLATFORM_INTERNAL_TOKEN: platformToken,
    GXZS_SANDBOX_MANAGER_URL: `http://127.0.0.1:${managerPort}`, GXZS_SANDBOX_MANAGER_TOKEN: managerToken,
    GXZS_SANDBOX_WORKSPACE_ID: workspace, GXZS_SANDBOX_WORKSPACE: sandboxWorkspace,
    GXZS_SANDBOX_SSH_HOST: '127.0.0.1', GXZS_SANDBOX_NODE: '/usr/local/bin/node',
    GXZS_SANDBOX_HELPER: helper, GXZS_SANDBOX_HELPER_HASH: helperHash,
    // The host image deliberately has no sandbox ripgrep. Readiness resolves
    // this executable but must never perform a user search in this fixture.
    GXZS_SANDBOX_RG: '/usr/bin/false',
  }
  child = spawn('/usr/local/bin/start-workbench', [], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.once('error', (error) => { childError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { hostLogs = (hostLogs + chunk.toString()).slice(-24_000) })
  await waitForHealth((status, body) => deniedCatalogs > 0 && status === 503 && body.live === true && body.ready === false,
    'unregistered catalog: HTTP 503, live=true, ready=false')
  assert.equal(acceptedCatalogs, 0, 'Catalog became available before fixture registration')
  registered = true
  await waitForHealth((status, body) => acceptedCatalogs > 0 && status === 200 && body.live === true && body.ready === true,
    'registered catalog: HTTP 200, live=true, ready=true', 30_000)
  if (sessionCreate) {
    const response = await signedRequest('POST', '/chats')
    assert.equal(response.status, 201, 'Actual Workbench -> native sessionController.create must succeed')
    const chat = (await response.json()).data
    assert.ok(remoteDirectories.has(`conversations/${chat.id}`), 'Sandbox mkdir must run before native creation')
    assert.deepEqual(await readdir(`/workspace/conversations/${chat.id}`), [], 'Host cwd remains an empty placeholder')
    const detail = await signedRequest('GET', `/chats/${chat.id}`)
    assert.equal(detail.status, 200)
    // Empty native sessions are lazy until their first event or explicit flush.
    const renamed = await signedRequest('PATCH', `/chats/${chat.id}`, { title: 'Native create smoke' })
    assert.equal(renamed.status, 200)
    let sessions = []
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !sessions.some(name => name.endsWith('.zstd'))) {
      sessions = await readdir(path.join(env.DSH_HOME, 'sessions'), { recursive: true })
      await delay(50)
    }
    assert.ok(sessions.some(name => name.endsWith('.zstd')), 'Native session must be persisted')
    await stopHost()
    child = spawn('/usr/local/bin/start-workbench', [], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.once('error', error => { childError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { hostLogs = (hostLogs + chunk.toString()).slice(-24_000) })
    await waitForHealth((status, body) => status === 200 && body.ready === true, 'restarted host with native session', 30_000)
    const resumed = await signedRequest('PATCH', `/chats/${chat.id}`, { title: 'Native resume smoke' })
    assert.equal(resumed.status, 200, 'Native cold-session resume must succeed after host restart')
    assert.deepEqual(await readdir(`/workspace/conversations/${chat.id}`), [], 'Native create and resume must leave cwd empty')
  }
  if (fixtureFailure) throw fixtureFailure
  passed = true
} catch (error) {
  process.stderr.write(`FAIL host bootstrap: ${sanitize(error.message)}\n${sanitize(hostLogs)}\n`)
  process.exitCode = 1
} finally {
  try { await stopHost() }
  catch (error) { passed = false; process.exitCode = 1; process.stderr.write(`FAIL host cleanup: ${sanitize(error.message)}\n`) }
  for (const server of [platform, manager]) {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
  await rm(root, { recursive: true, force: true })
}
if (passed) process.stdout.write(`PASS host bootstrap: unauthorized -> live/not-ready -> registered/ready${sessionCreate ? '; non-root native session create=201/detail=200/rename=200/cold-resume=200; empty local cwd and SSH tool overrides' : ''}; process group stopped\n`)
