import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
async function fixture(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'gxzs-sim-test-'))
  const simulator = await createSimulator({ token, output })
  t.after(async () => { simulator.server.closeAllConnections(); await new Promise(resolve => simulator.server.close(resolve)); await simulator.drain(); await rm(output, { recursive: true }) })
  return { ...simulator, call: async body => {
    const response = await fetch(`http://127.0.0.1:${simulator.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, text: await response.text() }
  } }
}
const request = (id, extra = []) => ({ model: 'gxzs-simulator', stream: true, tools, messages: [{ role: 'user', content: `GXZS_SIM_CASE ${JSON.stringify({ id, rounds: 1, stepDelayMs: 0 })}` }, ...extra] })
function toolCall(text) {
  const result = { arguments: '' }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: {')) continue
    const call = JSON.parse(line.slice(6)).choices[0].delta.tool_calls?.[0]
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
