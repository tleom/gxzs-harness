import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createSimulator, planStep, scenarioFrom } from './simulator.mjs'

test('scenario defaults are normalized and identifiers and delays are typed', () => {
  const parse = value => scenarioFrom([{role:'user',content:`GXZS_SIM_CASE ${JSON.stringify(value)}`}])
  assert.equal(parse({id:'nullable',rounds:null,kind:null}).rounds, 10)
  assert.equal(parse({id:'nullable',rounds:null,kind:null}).kind, 'chain')
  assert.throws(() => parse({id:123}), /case id/)
  for (const stepDelayMs of [-1, '100', 30001]) assert.throws(() => parse({id:'bad',stepDelayMs}), /step delay/)
})

test('scenario IDs reserve room for generated child and delivery names', () => {
  for (const [kind, maximum] of [['chain',64], ['mixed',48], ['schedule-delivery',55]]) {
    const parse = length => scenarioFrom([{role:'user',content:`GXZS_SIM_CASE ${JSON.stringify({id:'a'.repeat(length),kind})}`}])
    assert.equal(parse(maximum).id.length, maximum)
    assert.throws(() => parse(maximum+1), /case id|family limit/)
  }
})

test('special scenarios cannot finish before their defining verification step', () => {
  for (const [kind, minimum] of [['goal', 6], ['browser-recovery', 3]]) {
    for (let rounds = 1; rounds < minimum; rounds++) {
      assert.throws(() => scenarioFrom([{ role: 'user', content: `GXZS_SIM_CASE ${JSON.stringify({ id: 'short', kind, rounds })}` }]), /requires at least/)
    }
    const scenario = scenarioFrom([{ role: 'user', content: `GXZS_SIM_CASE ${JSON.stringify({ id: 'complete', kind, rounds: minimum })}` }])
    assert.equal(scenario.rounds, minimum)
  }
})

const token = 'synthetic-test-token-with-no-upstream-credentials'
const tools = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }]

test('synthetic platform forwards the manager-owned MCP policy after authenticating the binding', async t => {
  const policy = { request_bytes: 123456, response_bytes: 234567, max_call_seconds: 45, catalog_timeout_seconds: 90 }
  let requests = 0
  const manager = createServer((req, res) => {
    requests++
    assert.equal(req.url, '/mcp-policy')
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(policy))
  })
  await new Promise(resolve => manager.listen(0, '127.0.0.1', resolve))
  t.after(async () => { manager.closeAllConnections(); await new Promise(resolve => manager.close(resolve)) })
  const output = await mkdtemp(path.join(os.tmpdir(), 'gxzs-sim-platform-'))
  t.after(() => rm(output, { recursive: true }))
  const owner = 'soak1017:910001', instance = 'fixture-instance'
  await writeFile(path.join(output, 'bindings.json'), JSON.stringify([{ owner_id: owner, generation: 1, instance_id: instance }]))
  const config = path.join(output, 'config.json')
  await writeFile(config, JSON.stringify({ token, output, host: '127.0.0.1', port: 0,
    managerURL: `http://127.0.0.1:${manager.address().port}`, globalSkills: [] }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./platform.mjs', import.meta.url)), config], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  t.after(async () => { child.kill(); await exited })
  const ready = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('Synthetic platform did not start')), 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', chunk => {
      text += chunk
      if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(text.split('\n')[0])) }
    })
  })
  const url = `http://127.0.0.1:${ready.port}/internal/workbench/mcp/policy`
  assert.equal((await fetch(url)).status, 401)
  assert.equal(requests, 0)
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`,
    'x-gxzs-owner': owner, 'x-gxzs-host-generation': '1', 'x-gxzs-host-instance': instance } })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { data: { policy } })
  assert.equal(requests, 1)
  const wakeupURL = `http://127.0.0.1:${ready.port}/internal/workbench/schedule-wakeups`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-gxzs-owner': owner, 'x-gxzs-host-generation': '1', 'x-gxzs-host-instance': instance }
  const empty = await fetch(wakeupURL, { method: 'POST', headers, body: JSON.stringify({ sequence: 3, tasks: [] }) })
  assert.equal(empty.status, 200)
  assert.deepEqual(await empty.json(), { data: { sequence: 3, tasks: [], complete: true } })
  const active = await fetch(wakeupURL, { method: 'POST', headers, body: JSON.stringify({ sequence: 4, tasks: [{ id: 'future' }] }) })
  assert.equal(active.status, 503)
})

async function fixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'gxzs-sim-test-'))
  const simulator = await createSimulator({ token, output })
  t.after(async () => { simulator.server.closeAllConnections(); await new Promise(resolve => simulator.server.close(resolve)); await simulator.drain(); await rm(output, { recursive: true }) })
  return { ...simulator, call: async body => {
    const response = await fetch(`http://127.0.0.1:${simulator.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() }
  } }
}
const request = (id, extra = []) => ({ model: 'gxzs-simulator', stream: true, tools, messages: [{ role: 'user', content: `GXZS_SIM_CASE ${JSON.stringify({ id, rounds: 1, stepDelayMs: 0 })}` }, ...extra] })
function toolCall(text) {
  const result = { arguments: '' }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: {')) continue
    const call = JSON.parse(line.slice(6)).choices[0]?.delta.tool_calls?.[0]
    if (!call) continue
    result.id ??= call.id; result.name ??= call.function.name; result.arguments += call.function.arguments ?? ''
  }
  return result
}

test('retries reproduce the same call and do not advance without a tool result', async t => {
  const server = await fixture(t), body = request('retry')
  const first = toolCall((await server.call(body)).text), second = toolCall((await server.call(body)).text)
  assert.deepEqual(first, second); assert.equal(first.id, 'sim_retry_0')
  assert.equal(JSON.parse(first.arguments).command.includes('GXZS_SIM_STEP retry 0'), true)
  assert.equal(server.stats.completed, 0)
})
test('a genuine tool-result marker completes the scripted case', async t => {
  const server = await fixture(t), initial = toolCall((await server.call(request('ok'))).text)
  const response = await server.call(request('ok', [
    { role: 'assistant', tool_calls: [{ id: initial.id, function: { name: initial.name, arguments: initial.arguments } }] },
    { role: 'tool', tool_call_id: initial.id, content: 'GXZS_SIM_STEP ok 0' },
  ]))
  assert.match(response.text, /GXZS_SIM_DONE ok steps=1/); assert.equal(server.stats.completed, 1)
  assert.equal(server.stats.upstreamCalls, 0)
})
test('tool failure cannot be turned into a passing final answer', async t => {
  const server = await fixture(t)
  const response = await server.call(request('failed', [
    { role: 'assistant', tool_calls: [{ id: 'sim_failed_0', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'sim_failed_0', content: 'spawn failed: resource unavailable' },
  ]))
  assert.equal(response.status, 500); assert.match(response.text, /refuse a false success/)
  assert.equal(server.stats.completed, 0)
})
test('isolates concurrent cases and rejects accidental ordinary user requests', async t => {
  const server = await fixture(t)
  const values = await Promise.all(Array.from({ length: 30 }, (_, i) => server.call(request('owner' + i))))
  assert.equal(new Set(values.map(value => toolCall(value.text).id)).size, 30)
  assert.equal((await server.call({ ...request('unused'), messages: [{ role: 'user', content: 'ordinary request' }] })).status, 500)
  assert.equal(server.stats.upstreamCalls, 0)
})
test('native streaming title requests receive SSE, not a JSON body', async t => {
  const server = await fixture(t)
  const response = await server.call({ model: 'gxzs-simulator', stream: true, messages: [{ role: 'system', content: 'Create a title' }] })
  assert.equal(response.status, 200); assert.match(response.text, /chat.completion.chunk/); assert.match(response.text, /data: \[DONE\]/)
})

test('non-stream tool requests return full arguments and matching completion metadata', async t => {
  const server = await fixture(t), body = { ...request('json'), stream: false }
  const response = JSON.parse((await server.call(body)).text)
  assert.equal(response.object, 'chat.completion'); assert.equal(response.model, body.model)
  assert.ok(Math.abs(response.created - Math.floor(Date.now() / 1000)) < 10)
  assert.equal(response.choices[0].finish_reason, 'tool_calls')
  assert.equal(response.choices[0].message.content, null)
  const call = response.choices[0].message.tool_calls[0]
  assert.equal(call.id, 'sim_json_0'); assert.equal(call.type, 'function')
  assert.match(JSON.parse(call.function.arguments).command, /GXZS_SIM_STEP json 0/)
  assert.equal(response.usage.total_tokens, response.usage.prompt_tokens + response.usage.completion_tokens)
})

test('stream usage uses a separate empty-choices chunk only when requested', async t => {
  const server = await fixture(t)
  const chunks = text => text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
  const plain = chunks((await server.call(request('usage'))).text)
  assert.ok(plain.every(chunk => !('usage' in chunk)))
  const response = await server.call({ ...request('usage'), stream_options: { include_usage: true } })
  const frames = chunks(response.text), last = frames.at(-1)
  assert.deepEqual(last.choices, []); assert.equal(last.usage.total_tokens, 120)
  assert.equal(frames.at(-2).choices[0].finish_reason, 'tool_calls')
  assert.ok(frames.slice(0, -1).every(frame => frame.usage === null))
  assert.equal(frames[0].choices[0].delta.role, 'assistant')
  assert.equal(new Set(frames.map(frame => frame.id)).size, 1)
  assert.equal(new Set(frames.map(frame => frame.created)).size, 1)
  assert.notEqual(frames[0].id, plain[0].id)
  assert.match(response.text, /data: \[DONE\]\n\n$/)
})

test('partial response disconnect is not reported as a successful completion', async t => {
  const server = await fixture(t), body = request('disconnect')
  body.messages[0].content = 'GXZS_SIM_CASE {"id":"disconnect","rounds":1,"stepDelayMs":0,"fault":{"mode":"disconnect","step":0,"count":1}}'
  await assert.rejects(server.call(body))
  assert.equal(server.stats.completed, 0)
  assert.equal(toolCall((await server.call(body)).text).id, 'sim_disconnect_0')
})

test('rate-limit injection returns 429 once and preserves the undispatched tool step', async t => {
  const server = await fixture(t), body = request('rate_limited')
  body.messages[0].content = 'GXZS_SIM_CASE {"id":"rate_limited","rounds":1,"stepDelayMs":0,"fault":{"mode":"http429","step":0,"count":1}}'
  const limited = await server.call(body)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers['retry-after'], '1')
  assert.equal(server.stats.toolResponses, 0)
  assert.equal(toolCall((await server.call(body)).text).id, 'sim_rate_limited_0')
  assert.equal(server.stats.upstreamCalls, 0)
})
test('scenario marker uses the latest child scope and rejects unsafe identifiers', () => {
  assert.equal(scenarioFrom([{ role: 'user', content: 'GXZS_SIM_CASE {"id":"parent"}\nGXZS_SIM_CASE {"id":"child"}' }]).id, 'child')
  assert.throws(() => scenarioFrom([{ role: 'user', content: 'GXZS_SIM_CASE {"id":"../escape"}' }]), /Invalid fixture case/)
  assert.equal(scenarioFrom([{ role: 'user', content: 'GXZS_SIM_CASE {"id":"child","rounds":3} <context>{"another":"object"}</context>' }]).id, 'child')
})
test('accepts native schedule and goal prompts inside a quoted JSON envelope', () => {
  const content = JSON.stringify({ prompt: 'GXZS_SIM_CASE {"id":"scheduled","rounds":3}' })
  assert.equal(scenarioFrom([{ role: 'user', content }]).id, 'scheduled')
})

test('documented schedule delivery creates a real schedule and unknown kinds fail closed', () => {
  for (const kind of ['schedule-delivery', 'scheduled-delivery']) {
    const scenario = scenarioFrom([{ role: 'user', content: `GXZS_SIM_CASE ${JSON.stringify({id:'schedule',kind})}` }])
    const planned = planStep(scenario, 0, { startedAt: Date.now() }, { tools: [{ function: { name: 'schedule_create' } }] })
    assert.equal(planned.name, 'schedule_create'); assert.match(planned.arguments.prompt, /schedule_delivery/)
  }
  assert.throws(() => scenarioFrom([{ role: 'user', content: 'GXZS_SIM_CASE {"id":"typo","kind":"scheduel"}' }]), /Invalid scenario kind/)
})
test('browser recovery validates its waiting tool without requiring a ledger marker', async t => {
  const server = await fixture(t)
  const body = { ...request('browser'), tools: [...tools, { type: 'function', function: { name: 'browser', parameters: { type: 'object' } } }],
    messages: [{ role: 'user', content: 'GXZS_SIM_CASE {"id":"browser","kind":"browser-recovery","rounds":3,"stepDelayMs":0}' }] }
  for (const content of ['页面已打开，但尚未完成加载', 'GXZS_SIM_PAGE_WAIT_OK']) {
    const call = toolCall((await server.call(body)).text)
    body.messages.push({ role: 'assistant', tool_calls: [{ id: call.id, function: { name: call.name, arguments: call.arguments } }] },
      { role: 'tool', tool_call_id: call.id, content })
  }
  const result = await server.call(body)
  assert.equal(result.status, 200); assert.equal(JSON.parse(toolCall(result.text).arguments).action, 'snapshot')
})
