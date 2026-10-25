#!/usr/bin/env node
/** Deterministic OpenAI-compatible model. Executes no tools and calls no upstream. */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { mixedStep, specialStep, observe } from './scenarios.mjs'

export function scenarioFrom(messages) {
  const text = messages.filter(item => item.role === 'user').map(item => typeof item.content === 'string'
    ? item.content : (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n')
  const start = text.lastIndexOf('GXZS_SIM_CASE {')
  if (start < 0) return null
  let source = text.slice(start + 'GXZS_SIM_CASE '.length)
  // Native schedules and goal objectives quote the prompt inside a JSON envelope.
  if (source.startsWith('{\\"')) {
    let decoded
    for (let end = source.indexOf('}'); end >= 0 && end < 16384; end = source.indexOf('}', end + 1)) {
      try {
        const candidate = JSON.parse('"' + source.slice(0, end + 1) + '"')
        JSON.parse(candidate); decoded = candidate; break
      } catch { /* The next closing brace may finish the embedded object. */ }
    }
    if (decoded === undefined) throw new Error('Incomplete quoted synthetic scenario')
    source = decoded
  }
  let depth = 0, quoted = false, escaped = false, end = -1
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false }
    else if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) { end = index + 1; break }
  }
  if (end < 0) throw new Error('Incomplete synthetic scenario')
  const value = JSON.parse(source.slice(0, end))
  if (value.kind === 'scheduled-delivery') value.kind = 'schedule-delivery'
  if (!['chain', 'mixed', 'schedule-delivery', 'goal', 'browser-recovery'].includes(value.kind ?? 'chain')) throw new Error('Invalid scenario kind')
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)) throw new Error('Invalid fixture case id')
  const maximumId = { mixed: 48, 'schedule-delivery': 55 }[value.kind] ?? 64
  if (value.id.length > maximumId) throw new Error('Case ID exceeds its scenario family limit')
  if (!Number.isInteger(value.rounds ?? 10) || (value.rounds ?? 10) < 1 || (value.rounds ?? 10) > 10000) throw new Error('Invalid rounds')
  const minimumRounds = { goal: 6, 'browser-recovery': 3 }[value.kind] ?? 1
  if ((value.rounds ?? 10) < minimumRounds) throw new Error(`Scenario ${value.kind} requires at least ${minimumRounds} rounds`)
  if (!Number.isFinite(value.durationMs ?? 0) || (value.durationMs ?? 0) < 0 || (value.durationMs ?? 0) > 86400000) throw new Error('Invalid duration')
  if (!Number.isInteger(value.stepDelayMs ?? 100) || (value.stepDelayMs ?? 100) < 0 || (value.stepDelayMs ?? 100) > 30000) throw new Error('Invalid step delay')
  if (!Number.isInteger(value.argumentChunkSize ?? 256) || (value.argumentChunkSize ?? 256) < 64 || (value.argumentChunkSize ?? 256) > 65536) throw new Error('Invalid chunk size')
  if (value.fault && (!['http429', 'http503', 'http403', 'disconnect'].includes(value.fault.mode)
      || !Number.isInteger(value.fault.step) || value.fault.step < 0
      || !Number.isInteger(value.fault.count) || value.fault.count < 1 || value.fault.count > 3)) throw new Error('Invalid synthetic model fault')
  return { ...value, kind: value.kind ?? 'chain', rounds: value.rounds ?? 10,
    durationMs: value.durationMs ?? 0, stepDelayMs: value.stepDelayMs ?? 100 }
}

export function completedSteps(messages, id) {
  const calls = new Map()
  for (const message of messages) for (const call of message.tool_calls ?? []) calls.set(call.id, call)
  const prefix = `sim_${id}_`
  return messages.filter(message => message.role === 'tool' && message.tool_call_id?.startsWith(prefix))
    .map(message => ({ step: Number(message.tool_call_id.slice(prefix.length)), message, call: calls.get(message.tool_call_id) }))
    .filter(item => Number.isSafeInteger(item.step)).sort((a, b) => a.step - b.step)
}

export function planStep(scenario, step, state, body) {
  const tools = new Map((body.tools ?? []).map(tool => [tool.function?.name, tool.function]))
  const finished = step >= scenario.rounds && Date.now() - state.startedAt >= scenario.durationMs && (scenario.kind !== 'mixed' || step % 40 === 0)
  if (finished) return { content: `GXZS_SIM_DONE ${scenario.id} steps=${step}` }
  const planned = scenario.kind === 'mixed' ? mixedStep(scenario, step, state) : specialStep(scenario, step, state, body)
  if (planned.intermediate) return planned
  if (!tools.has(planned.name)) throw new Error(`Native tool schema is missing: ${planned.name}`)
  state.expected ??= {}; if (planned.expected) state.expected[step] = planned.expected
  return planned
}

async function completion(res, body, planned, { id, created, signal, callId, chunkSize = 256 }) {
  const identity = { id: `chatcmpl-${id}`, created, model: body.model ?? 'gxzs-simulator' }
  const reason = planned.name ? 'tool_calls' : 'stop'
  // Synthetic counters exercise usage handling; they are not tokenizer or billing data.
  const usage = { prompt_tokens: 100, completion_tokens: planned.name ? 20 : 10,
    total_tokens: planned.name ? 120 : 110 }
  const args = planned.name ? JSON.stringify(planned.arguments) : null
  if (body.stream !== true) {
    const message = { role: 'assistant', content: planned.name ? null : planned.content }
    if (planned.name) message.tool_calls = [{ id: callId, type: 'function', function: { name: planned.name, arguments: args } }]
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ...identity, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: reason }], usage }))
    return
  }
  const includeUsage = body.stream_options?.include_usage === true
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  const write = async value => {
    signal.throwIfAborted()
    if (!res.write(value)) await once(res, 'drain', { signal })
  }
  const frame = (delta, finish_reason = null) => write(`data: ${JSON.stringify({ ...identity,
    object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...(includeUsage ? { usage: null } : {}) })}\n\n`)
  await frame({ role: 'assistant', content: '' })
  if (planned.name) {
    await frame({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: planned.name, arguments: '' } }] })
    for (let offset = 0; offset < args.length; offset += chunkSize) {
      await frame({ tool_calls: [{ index: 0, function: { arguments: args.slice(offset, offset + chunkSize) } }] })
      if (offset && offset % 65536 === 0) await delay(1, undefined, { signal })
    }
  } else {
    for (let offset = 0; offset < planned.content.length; offset += chunkSize) await frame({ content: planned.content.slice(offset, offset + chunkSize) })
  }
  await frame({}, reason)
  if (includeUsage) await write(`data: ${JSON.stringify({ ...identity, object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
  res.end('data: [DONE]\n\n')
}

export async function createSimulator({ token, output, host = '127.0.0.1', port = 0, publicURL, extraHandler }) {
  if (!token || token.length < 32) throw new Error('An explicit fixture token of at least 32 characters is required')
  await mkdir(output, { recursive: true })
  const cases = new Map(), active = new Set()
  try { for (const [id, state] of JSON.parse(await readFile(`${output}/case-state.json`, 'utf8'))) cases.set(id, state) } catch (error) { if (error.code !== 'ENOENT') throw error }
  let persistence = Promise.resolve()
  const persist = () => persistence = persistence.then(async () => {
    await writeFile(`${output}/case-state.json.tmp`, JSON.stringify([...cases]))
    await rename(`${output}/case-state.json.tmp`, `${output}/case-state.json`)
  })
  const stats = { requests: 0, modelRequests: 0, titleRequests: 0, toolResponses: 0, completed: 0, errors: 0, rejected: 0, maxInFlight: 0, upstreamCalls: 0 }
  const record = async value => appendFile(`${output}/model-events.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n')
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
  const server = http.createServer(async (req, res) => {
    const id = randomUUID(), created = Math.floor(Date.now() / 1000); active.add(id); stats.requests++; stats.maxInFlight = Math.max(stats.maxInFlight, active.size)
    const abort = new AbortController(); res.once('close', () => abort.abort())
    try {
      const url = new URL(req.url, 'http://fixture')
      if (url.pathname === '/healthz') return json(res, 200, { ok: true, simulated: true, upstreamCalls: 0 })
      if (url.pathname === '/fixture/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>合成浏览器验收</title><h1>合成计数：<span id="count">0</span></h1><button onclick="document.getElementById(\'count\').textContent=Number(document.getElementById(\'count\').textContent)+1">增加计数</button>'); return
      }
      if (url.pathname === '/fixture/slow-page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><title>慢页面恢复验收</title><h1>合成慢页面</h1><script src="/fixture/slow-script"></script>'); return
      }
      if (url.pathname === '/fixture/slow-script') {
        await delay(25000, undefined, { signal: abort.signal })
        res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('document.body.dataset.loaded="true"'); return
      }
      if (req.headers.authorization !== `Bearer ${token}` && !url.pathname.startsWith('/internal/')) { stats.rejected++; return json(res, 401, { error: { message: 'Fixture authorization required' } }) }
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 48 * 1024 * 1024) throw new Error('Fixture request exceeds 48 MiB'); chunks.push(chunk) }
      const body = size ? JSON.parse(Buffer.concat(chunks)) : {}
      if (url.pathname === '/__test/status') return json(res, 200, { ...stats, active: active.size - 1, cases: [...cases].map(([id, state]) => ({ id, ...state })) })
      if (extraHandler && await extraHandler({ req, res, url, body, json, token, stats })) return
      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return json(res, 404, { error: { message: 'Unknown fixture route' } })
      stats.modelRequests++
      const scenario = (body.tools ?? []).length ? scenarioFrom(body.messages ?? []) : null
      if (!scenario) {
        if ((body.tools ?? []).length) throw new Error('Execution request has no synthetic case marker')
        stats.titleRequests++
        await completion(res, body, { content: '模拟稳定性验收' }, { id, created, signal: abort.signal }); return
      }
      let state = cases.get(scenario.id)
      if (!state) { state = { startedAt: Date.now(), requests: 0, maxStep: -1, observedStep: -1, tools: [], completed: false, fixtureURL: publicURL }; cases.set(scenario.id, state) }
      state.requests++
      if (state.requests === 1) await writeFile(`${output}/schemas-${scenario.id}.json`, JSON.stringify(body.tools ?? [], null, 2))
      const completed = completedSteps(body.messages ?? [], scenario.id)
      for (const item of completed.filter(item => item.step > state.observedStep)) {
        if (scenario.kind === 'chain' && item.call?.function?.name === 'bash' && !JSON.stringify(item.message.content).includes(`GXZS_SIM_STEP ${scenario.id} ${item.step}`)) throw new Error('A real tool result failed its expected marker; refuse a false success')
        const result = observe(scenario, item, state)
        await appendFile(`${output}/results-${scenario.id}.jsonl`, JSON.stringify(result) + '\n'); state.observedStep = item.step
      }
      const step = completed.length ? completed.at(-1).step + 1 : 0
      state.maxStep = Math.max(state.maxStep, step)
      const planned = planStep(scenario, step, state, body)
      if (scenario.fault?.step === step && (state.injectedFaults ?? 0) < scenario.fault.count) {
        state.injectedFaults = (state.injectedFaults ?? 0) + 1
        await persist(); await record({ case: scenario.id, event: 'injected_model_failure', mode: scenario.fault.mode, step })
        if (scenario.fault.mode !== 'disconnect') {
          if (scenario.fault.mode === 'http429') res.setHeader('retry-after', '1')
          return json(res, Number(scenario.fault.mode.slice(4)), { error: { message: 'Synthetic provider fault', type: 'fixture_injected' } })
        }
        res.writeHead(200, { 'content-type': body.stream === true ? 'text/event-stream' : 'application/json' })
        if (body.stream === true) res.write(`data: ${JSON.stringify({ id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `sim_${scenario.id}_${step}`, type: 'function', function: { name: 'bash', arguments: '{"command":' } }] }, finish_reason: null }] })}\n\n`)
        else res.write('{"id":')
        await delay(50); res.destroy(); return
      }
      await persist()
      await delay(Math.min(30000, Math.max(0, scenario.stepDelayMs)), undefined, { signal: abort.signal })
      if (planned.name) {
        stats.toolResponses++; state.tools.push(planned.name); if (state.tools.length > 50) state.tools.shift()
      } else {
        if (!planned.intermediate) { state.completed = true; stats.completed++ }
      }
      await completion(res, body, planned, { id, created, signal: abort.signal,
        callId: `sim_${scenario.id}_${step}`, chunkSize: scenario.argumentChunkSize ?? 256 })
      await persist()
      await record({ case: scenario.id, step, tool: planned.name ?? null, inputBytes: size, complete: !planned.name && !planned.intermediate })
    } catch (error) {
      if (!abort.signal.aborted) { stats.errors++; await record({ error: error.message }); if (!res.headersSent) json(res, 500, { error: { message: error.message, type: 'fixture_error' } }); else res.destroy() }
    } finally { active.delete(id) }
  })
  server.requestTimeout = 120000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  const drain = async () => { while (active.size) await delay(5); await persistence }
  return { server, stats, cases, record, drain, port: server.address().port }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const simulator = await createSimulator(config)
  console.log(JSON.stringify({ ready: true, port: simulator.port, upstreamCalls: 0 }))
}
