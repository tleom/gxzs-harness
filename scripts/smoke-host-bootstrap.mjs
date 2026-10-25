#!/usr/bin/env node
// Run in the built Host sharing an isolated Sandbox network, with this script
// mounted read-only. HTTP fixtures and user state stay in the disposable pair.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { access, constants, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { createSchedulePlatformFixture } from './smoke-schedule-platform.mjs'

if (process.platform !== 'linux') throw new Error('Host bootstrap smoke requires the Linux host image')

const root = await mkdtemp(path.join(os.tmpdir(), 'gxzs-host-bootstrap-'))
const owner = 'bootstrap-smoke:1'
const workspace = '11111111-1111-4111-8111-111111111111'
const instance = 'bootstrap-smoke-host'
const platformToken = 'synthetic-bootstrap-platform-token'
const managerToken = 'synthetic-bootstrap-manager-token'
const signingKey = Buffer.alloc(32, 7).toString('base64')
const secrets = [platformToken, managerToken, signingKey]
const fixtureTool = {
  id: 'global:mcp:reference-smoke:lookup', runtime_name: 'global_mcp_reference_smoke_lookup',
  version: 'v1', manifest_version: 'v1',
  scope: 'global', server_id: 'reference-smoke', tool_name: 'fixture_lookup',
  provider: 'global:mcp:reference-smoke', provider_name: '引用测试插件',
  description: 'Synthetic reference lookup', inputSchema: { type: 'object', properties: {} },
}
const fixturePlugin = { id: fixtureTool.provider, name: fixtureTool.server_id,
  displayName: fixtureTool.provider_name, description: 'Synthetic reference plugin', scope: 'global', available: true }
const fixtureSkill = {
  id: 'bootstrap-skill', version: 'v1', enabled: true,
  content: '---\nname: bootstrap-skill\ndescription: Synthetic skill for assembly validation\nmetadata:\n  display-name: 技能装配测试\n---\nsynthetic-skill-body-verified',
}
let registered = false
let deniedCatalogs = 0
let acceptedCatalogs = 0
let fixtureFailure
let settingsWritable = true
let heldSettingsCheck
let child
let childError
let hostLogs = ''
let passed = false
const sessionCreate = process.argv.includes('--session-create')
const realSsh = process.argv.includes('--real-ssh')
if (!realSsh) throw new Error('Host bootstrap smoke requires the real disposable Sandbox SSH transport')
const crashRestart = process.argv.includes('--crash-restart')
const runningRestart = process.argv.includes('--running-restart')
const nativeAttachments = process.argv.includes('--native-attachments')
const legacyProfile = process.argv.includes('--legacy-profile')
if (legacyProfile && !sessionCreate) throw new Error('Legacy profile smoke requires the full session/restart fixture')
if (nativeAttachments && (!realSsh || !sessionCreate || !runningRestart || process.env.GXZS_SMOKE_DSH_HOME !== '/srv/dsh'))
  throw new Error('Native attachment smoke requires the disposable shared home, real SSH and running restart fixture')
let modelPort
let modelCalls = 0
let titleCalls = 0
let verifyReferenceContext = false
let verifySkillContext = false
let referenceContextVerified = false
let referenceModelCalls = 0
let pluginCalls = 0
let verifyAttachmentContext = false
let attachmentPaths
let malformedToolProbe
const fixtureFiles = new Map()
const remote = (command) => execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
  process.env.GXZS_SANDBOX_SSH_HOST, command], { encoding: 'utf8', timeout: 10_000 })
const remoteDirectories = new Set()
// Exercise the manager's actual descriptor-relative filesystem implementation
// inside the isolated Sandbox, including absent intermediate directories.
const fileOps = (await readFile('/smoke-file-ops.py')).toString('base64')
function sandboxFileOperation(payload) {
  const input = Buffer.from(JSON.stringify(payload)).toString('base64')
  return JSON.parse(remote(`printf '%s' '${input}' | base64 -d | /usr/local/bin/python -I -S -c "import base64;exec(compile(base64.b64decode('${fileOps}'), 'file_ops.py', 'exec'))"`))
}

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
    await handler(req, res)
  }
  catch (error) {
    fixtureFailure ??= error
    respond(res, 500, { message: 'Bootstrap fixture rejected the request' })
  }
})
const schedulePlatform = createSchedulePlatformFixture()
const platform = fixture((req, res) => {
  checkIdentity(req, platformToken)
  const scheduleResult = schedulePlatform(req.method, req.url, req.fixtureBody)
  if (scheduleResult !== undefined) {
    respond(res, 200, { data: scheduleResult })
    return
  }
  if (req.method === 'POST' && req.url === '/internal/workbench/mcp/call') {
    assert.equal(req.fixtureBody.resource_id, fixtureTool.id)
    assert.equal(req.fixtureBody.tool_name, fixtureTool.tool_name)
    assert.equal(req.fixtureBody.version, fixtureTool.version)
    assert.ok(req.fixtureBody.run_id && req.fixtureBody.request_key)
    pluginCalls++
    respond(res, 200, { data: { result: { content: [{ type: 'text', text: 'synthetic-plugin-result-verified' }] } } })
    return
  }
  if (req.method === 'POST' && req.url === '/internal/workbench/scheduling') {
    respond(res, 200, { data: { state: req.fixtureBody.action === 'release' ? 'done' : 'running' } }); return
  }
  if (req.method === 'POST' && req.url === '/internal/workbench/mcp/cancel') {
    respond(res, 200, { data: { fenced: true } }); return
  }
  if (req.method === 'GET' && ['/internal/workbench/mcp/policy', '/internal/workbench/mcp/catalog', '/internal/workbench/mcp/plugins'].includes(req.url)) {
    if (!registered) {
      deniedCatalogs += 1
      respond(res, 401, { code: 'HOST_NOT_REGISTERED', message: 'Synthetic host registration pending' })
    } else {
      acceptedCatalogs += 1
      respond(res, 200, { data: req.url.endsWith('/policy') ? { policy: {
        request_bytes: 30 * 1024 * 1024, response_bytes: 30 * 1024 * 1024,
        max_call_seconds: 350, catalog_timeout_seconds: 180,
      } } : { tools: [fixtureTool], plugins: [fixturePlugin] } })
    }
    return
  }
  if (req.method === 'GET' && req.url === '/internal/workbench/workbench/config') {
    // Readiness has no models; session checks use the local fixture provider.
    respond(res, 200, { data: sessionCreate ? {
      enabled: true, system_prompt: '', global_skills: [], models: { default: 'smoke/smoke', providers: { smoke: {
        api: 'openai-completions', apiKeyEnv: 'GXZS_SMOKE_MODEL_KEY', baseURL: `http://127.0.0.1:${modelPort ?? 1}/v1`,
        models: [{ id: 'smoke', name: 'Smoke', input: nativeAttachments ? ['text', 'image'] : ['text'], contextWindow: 131072, maxTokens: 1024 },
          ...(nativeAttachments ? [{ id: 'text-only', name: 'Text only', input: ['text'], contextWindow: 131072, maxTokens: 1024 }] : [])],
      } } },
    } : { enabled: false, system_prompt: '', global_skills: [], models: { providers: {}, default: '' } } })
    return
  }
  throw new Error(`Unexpected platform fixture request: ${req.method} ${req.url}`)
})
const manager = fixture(async (req, res) => {
  checkIdentity(req, managerToken)
  assert.equal(req.method, 'POST', 'Manager fixture only accepts POST')
  const base = `/sandboxes/${workspace}/`
  if (req.url === `${base}host-settings`) {
    assert.deepEqual(req.fixtureBody, { operation: 'check' }, 'Only the fixed settings check is admitted')
    const gate = heldSettingsCheck
    if (gate) {
      heldSettingsCheck = undefined
      gate.observed.resolve()
      await gate.release.promise
    }
    respond(res, settingsWritable ? 200 : 503, settingsWritable ? { writable: true }
      : { error: 'Synthetic Host maintenance in progress', code: 'SANDBOX_UPDATING', retry_after: 5 })
    return
  }
  if (req.url === `${base}personal-resources`) { respond(res, 200, { skills: [fixtureSkill] }); return }
  if (req.url === `${base}personal-mcp`) { respond(res, 200, { mcp: [] }); return }
  if (req.url === `${base}files`) {
    const value = req.fixtureBody
    if (['stat', 'delete'].includes(value?.operation)) {
      assert.match(value.path, /^(?:conversations\/\d{4}-\d{2}-\d{2}\/new-chat(?:-\d+)?|\.agent-output\/[a-f0-9]{32})$/)
      respond(res, 200, sandboxFileOperation(value)); return
    }
    if (nativeAttachments && ['upload', 'get', 'download'].includes(value?.operation)) {
      assert.match(value.path, /^conversations\/\d{4}-\d{2}-\d{2}\/new-chat(?:-\d+)?\/native-evidence\.(txt|png)$/)
      if (value.operation === 'upload') {
        assert.equal(value.version, null)
        assert.ok(!fixtureFiles.has(value.path), 'Cold continuation must not upload the attachment again')
        assert.match(value.data, /^[A-Za-z0-9+/]+={0,2}$/)
        remote(`printf '%s' '${value.data}' | base64 -d > /workspace/${value.path}`)
        fixtureFiles.set(value.path, createHash('sha256').update(Buffer.from(value.data, 'base64')).digest('hex'))
      }
      const data = remote(`base64 -w0 -- /workspace/${value.path}`)
      const version = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex')
      assert.equal(version, fixtureFiles.get(value.path))
      const bytes = Buffer.from(data, 'base64')
      const metadata = { path: value.path, name: path.basename(value.path), kind: 'file', version, size: bytes.length }
      if (value.operation === 'download') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length,
          'x-workbench-file': Buffer.from(JSON.stringify(metadata)).toString('base64url') })
        res.end(bytes)
      } else respond(res, 200, { ...metadata, ...(value.operation === 'get' ? { data } : {}) })
      return
    }
    if (sessionCreate) {
      assert.ok(['mkdir', 'list'].includes(req.fixtureBody?.operation))
      assert.match(req.fixtureBody.path, /^conversations\/\d{4}-\d{2}-\d{2}(?:\/new-chat(?:-\d+)?)?$/)
      if (req.fixtureBody.operation === 'mkdir') {
        let result
        if (realSsh) result = sandboxFileOperation(value)
        else {
          let target = value.path, suffix = 1
          while (value.unique && remoteDirectories.has(target)) target = `${value.path}-${++suffix}`
          result = { path: target }
        }
        remoteDirectories.add(result.path)
        respond(res, 200, result); return
      } else assert.ok(remoteDirectories.has(req.fixtureBody.path))
    }
    respond(res, 200, { path: '.', entries: [] }); return
  }
  throw new Error(`Unexpected manager fixture request: ${req.method} ${req.url}`)
})
const model = fixture((req, res) => {
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '/v1/chat/completions')
  const tools = new Map((req.fixtureBody.tools ?? []).map(tool => [tool.function?.name, tool.function]))
  if (req.fixtureBody.messages?.[0]?.role === 'system' &&
    req.fixtureBody.messages[0].content?.startsWith('Create a concise title for an AI coding-assistant session')) {
    assert.equal(tools.size, 0, 'Native title generation must not receive execution tools')
    titleCalls++
    res.writeHead(200, {'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify({id:'fixture-title',object:'chat.completion.chunk',created:1,model:'smoke',
      choices:[{index:0,delta:{role:'assistant',content:'Reference fixture'},finish_reason:null}]})}\n\n`)
    res.write(`data: ${JSON.stringify({id:'fixture-title',object:'chat.completion.chunk',created:1,model:'smoke',
      choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`)
    res.end('data: [DONE]\n\n')
    return
  }
  for (const name of ['bash', 'job_output', 'job_kill', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'working_directory']) {
    assert.ok(tools.has(name), `Native standard preset must expose ${name} to the model; received: ${JSON.stringify([...tools.keys()])}`)
  }
  for (const name of ['session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
    'ralph', 'terminal_open', 'terminal_list', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close']) {
    assert.ok(tools.has(name), `Enabled official bundle must expose ${name}`)
  }
  if (malformedToolProbe) {
    const probe = malformedToolProbe
    probe.calls++
    assert.ok(probe.calls <= 3, 'Malformed tool response recovery must be bounded')
    const valid = { index: probe.calls === 1 ? 1 : 0, id: 'guard-valid-call', type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ description: 'Count guarded execution', command: `printf 'once\\n' >> '${probe.path}'; printf GUARD_TOOL_OK` }) } }
    const delta = probe.calls === 3 ? { role: 'assistant', content: 'GUARD_RECOVERED' }
      : { role: 'assistant', tool_calls: probe.calls === 1
        ? [{ index: 0, id: '', type: 'function', function: { name: '', arguments: '{}' } }, valid] : [valid] }
    if (probe.calls === 3) assert.ok(req.fixtureBody.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('GUARD_TOOL_OK')))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({id:'malformed-tool-probe',object:'chat.completion.chunk',created:1,model:'smoke',choices:[{index:0,delta,finish_reason:null}]})}\n\n`)
    res.write(`data: ${JSON.stringify({id:'malformed-tool-probe',object:'chat.completion.chunk',created:1,model:'smoke',choices:[{index:0,delta:{},finish_reason:probe.calls===3?'stop':'tool_calls'}]})}\n\n`)
    res.end('data: [DONE]\n\n')
    return
  }
  assert.ok(tools.get('bash').parameters?.properties?.run_in_background,
    'Actual host assembly must expose native background execution')
  if (verifyReferenceContext) {
    referenceModelCalls++
    const messages = JSON.stringify(req.fixtureBody.messages)
    assert.ok(messages.includes('Explicit recovery retry'), 'Referenced user message must reach model context')
    assert.ok(messages.includes('Restart fixture in progress'), 'Referenced assistant response must reach model context')
    assert.ok(messages.includes('用户优先指定插件') && messages.includes('引用测试插件'),
      'Explicit plugin preference must coexist with native conversation references')
    assert.ok(tools.has('tool_search'), 'Discovery must remain available to the actual model')
    assert.ok(tools.has('mcp'), 'Plugin browsing must remain available to the actual model')
    assert.equal(tools.has('fixture_lookup'), referenceModelCalls > 1,
      'The selected plugin child tool becomes available only after discovery')
    referenceContextVerified = true
  }
  modelCalls++
  if (verifyAttachmentContext) {
    const text = req.fixtureBody.messages.flatMap(message => typeof message.content === 'string' ? [message.content]
      : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text)).join('\n')
    assert.ok(!text.includes('cannot access a readable path') && !text.includes('No local normalized image path'))
    const readable = [...new Set([...text.matchAll(/"(\/srv\/dsh\/attachments\/v1\/[^"\s]+)"/g)].map(match => match[1]))].sort()
    assert.equal(readable.length, 2, 'File and image must expose native sandbox paths')
    if (attachmentPaths) assert.deepEqual(readable, attachmentPaths, 'Cold native history must preserve attachment identity')
    attachmentPaths = readable
    for (const target of readable) {
      assert.match(target, /^\/srv\/dsh\/attachments\/v1\/[A-Za-z0-9/._-]+$/)
      const remoteBytes = Buffer.from(remote(`base64 -w0 -- ${target}`), 'base64')
      const localBytes = execFileSync('cat', [path.join(process.env.GXZS_SMOKE_DSH_HOME, 'attachments', target.slice('/srv/dsh/attachments/'.length))])
      assert.deepEqual(remoteBytes, localBytes, 'Real SSH must read the exact native bytes after restart')
      if (target.endsWith('.txt')) assert.equal(remoteBytes.toString(), 'durable-native-evidence')
      else {
        const imageUrls = req.fixtureBody.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(part => part.type === 'image_url').map(part => part.image_url.url)
        assert.ok(imageUrls.some(url => url.startsWith('data:image/') && Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').equals(remoteBytes)),
          'The model must receive the same normalized image bytes available through SSH')
      }
    }
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (verifySkillContext) {
    assert.ok(tools.has('skill'), 'Native skill tool must be available to the actual model')
    const messages = JSON.stringify(req.fixtureBody.messages)
    assert.ok(messages.includes(`/${fixtureSkill.id}`), 'Selection must become a native skill gesture')
    assert.equal(modelCalls, 6)
    assert.ok(messages.includes('synthetic-skill-body-verified'), 'Native skill body must reach the first selected-skill request')
  }
  if (verifyReferenceContext && referenceModelCalls <= 2) {
    const discovering = referenceModelCalls === 1
    res.write(`data: ${JSON.stringify({ id: 'fixture-tool', object: 'chat.completion.chunk', created: 1, model: 'smoke',
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: discovering ? 'fixture-discovery-call' : 'fixture-lookup-call', type: 'function',
        function: { name: discovering ? 'tool_search' : 'fixture_lookup', arguments: discovering
          ? JSON.stringify({ query: 'fixture_lookup', name: fixtureTool.server_id }) : '{}' } }] }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id: 'fixture-tool', object: 'chat.completion.chunk', created: 1, model: 'smoke',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
    return
  }
  if (verifyReferenceContext) {
    assert.equal(pluginCalls, 1, 'Plugin must execute exactly once through the platform proxy')
    assert.ok(JSON.stringify(req.fixtureBody.messages).includes('synthetic-plugin-result-verified'),
      'Native tool result must return to the model')
  }
  res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'smoke',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Restart fixture in progress' }, finish_reason: null }] })}\n\n`)
  // Hold the native model stream open until the host process is killed.
  if (modelCalls > 1) {
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'smoke',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  }
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
  let lastHealth
  while (Date.now() < deadline) {
    if (fixtureFailure) throw fixtureFailure
    if (childError) throw childError
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Host exited during ${stage} (exit=${child.exitCode}, signal=${child.signalCode})`)
    try {
      const response = await fetch('http://127.0.0.1:3081/ai/workbench/health', { signal: AbortSignal.timeout(1500) })
      const body = await response.json()
      lastHealth = {status:response.status, live:body.live, ready:body.ready,
        recovery:body.recovery, resources:body.resources, activity:body.activity}
      if (predicate(response.status, body)) return body
    } catch { /* Relay can be listening before DSH mounts the adapter route. */ }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${stage}; ${JSON.stringify({lastHealth,deniedCatalogs,acceptedCatalogs})}`)
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
async function stopHost(signal = 'SIGTERM') {
  if (!child?.pid) return
  signalGroup(signal)
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

async function nativeClientRoundtrip() {
  const response = await signedRequest('GET', '/native/client')
  const payload = await response.json()
  assert.equal(response.status, 200, `Native client graph must be installed: ${sanitize(JSON.stringify(payload))}`)
  const manifest = payload.data
  assert.equal(manifest.protocol, 1)
  assert.equal(manifest.version, '0.2.1-rc.2')
  assert.match(manifest.bootstrap, /__ModuleLoader__/)
  assert.match(manifest.boot.rev, /^[a-f0-9]{64}$/)
  const ids = new Set(manifest.boot.entries.map(row => row.id))
  const sources = new Map()
  for (const id of ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-api-job-controller', '@deepseek-ai/dsh-api-session-controller', '@gxzs/dsh-workbench-adapter'])
    assert.ok(ids.has(id), `Missing native client module ${id}`)
  for (const row of manifest.boot.entries) {
    const route = `/native/client/bundle?url=${encodeURIComponent(row.url)}&rev=${encodeURIComponent(manifest.boot.rev)}`
    const resource = await signedRequest('GET', route)
    const value = await resource.json()
    assert.equal(resource.status, 200, `Native client bundle ${row.id} must be present in the built image`)
    assert.equal(typeof value.data.source, 'string')
    sources.set(row.url, value.data.source)
    assert.ok(value.data.source.includes(row.id), `Native client bundle must register ${row.id}`)
    if (row.id === '@deepseek-ai/dsh-api-session-controller') {
      assert.equal([...value.data.source.matchAll(/this\.remote\.subagents\.prompt\(\{\s+requestId: requestId \?\? randomUUID\(\),/g)].length, 1,
        'The image-served child Session.prompt must preserve the caller requestId')
      assert.doesNotMatch(value.data.source, /this\.remote\.subagents\.prompt\(\{\s+requestId: randomUUID\(\),/)
      console.log(JSON.stringify({ check: 'prepared_native_session_sdk',
        sourceSha256: createHash('sha256').update(value.data.source).digest('hex'), callerRequestIdGuard: true }))
    }
    assert.ok(Buffer.byteLength(value.data.source, 'utf8') <= 8 * 1024 * 1024)
  }
  // Execute the image-served factories with the same static dependencies used
  // by GXZS. Merely finding module names cannot catch a broken release graph.
  const require = createRequire('/opt/workbench/profiles/workbench/package.json')
  const Cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  const Store = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-store')).href)
  const Zod = await import(pathToFileURL(require.resolve('zod')).href)
  const browser = createContext({ window: {}, console, URL, AbortController, setTimeout, clearTimeout,
    queueMicrotask, TextEncoder, TextDecoder, crypto: globalThis.crypto })
  runInContext(manifest.bootstrap, browser)
  const facade = browser.window.__ModuleLoader__
  const loadBundle = async url => {
    assert.ok(sources.has(url), 'Only admitted native bundles may load')
    runInContext(sources.get(url), browser)
  }
  await loadBundle(manifest.boot.entries.find(row => row.id === '@deepseek-ai/dsh-client-modules').url)
  const modules = facade.create({ boot: manifest.boot, loadBundle,
    staticModules: { '@deepseek-ai/cordis': Cordis, '@deepseek-ai/dsh-client-store': Store, zod: Zod } })
  for (const row of manifest.boot.entries) await modules.prefetch(row.id)
  for (const id of ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-job-controller',
    '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-typert-registry',
    '@deepseek-ai/dsh-client-connection', '@gxzs/dsh-workbench-adapter']) {
    assert.ok(Object.keys(await modules.import(id)).length, `Native factory must resolve: ${id}`)
  }
  console.log(`PASS native client image: signed boot graph and ${ids.size} original registration bundles; generated presenter included`)
}

async function nativeSettingsView() {
  const response = await signedRequest('GET', '/native/settings')
  assert.equal(response.status, 200, 'Native subagent settings must be available in the built Host')
  const view = (await response.json()).data
  assert.equal(view.hasDocument, false, 'The carrier must not expose the whole settings document')
  assert.deepEqual(view.namespaces.map(row => row.ns).sort(), ['subagent', 'subagent-model-selection-settings', 'ui-conversation'])
  return view
}

async function nativeSettingsRoundtrip() {
  const view = await nativeSettingsView()
  const before = view.namespaces.find(row => row.ns === 'subagent')
  assert.equal(view.writable, true)
  assert.ok(Number.isSafeInteger(before.revision))
  const value = before.value.maxDepth === 2 ? 3 : 2
  const gate = { observed: Promise.withResolvers(), release: Promise.withResolvers() }
  heldSettingsCheck = gate
  const changing = signedRequest('POST', '/native/settings/mutate', {
    ns: 'subagent', expectedRevision: before.revision, ops: [{ op: 'set', path: ['maxDepth'], value }],
  })
  void changing.catch(() => {})
  try {
    await Promise.race([gate.observed.promise, delay(5000).then(() => { throw new Error('Manager settings check did not arrive') })])
    // Protocol 2 counts both the native settings hold and the enclosing HTTP
    // sleep barrier. Neither may disappear before the Manager admits this write.
    await waitForHealth((status, body) => status === 200 && body.activity?.protocol === 2
      && body.activity.activeSettingsWrites === 2,
      'in-flight settings write is visible before Manager approval', 5000)
  } finally {
    gate.release.resolve()
    heldSettingsCheck = undefined
  }
  const changed = await changing
  assert.equal(changed.status, 200, 'Native volatile setting must save through signed HTTP')
  const saved = (await changed.json()).data
  assert.equal(saved.value.maxDepth, value)
  assert.notEqual(saved.revision, before.revision)
  settingsWritable = false
  try {
    const denied = await signedRequest('POST', '/native/settings/mutate', {
      ns: 'subagent', expectedRevision: saved.revision, ops: [{ op: 'set', path: ['maxDepth'], value: 4 }],
    })
    assert.equal(denied.status, 503, 'Draining must reject new settings writes before native mutation')
    assert.equal((await denied.json()).code, 'SANDBOX_UPDATING')
  } finally { settingsWritable = true }
  await waitForHealth((status, body) => status === 200 && body.activity?.protocol === 2
    && body.activity.activeSettingsWrites === 0,
    'completed and refused settings writes release their activity count', 5000)
  assert.equal((await nativeSettingsView()).namespaces.find(row => row.ns === 'subagent').value.maxDepth, value,
    'The maintenance refusal must preserve the committed setting')
  const stale = await signedRequest('POST', '/native/settings/mutate', {
    ns: 'subagent', expectedRevision: before.revision, ops: [{ op: 'set', path: ['maxDepth'], value: 4 }],
  })
  assert.equal(stale.status, 409, 'Stale settings revisions must survive the HTTP error projection')
  assert.equal((await stale.json()).code, 'settings/conflict')
  const preference = view.namespaces.find(row => row.ns === 'ui-conversation')
  const busyEnter = preference.value.busyEnter === 'steer' ? 'queue' : 'steer'
  const updatedPreference = await signedRequest('POST', '/native/settings/mutate', {
    ns: 'ui-conversation', expectedRevision: preference.revision,
    ops: [{ op: 'set', path: ['busyEnter'], value: busyEnter }],
  })
  assert.equal(updatedPreference.status, 200)
  const preferenceSaved = (await updatedPreference.json()).data
  assert.equal(preferenceSaved.value.busyEnter, busyEnter)
  const invalidPreference = await signedRequest('POST', '/native/settings/mutate', {
    ns: 'ui-conversation', expectedRevision: preferenceSaved.revision,
    ops: [{ op: 'set', path: ['busyEnter'], value: 'unknown-smoke-mode' }],
  })
  assert.equal(invalidPreference.status, 400)
  assert.equal((await invalidPreference.json()).code, 'settings/rejected')
  for (const request of [
    { ns: 'llm-pi-ai', expectedRevision: saved.revision, ops: [{ op: 'unset', path: ['providers'] }] },
    { ns: 'subagent', expectedRevision: saved.revision, ops: [{ op: 'set', path: ['unexposed'], value: true }] },
    { ns: 'subagent', ops: [{ op: 'set', path: ['maxDepth'], value: 4 }] },
    { ns: 'ui-conversation', expectedRevision: preferenceSaved.revision, ops: [{ op: 'set', path: ['enabled'], value: true }] },
  ]) {
    const denied = await signedRequest('POST', '/native/settings/mutate', request)
    assert.equal(denied.status, 400, 'Unadmitted fields, namespaces and missing revisions must fail before native writes')
  }
  assert.equal((await nativeSettingsView()).namespaces.find(row => row.ns === 'subagent').value.maxDepth, value)
  const models = await signedRequest('GET', '/native/models')
  assert.equal(models.status, sessionCreate ? 200 : 503)
  if (sessionCreate) {
    const catalog = (await models.json()).data
    assert.ok(catalog.groups.some(group => group.id === 'smoke'))
  }
  const restore = Object.hasOwn(before.user ?? {}, 'maxDepth')
    ? { op: 'set', path: ['maxDepth'], value: before.user.maxDepth }
    : { op: 'unset', path: ['maxDepth'] }
  console.log('PASS native settings HTTP: fixed Manager identity check, in-flight activity, maintenance refusal, restricted fields, revision conflict and platform model catalog')
  const restorePreference = Object.hasOwn(preference.user ?? {}, 'busyEnter')
    ? { op: 'set', path: ['busyEnter'], value: preference.user.busyEnter }
    : { op: 'unset', path: ['busyEnter'] }
  return { value, original: before.value.maxDepth, restore,
    preference: { value: busyEnter, original: preference.value.busyEnter, restore: restorePreference } }
}

async function restoreNativeSettings(proof, { restarted = false } = {}) {
  const current = (await nativeSettingsView()).namespaces.find(row => row.ns === 'subagent')
  assert.equal(current.value.maxDepth, proof.value,
    restarted ? 'Saved native settings must survive the full start-workbench restart' : 'Rejected writes must not alter native settings')
  const restored = await signedRequest('POST', '/native/settings/mutate', {
    ns: 'subagent', expectedRevision: current.revision, ops: [proof.restore],
  })
  assert.equal(restored.status, 200)
  assert.equal((await restored.json()).data.value.maxDepth, proof.original)
  const preference = (await nativeSettingsView()).namespaces.find(row => row.ns === 'ui-conversation')
  assert.equal(preference.value.busyEnter, proof.preference.value,
    'Busy Enter preference must remain persisted through the full entrypoint restart')
  const resetPreference = await signedRequest('POST', '/native/settings/mutate', {
    ns: 'ui-conversation', expectedRevision: preference.revision, ops: [proof.preference.restore],
  })
  assert.equal(resetPreference.status, 200)
  assert.equal((await resetPreference.json()).data.value.busyEnter, proof.preference.original)
  console.log(`PASS native settings ${restarted ? 'full entrypoint restart persistence and ' : ''}reset to prior composition`)
}

async function seedLegacyProfile(home) {
  const supplied = process.env.GXZS_SMOKE_LEGACY_BASELINE
  const bytes = await readFile(supplied || '/opt/workbench/profiles/workbench/cordis.runtime.patch.yml')
  const baselineSha256 = createHash('sha256').update(bytes).digest('hex')
  const imageId = supplied ? process.env.GXZS_SMOKE_LEGACY_IMAGE_ID : `sha256:${'0'.repeat(64)}`
  assert.match(imageId ?? '', /^sha256:[a-f0-9]{64}$/)
  if (supplied) assert.equal(baselineSha256, process.env.GXZS_SMOKE_LEGACY_BASELINE_SHA256)
  const directory = path.join(home, 'profiles/workbench')
  await mkdir(directory, { recursive: true })
  const user = `${bytes.toString('utf8').trimEnd()}\n\n- id: subagent\n  config:\n    maxDepth: 2\n- id: ui-conversation\n  config:\n    busyEnter: steer\n`
  await writeFile(path.join(directory, 'cordis.patch.yml'), user, { flag: 'wx', mode: 0o600 })
  // Synthetic runtime fixture only. The separate image-upgrade smoke exercises
  // the operator CLI's immutable Docker image extraction and owner-volume checks.
  const { provisionLegacyBaseline } = await import('/opt/workbench/scripts/migrate-platform-patch.mjs')
  await provisionLegacyBaseline(directory, { ownerId: owner, imageId, baselineSha256,
    baseline: bytes.toString('utf8') })
  return { directory, baselineSha256, userSha256: createHash('sha256').update(user).digest('hex'),
    source: supplied ? 'captured-old-image' : 'synthetic-pre-layout' }
}

async function assertLegacyProfileMigration(proof) {
  const receipt = JSON.parse(await readFile(path.join(proof.directory, '.gxzs-bundle-layout-v1.json'), 'utf8'))
  assert.equal(receipt.layout, 'bundle-base')
  assert.equal(receipt.baselineSha256, proof.baselineSha256)
  assert.ok(receipt.removed > 0)
  assert.equal(receipt.retained, 2, 'Legacy user limit and input preference must remain in the native user layer')
  const backup = await readFile(path.join(proof.directory, '.cordis.patch.before-bundle-layout-v1.yml'))
  assert.equal(createHash('sha256').update(backup).digest('hex'), proof.userSha256)
  const view = await nativeSettingsView()
  assert.equal(view.namespaces.find(row => row.ns === 'subagent').value.maxDepth, 2)
  assert.equal(view.namespaces.find(row => row.ns === 'ui-conversation').value.busyEnter, 'steer')
  console.log(JSON.stringify({ check: 'entrypoint_legacy_profile_migration', source: proof.source,
    baselineSha256: proof.baselineSha256, removed: receipt.removed, retained: receipt.retained, backupVerified: true }))
}

async function historySnapshot(chatId) {
  const response = await signedRequest('GET', `/chats/${chatId}/events`)
  assert.equal(response.status, 200, 'Signed native history stream must open')
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false, 'History stream ended before its opening snapshot')
      text += decoder.decode(chunk.value, { stream: true })
      let boundary
      while ((boundary = text.indexOf('\n\n')) >= 0) {
        const lines = text.slice(0, boundary).split('\n')
        text = text.slice(boundary + 2)
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        const frame = JSON.parse(data)
        assert.equal(frame.event, 'workbench_history')
        assert.equal(frame.value.type, 'snapshot')
        assert.equal(frame.value.header, undefined, 'Native headers must stay private')
        assert.equal(frame.display.replace, true)
        return frame
      }
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}

async function terminalRoundtrip(chat) {
  const id=randomUUID(),attachment=randomUUID()
  const created=await signedRequest('POST',`/chats/${chat.id}/terminals`,{id,cols:80,rows:24})
  const result=await created.json()
  assert.equal(created.status,201,`Native terminal creation failed: ${sanitize(JSON.stringify(result))}`)
  assert.equal(result.data.cwd,`/workspace/${chat.file_directory}`)
  const response=await signedRequest('GET',`/chats/${chat.id}/terminals/${id}/events?attachment=${attachment}`)
  assert.equal(response.status,200)
  const reader=response.body.getReader(),decoder=new TextDecoder()
  let pending='',output='',sent=false
  try {
    while(true) {
      const chunk=await reader.read()
      assert.equal(chunk.done,false,'Native terminal disconnected before its sandbox proof')
      pending+=decoder.decode(chunk.value,{stream:true})
      let boundary
      while((boundary=pending.indexOf('\n\n'))>=0) {
        const lines=pending.slice(0,boundary).split('\n');pending=pending.slice(boundary+2)
        const data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')
        if(!data)continue
        const frame=JSON.parse(data)
        assert.equal(frame.event,'workbench_terminal')
        if(frame.value.type==='snapshot') {
          assert.equal(frame.value.info.controllerId,attachment)
          assert.equal(frame.value.info.cwd,`/workspace/${chat.file_directory}`)
          output+=frame.value.screen
          if(!sent) {
            const written=await signedRequest('POST',`/chats/${chat.id}/terminals/${id}/write`,{
              attachment_id:attachment,data:`printf '\\n__TERM_CWD__%s\\n__TERM_UID__%s\\n__TERM_PS1__%s\\n' "$PWD" "$(id -u)" "$PS1"\r`,
            })
            assert.equal(written.status,200);sent=true
          }
        } else if(frame.value.type==='output')output+=frame.value.data
      }
      if(output.includes(`__TERM_CWD__/workspace/${chat.file_directory}`)&&output.includes('__TERM_UID__1000')&&output.includes('__TERM_PS1__\\w\\$ '))break
    }
  } finally {
    await reader.cancel().catch(()=>{});reader.releaseLock()
    assert.equal((await signedRequest('DELETE',`/chats/${chat.id}/terminals/${id}`)).status,200)
  }
  assert.equal(modelCalls,0,'The real terminal must not submit a model turn')
  console.log('PASS native TerminalController: signed create/follow/write/close; current session cwd; directory-only Bash prompt; owner Sandbox UID=1000; no model call')
}

try {
  if (runningRestart) modelPort = await listen(model)
  const platformPort = await listen(platform)
  const managerPort = await listen(manager)
  const home = path.join(root, 'home')
  const sandboxWorkspace = '/workspace'
  await mkdir(home)
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
  const env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home, USER: 'node', LANG: 'C.UTF-8',
    DSH_HOME: nativeAttachments ? process.env.GXZS_SMOKE_DSH_HOME : path.join(root, 'dsh'),
    GXZS_NATIVE_FILE_ATTACHMENTS: nativeAttachments ? '1' : '0', DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access',
    GXZS_SMOKE_MODEL_KEY: 'synthetic-model-key',
    GXZS_HOST_OWNER_ID: owner, GXZS_HOST_GENERATION: '1', GXZS_HOST_INSTANCE_ID: instance,
    GXZS_ASSERTION_ISSUER: 'bootstrap-smoke', GXZS_ASSERTION_SIGNING_KEY: signingKey,
    GXZS_ASSERTION_AUDIENCE_PATH: '/ai/workbench',
    GXZS_PLATFORM_INTERNAL_URL: `http://127.0.0.1:${platformPort}/internal/workbench`,
    GXZS_PLATFORM_INTERNAL_TOKEN: platformToken,
    GXZS_SANDBOX_MANAGER_URL: `http://127.0.0.1:${managerPort}`, GXZS_SANDBOX_MANAGER_TOKEN: managerToken,
    GXZS_SANDBOX_WORKSPACE_ID: workspace, GXZS_SANDBOX_WORKSPACE: sandboxWorkspace,
    GXZS_SANDBOX_NODE: '/usr/local/bin/node',
  }
  if (realSsh) {
    assert.ok(process.env.GXZS_SANDBOX_SSH_HOST, 'Real SSH mode requires the isolated sandbox alias')
    assert.match(process.env.GXZS_SANDBOX_HELPER_HASH ?? '', /^[a-f0-9]{64}$/)
    Object.assign(env, {
      PATH: process.env.PATH, HOME: process.env.HOME,
      GXZS_SANDBOX_SSH_HOST: process.env.GXZS_SANDBOX_SSH_HOST,
      GXZS_SANDBOX_HELPER: '/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
      GXZS_SANDBOX_HELPER_HASH: process.env.GXZS_SANDBOX_HELPER_HASH,
      GXZS_SANDBOX_RG: '/usr/bin/rg',
    })
  }
  const legacyProof = legacyProfile ? await seedLegacyProfile(env.DSH_HOME) : undefined
  child = spawn('/usr/local/bin/start-workbench', [], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.once('error', (error) => { childError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { hostLogs = (hostLogs + chunk.toString()).slice(-24_000) })
  await waitForHealth((status, body) => deniedCatalogs > 0 && status === 503 && body.live === true && body.ready === false,
    'unregistered catalog: HTTP 503, live=true, ready=false')
  assert.equal(acceptedCatalogs, 0, 'Catalog became available before fixture registration')
  registered = true
  await waitForHealth((status, body) => acceptedCatalogs > 0 && status === 200 && body.live === true && body.ready === true,
    'registered catalog: HTTP 200, live=true, ready=true', 30_000)
  await waitForHealth((status, body) => status === 200 && body.activity?.protocol === 2
    && body.activity.pendingScheduleReports === 0 && body.activity.activeSchedules === 0
    && body.activity.registeredSchedules === 0, 'empty schedule snapshot acknowledged', 10_000)
  await nativeClientRoundtrip()
  if (legacyProof) await assertLegacyProfileMigration(legacyProof)
  const nativeSettingsProof = await nativeSettingsRoundtrip()
  if (!sessionCreate) await restoreNativeSettings(nativeSettingsProof)
  if (sessionCreate) {
    const response = await signedRequest('POST', '/chats')
    if (fixtureFailure) throw fixtureFailure
    assert.equal(response.status, 201, 'Actual Workbench -> native sessionController.create must succeed')
    const chat = (await response.json()).data
    assert.match(chat.id, /^[a-f0-9-]{36}$/)
    assert.match(chat.file_directory, /^conversations\/\d{4}-\d{2}-\d{2}\/new-chat(?:-\d+)?$/)
    assert.ok(remoteDirectories.has(chat.file_directory), 'Sandbox mkdir must run before native creation')
    if (realSsh) remote(`printf restart-proof > /workspace/${chat.file_directory}/restart-proof.txt`)
    assert.deepEqual(await readdir(`/workspace/${chat.file_directory}`), [], 'Host cwd remains an empty placeholder')
    const detail = await signedRequest('GET', `/chats/${chat.id}`)
    assert.equal(detail.status, 200)
    // Root-context unit tests cannot detect missing Cordis service injection.
    // Use the complete composed Host and real Sandbox file operations here.
    for (const persisted of [false, true]) {
      const created = await signedRequest('POST', '/chats')
      assert.equal(created.status, 201)
      const disposable = (await created.json()).data
      if (persisted) assert.equal((await signedRequest('PATCH', `/chats/${disposable.id}`, { title: 'Deletion fixture' })).status, 200)
      if (persisted) {
        const db = new DatabaseSync(path.join(env.DSH_HOME, 'workbench.sqlite3'), { readOnly: true })
        let id
        try { id = db.prepare('SELECT session_id FROM chats WHERE id = ?').get(disposable.id).session_id }
        finally { db.close() }
        let recorded = false
        const deadline = Date.now() + 5000
        while (!recorded && Date.now() < deadline) {
          const files = await readdir(path.join(env.DSH_HOME, 'sessions'), { recursive: true })
          for (const file of files) if (file.split(path.sep).includes(id) && /\.(?:jsonl|zstd)$/.test(file))
            recorded ||= (await stat(path.join(env.DSH_HOME, 'sessions', file))).size > 0
          if (!recorded) await delay(50)
        }
        assert.ok(recorded, 'The persisted deletion fixture must have a nonempty native log before deletion')
      }
      assert.equal(remote('test ! -e /workspace/.agent-output && printf absent'), 'absent')
      const erased = await signedRequest('DELETE', `/chats/${disposable.id}`)
      if (fixtureFailure) throw fixtureFailure
      assert.equal(erased.status, 204, `Composed Host deletion failed: ${await erased.text()}`)
      assert.equal((await signedRequest('GET', `/chats/${disposable.id}`)).status, 404)
      assert.equal((await signedRequest('DELETE', `/chats/${disposable.id}`)).status, 204)
      assert.equal(sandboxFileOperation({ operation: 'stat', path: disposable.file_directory }).kind, 'missing')
      const db = new DatabaseSync(path.join(env.DSH_HOME, 'workbench.sqlite3'), { readOnly: true })
      try {
        const deletion = db.prepare('SELECT session_ids_json, completed_at FROM chat_deletions WHERE chat_id = ?').get(disposable.id)
        assert.ok(deletion?.completed_at, 'Deletion must finish, not just hide the chat')
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE id = ?').get(disposable.id).n, 0)
        const ids = JSON.parse(deletion.session_ids_json)
        const files = await readdir(path.join(env.DSH_HOME, 'sessions'), { recursive: true })
        assert.ok(files.every(name => ids.every(id => !name.split(path.sep).slice(0, -1).includes(id)) || path.basename(name) === 'session.lock'),
          'Deleted native session directories must contain only the stable writer lock')
      } finally { db.close() }
      assert.equal((await signedRequest('GET', `/chats/${chat.id}`)).status, 200)
    }
    assert.equal(modelCalls, 0, 'Deletion must not call the model')
    console.log('PASS composed Host deletion: new/persisted chats, absent spill root, physical cleanup, idempotent retry and retained neighbor')
    const nativeCommand = async (command) => {
      const response = await signedRequest('POST', `/chats/${chat.id}/commands`, {command, request_key:randomUUID()})
      assert.equal(response.status, 200, `Native command ${command} must be available in the composed host`)
      return (await response.json()).data
    }
    const planned = await nativeCommand('/plan')
    assert.equal(planned.state.plan.active, true, 'Plan command must update the native projection')
    const unplanned = await nativeCommand('/plan off')
    assert.equal(unplanned.state.plan.active, false, 'Plan exit must clear the native projection')
    const goalStatus = await nativeCommand('/goal')
    assert.equal(goalStatus.state.goal, null, 'Status-only goal command must not create an objective')
    assert.equal(modelCalls, 0, 'Mode toggles and goal status must not submit a model turn')
    const invalidCompact = await signedRequest('POST', `/chats/${chat.id}/commands`, {command:'/compact invalid', request_key:randomUUID()})
    assert.equal(invalidCompact.status, 409, 'Registered native compact command must reject arguments')
    assert.ok(JSON.stringify(await invalidCompact.json()).includes('Usage: /compact'), 'Expected the native compact argument validation')
    console.log('PASS native commands: plan on/off projections; goal status without submission; compact argument validation')
    if (realSsh) {
      const references = await signedRequest('GET', `/chats/${chat.id}/references?query=restart-proof`)
      const referenceResponse = await references.json()
      assert.equal(references.status, 200, `Native reference search must work through the full host: ${sanitize(JSON.stringify(referenceResponse))}`)
      const candidates = referenceResponse.data
      assert.ok(candidates.some(item => item.group === 'files' && item.kind === 'file' && item.path === 'restart-proof.txt'),
        `Reference search must find the sandbox file relative to the native session cwd: ${JSON.stringify(candidates)}`)
      assert.ok(candidates.every(item => !item.cwd), 'Reference candidates must not expose host cwd')
      console.log('PASS native file references: sandbox-only file discovered; host cwd not exposed')
      await terminalRoundtrip(chat)
    }
    const scheduleResponse = await signedRequest('POST', `/chats/${chat.id}/schedules`, {
      title: 'Fixture scheduled reminder', prompt: 'Synthetic future reminder', after_seconds: 3600,
      notify_enabled: true, request_key: randomUUID(),
    })
    assert.equal(scheduleResponse.status, 201, 'Full host must resolve the late native schedule service')
    const task = (await scheduleResponse.json()).data
    assert.equal(task.notification_error, undefined, 'Creation notification preference must be confirmed')
    const tasks = (await (await signedRequest('GET', '/schedules')).json()).data
    const listed = tasks.find(item => item.id === task.id && item.chat_id === chat.id)
    assert.ok(listed?.notification_available && listed.notify_enabled, 'Catalog must expose initialized notification settings')
    await waitForHealth((status, body) => status === 200 && body.activity?.protocol === 2
      && body.activity.activeSchedules === 1 && body.activity.registeredSchedules === 1
      && body.activity.pendingScheduleReports === 0, 'future task wakeup acknowledged', 10_000)
    const updatedTask = await signedRequest('PATCH', `/schedules/${task.id}`, { expected: task, title: 'Updated fixture reminder',
      notify_enabled: false, notification_version: listed.notification_version })
    assert.equal(updatedTask.status, 200)
    const updatedRecord = (await updatedTask.json()).data
    assert.equal(updatedRecord.record.title, 'Updated fixture reminder')
    assert.equal(updatedRecord.notification_error, undefined)
    const changedTasks = (await (await signedRequest('GET', '/schedules')).json()).data
    assert.equal(changedTasks.find(item => item.id === task.id)?.notify_enabled, false)
    assert.equal((await signedRequest('DELETE', `/schedules/${task.id}`)).status, 200)
    await waitForHealth((status, body) => status === 200 && body.activity?.protocol === 2
      && body.activity.activeSchedules === 0 && body.activity.registeredSchedules === 0
      && body.activity.pendingScheduleReports === 0, 'deleted task wakeup acknowledged', 10_000)
    assert.equal(modelCalls, 0, 'Schedule management must not call the model')
    console.log('PASS native schedule HTTP: notification initialization/update, wakeup acknowledgment and deletion through the full host')
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
    // Keep independent persisted sessions cold across restart, including the
    // active-turn recovery fixture which resumes its own session automatically.
    const coldChats = []
    const persistedBefore = sessions.filter(name => name.endsWith('.zstd')).length
    for (let index = 0; index < 3; index++) {
      const created = await signedRequest('POST', '/chats')
      assert.equal(created.status, 201)
      const cold = (await created.json()).data
      assert.equal((await signedRequest('PATCH', `/chats/${cold.id}`, { title: `Cold catalog fixture ${index}` })).status, 200)
      coldChats.push(cold)
    }
    const coldDeadline = Date.now() + 5000
    while (Date.now() < coldDeadline) {
      sessions = await readdir(path.join(env.DSH_HOME, 'sessions'), { recursive: true })
      if (sessions.filter(name => name.endsWith('.zstd')).length >= persistedBefore + coldChats.length) break
      await delay(50)
    }
    assert.ok(sessions.filter(name => name.endsWith('.zstd')).length >= persistedBefore + coldChats.length)
    let runningId
    if (runningRestart) {
      const submitted = await signedRequest('POST', `/chats/${chat.id}/runs`, { query: 'Synthetic recovery probe', request_key: 'crash-probe' })
      assert.equal(submitted.status, 202)
      runningId = (await submitted.json()).data.id
      assert.ok(runningId)
      const deadline = Date.now() + 20_000
      while (!modelCalls && Date.now() < deadline) await delay(100)
      if (!modelCalls) {
        const diagnostic = await signedRequest('GET', `/runs/${runningId}`)
        process.stderr.write(`Fixture run diagnostic: ${sanitize(JSON.stringify(await diagnostic.json()))}\n`)
        if (fixtureFailure) throw fixtureFailure
      }
      assert.equal(modelCalls, 1, 'Native agent must reach the fixture model before restart')
      const active = await signedRequest('GET', `/runs/${runningId}`)
      assert.equal((await active.json()).data.status, 'running')
    }
    await stopHost(crashRestart ? 'SIGKILL' : 'SIGTERM')
    child = spawn('/usr/local/bin/start-workbench', [], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.once('error', error => { childError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { hostLogs = (hostLogs + chunk.toString()).slice(-24_000) })
    await waitForHealth((status, body) => status === 200 && body.ready === true, 'restarted host with native session', 30_000)
    await restoreNativeSettings(nativeSettingsProof, { restarted: true })
    const callsBeforeColdReads = modelCalls
    for (const cold of coldChats) {
      const [catalog, history] = await Promise.all([
        signedRequest('GET', `/catalog?chat_id=${cold.id}`), historySnapshot(cold.id),
      ])
      assert.equal(catalog.status, 200, 'Cold scoped catalog must share the native history resume')
      assert.ok((await catalog.json()).data.skills.some(skill =>
        skill.id === `personal:${fixtureSkill.id}` && skill.name === fixtureSkill.id && skill.scope === 'personal'))
      assert.ok(history.session_id)
    }
    assert.equal(modelCalls, callsBeforeColdReads, 'Concurrent cold reads must not submit model turns')
    console.log('PASS concurrent cold catalog and history: three persisted sessions; scoped skills; no writer conflict or model replay')
    if (runningRestart) {
      const recovered = await signedRequest('GET', `/runs/${runningId}`)
      assert.equal((await recovered.json()).data.status, 'interrupted', 'In-flight native turn must not stay falsely running')
      await delay(1500)
      assert.equal(modelCalls, 1, 'Recovery must not silently replay the admitted task')
      const retried = await signedRequest('POST', `/chats/${chat.id}/runs`, {
        query: 'Explicit recovery retry', request_key: 'crash-probe-retry', retry_of: runningId,
      })
      assert.equal(retried.status, 202)
      const retryId = (await retried.json()).data.id
      assert.notEqual(retryId, runningId, 'Explicit retry must retain the original interrupted receipt')
      let retryStatus
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        const result = await signedRequest('GET', `/runs/${retryId}`)
        retryStatus = (await result.json()).data.status
        if (['completed', 'failed', 'interrupted'].includes(retryStatus)) break
        await delay(100)
      }
      assert.equal(retryStatus, 'completed', 'Same session must execute a new explicit retry after recovery')
      assert.equal(modelCalls, 2, 'Only the original attempt and explicit retry may call the model')
    }
    const resumed = await signedRequest('PATCH', `/chats/${chat.id}`, { title: 'Native resume smoke' })
    assert.equal(resumed.status, 200, 'Native cold-session resume must succeed after host restart')
    if (realSsh) assert.equal(remote(`cat /workspace/${chat.file_directory}/restart-proof.txt`), 'restart-proof',
      'Sandbox file must survive host restart')
    assert.deepEqual(await readdir(`/workspace/${chat.file_directory}`), [], 'Native create and resume must leave cwd empty')
    if (runningRestart) {
      const targetResponse = await signedRequest('POST', '/chats')
      assert.equal(targetResponse.status, 201)
      const target = (await targetResponse.json()).data
      const candidateResponse = await signedRequest('GET', `/chats/${target.id}/references?query=Native`)
      assert.equal(candidateResponse.status, 200)
      const source = (await candidateResponse.json()).data.find(item => item.chatId === chat.id)
      assert.ok(source?.mention, 'Source conversation must provide a native mention token')
      verifyReferenceContext = true
      const submission = await signedRequest('POST', `/chats/${target.id}/runs`, {
        query: `Summarize the referenced conversation ${source.mention}`, request_key: 'reference-context-probe',
        resource_mentions: { plugins: [fixtureTool.provider] },
      })
      assert.equal(submission.status, 202)
      const referenceRun = (await submission.json()).data.id
      let status
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        if (fixtureFailure) throw fixtureFailure
        status = (await (await signedRequest('GET', `/runs/${referenceRun}`)).json()).data.status
        if (['completed', 'failed', 'interrupted'].includes(status)) break
        await delay(100)
      }
      assert.equal(status, 'completed', 'Cross-conversation reference run must complete')
      assert.ok(referenceContextVerified, 'Reference context must be observed in the actual model request')
      assert.equal(pluginCalls, 1, 'Selected plugin must complete one actual tool roundtrip')
      assert.equal(modelCalls, 5, 'Task requests must contain the initial attempt, retry, discovery, plugin call and plugin result')
      console.log(`PASS native conversation reference and selected plugin roundtrip; task_model_calls=${modelCalls}; title_model_calls=${titleCalls}`)
      const historyResponse = await signedRequest('GET', `/chats/${target.id}/history?native=1`)
      assert.equal(historyResponse.status, 200, 'Signed native history page must be available after tool completion')
      const history = (await historyResponse.json()).data
      assert.ok(history.runs.some(run => run.id === referenceRun), 'Native page must retain the business run identity')
      const first = await historySnapshot(target.id)
      const second = await historySnapshot(target.id)
      assert.equal(first.session_id, second.session_id, 'Reconnection must remain in the same native session')
      assert.deepEqual(first.display.events, second.display.events, 'Reopening a completed session must not duplicate or rewrite output')
      const discoveryResult = second.display.events.find(item => item.run_id === referenceRun
        && item.event.data?.stage === 'returned' && item.event.data?.tool_name === 'tool_search')
      assert.equal(discoveryResult?.event.data?.display_name, '查找工具')
      const toolResult = second.display.events.find(item => item.run_id === referenceRun
        && item.event.data?.stage === 'returned' && item.event.data?.tool_name === fixtureTool.tool_name)
      assert.equal(toolResult?.event.data?.provider_name, fixtureTool.provider_name)
      assert.equal(toolResult?.event.data?.display_name, fixtureTool.tool_name)
      assert.equal(modelCalls, 5, 'History reads and reconnects must not submit or replay a model turn')
      console.log('PASS signed native history: completed plugin result; page/run identity; reconnect baseline stable; no model replay')
      verifyReferenceContext = false
      verifySkillContext = true
      const skillResponse = await signedRequest('POST', `/chats/${target.id}/runs`, {
        query: 'Use the named skill', request_key: 'skill-context-probe', resource_mentions: { skills: [fixtureSkill.id] },
      })
      assert.equal(skillResponse.status, 202)
      const skillRun = (await skillResponse.json()).data.id
      let skillStatus
      const skillDeadline = Date.now() + 20_000
      while (Date.now() < skillDeadline) {
        if (fixtureFailure) throw fixtureFailure
        skillStatus = (await (await signedRequest('GET', `/runs/${skillRun}?view=state`)).json()).data.status
        if (['completed', 'failed', 'interrupted'].includes(skillStatus)) break
        await delay(100)
      }
      assert.equal(skillStatus, 'completed', 'Named personal skill must complete through the native gesture')
      assert.equal(modelCalls, 6)
      const skillHistory = await historySnapshot(target.id)
      assert.ok(!skillHistory.display.events.some(item => item.run_id === skillRun
        && item.event.data?.stage === 'started' && item.event.data?.tool_name === 'skill'),
      'The native gesture must not require a redundant model skill call')
      const skillState = (await (await signedRequest('GET', `/runs/${skillRun}?view=state`)).json()).data
      assert.equal(skillState.query, 'Use the named skill')
      assert.ok(skillState.mentioned_resources.some(item => item.kind === 'skills'
        && item.id === fixtureSkill.id && item.name === '技能装配测试'))
      console.log('PASS named personal skill: native gesture, first-request skill body, original query and resource display name')
      if (nativeAttachments) {
        verifyReferenceContext = false
        verifySkillContext = false
        const uploads = []
        for (const [extension, data] of [
          ['txt', Buffer.from('durable-native-evidence').toString('base64')],
          ['png', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='],
        ]) {
          const response = await signedRequest('POST', '/files', { path: `${target.file_directory}/native-evidence.${extension}`, data, version: null })
          assert.equal(response.status, 200, 'Actual file upload route must accept the fixture')
          uploads.push((await response.json()).data)
        }
        verifyAttachmentContext = true
        async function attachmentTurn(query, files = []) {
          const response = await signedRequest('POST', `/chats/${target.id}/runs`, { query, files, request_key: randomUUID() })
          assert.equal(response.status, 202)
          const run = (await response.json()).data
          const deadline = Date.now() + 20_000
          while (Date.now() < deadline) {
            if (fixtureFailure) throw fixtureFailure
            const state = (await (await signedRequest('GET', `/runs/${run.id}?view=state`)).json()).data
            if (state.status === 'completed') return run.id
            assert.ok(!['failed', 'interrupted'].includes(state.status), JSON.stringify(state))
            await delay(100)
          }
          throw new Error('Native attachment turn did not complete')
        }
        await attachmentTurn('Read uploaded file and image', uploads.map(({ path, version }) => ({ path, version })))
        assert.equal(modelCalls, 7)
        await stopHost()
        child = spawn('/usr/local/bin/start-workbench', [], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        child.once('error', error => { childError = error })
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { hostLogs = (hostLogs + chunk.toString()).slice(-24_000) })
        await waitForHealth((status, body) => status === 200 && body.ready === true, 'cold native attachment resume', 30_000)
        await attachmentTurn('Read the same attachments after cold restart')
        assert.equal(modelCalls, 8, 'Cold continuation must submit only the new user turn')
        assert.equal(fixtureFiles.size, 2)
        console.log('PASS native file/image upload: real shared mount, native model paths, exact SSH bytes, cold history continuation without reupload')
        const current = (await (await signedRequest('GET', `/chats/${target.id}`)).json()).data
        const changed = await signedRequest('PUT', `/chats/${target.id}/config`, {
          version: current.version, selection: { ...current.selection, model: 'smoke/text-only' },
        })
        assert.equal(changed.status, 200)
        const rejected = await signedRequest('POST', `/chats/${target.id}/runs`, {
          query: 'Image validation must remain owned by native DSH',
          files: uploads.filter(file => file.path.endsWith('.png')).map(({ path, version }) => ({ path, version })),
          request_key: randomUUID(),
        })
        assert.equal(rejected.status, 202)
        const rejectedId = (await rejected.json()).data.id
        let rejectedState
        const rejectionDeadline = Date.now() + 20_000
        while (Date.now() < rejectionDeadline) {
          if (fixtureFailure) throw fixtureFailure
          rejectedState = (await (await signedRequest('GET', `/runs/${rejectedId}`)).json()).data
          if (['failed', 'completed', 'interrupted'].includes(rejectedState.status)) break
          await delay(100)
        }
        assert.equal(rejectedState.status, 'failed')
        assert.equal(rejectedState.error, '所选模型不支持图片输入，请选择支持图片的模型后重新发送')
        assert.ok(rejectedState.events.some(event => event.event === 'workbench_end' && event.error_code === 'session/attachment-invalid'))
        const stateOnly = (await (await signedRequest('GET', `/runs/${rejectedId}?view=state`)).json()).data
        assert.equal(stateOnly.error, rejectedState.error)
        assert.equal(modelCalls, 8, 'Native attachment validation must reject before requesting the model')
        console.log('PASS native image admission rejection: specific reason preserved in full and state-only history; no model request')
      }
    }
  }
  if (runningRestart && realSsh) {
    const created = await signedRequest('POST', '/chats')
    assert.equal(created.status, 201)
    const target = (await created.json()).data
    const detail = (await (await signedRequest('GET', `/chats/${target.id}`)).json()).data
    malformedToolProbe = { calls: 0, path: `/workspace/${detail.file_directory}/guard-count.txt` }
    assert.match(malformedToolProbe.path, /^\/workspace\/conversations\/\d{4}-\d{2}-\d{2}\/new-chat(?:-\d+)?\/guard-count\.txt$/)
    const submitted = await signedRequest('POST', `/chats/${target.id}/runs`, { query: 'Exercise malformed provider recovery', request_key: 'malformed-tool-probe' })
    assert.equal(submitted.status, 202)
    const runId = (await submitted.json()).data.id
    let state
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (fixtureFailure) throw fixtureFailure
      state = (await (await signedRequest('GET', `/runs/${runId}`)).json()).data
      assert.ok(!['failed','interrupted'].includes(state.status), JSON.stringify(state))
      if (state.status === 'completed') break
      await delay(100)
    }
    assert.equal(state.status, 'completed')
    assert.equal(malformedToolProbe.calls, 3)
    assert.equal(remote(`wc -l < '${malformedToolProbe.path}'`).trim(), '1', 'Valid sibling in rejected response must not execute')
    malformedToolProbe = undefined
    console.log('PASS malformed model tools: native bounded recovery, valid sibling executes once, readable completed history')
  }
  if (fixtureFailure) throw fixtureFailure
  passed = true
} catch (error) {
  process.stderr.write(`FAIL host bootstrap: ${sanitize(error.message)}\n${sanitize(hostLogs)}\n`)
  process.exitCode = 1
} finally {
  try { await stopHost() }
  catch (error) { passed = false; process.exitCode = 1; process.stderr.write(`FAIL host cleanup: ${sanitize(error.message)}\n`) }
  for (const server of [platform, manager, model]) {
    server.closeAllConnections()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
  }
  await rm(root, { recursive: true, force: true })
}
if (passed) process.stdout.write(`PASS host bootstrap: unauthorized -> live/not-ready -> registered/ready${sessionCreate ? '; non-root native session create=201/detail=200/rename=200/cold-resume=200; empty local cwd and SSH tool overrides; real SSH sandbox file survives host restart' : '; fresh native profile over real SSH, no user Session or model turn'}${sessionCreate ? `; restart=${crashRestart ? 'SIGKILL' : 'SIGTERM'}` : ''}${runningRestart ? '; active turn recovered as interrupted; no duplicate model request; explicit retry completed in same session' : ''}; process group stopped\n`)
