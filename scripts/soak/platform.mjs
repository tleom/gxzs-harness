#!/usr/bin/env node
/** Synthetic platform boundary; actual Hosts, Sandboxes and Manager admission run unchanged. */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createSimulator } from './simulator.mjs'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const bindings = new Map(), faults = new Map(), grants = new Map()
async function manager(binding, action, body) {
  const reply = await fetch(`${config.managerURL}/sandboxes/${binding.workspace_id}/${action}`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  const result = await reply.json()
  if (!reply.ok) throw new Error(`Synthetic manager ${action}: ${reply.status} ${JSON.stringify(result)}`)
  return result
}
const fixtureTool = { id: 'global:mcp:soak-fixture:fixture_echo', runtime_name: 'global_mcp_soak_fixture_echo', version: 'v1', manifest_version: 'v1', scope: 'global', server_id: 'soak-fixture', tool_name: 'fixture_echo', provider: 'global:mcp:soak-fixture', provider_name: '模拟验收插件', description: 'Echo synthetic validation values', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }
const fixturePlugin = { id: fixtureTool.provider, name: 'soak-fixture', displayName: '模拟验收插件', description: 'Deterministic synthetic plugin', scope: 'global', available: true }
let persistence = Promise.resolve()
const persist = () => persistence = persistence.then(async () => {
  await writeFile(`${config.output}/bindings.json.tmp`, JSON.stringify([...bindings.values()], null, 2))
  await rename(`${config.output}/bindings.json.tmp`, `${config.output}/bindings.json`)
})
try { for (const row of JSON.parse(await readFile(`${config.output}/bindings.json`, 'utf8'))) bindings.set(row.owner_id, row) } catch (error) { if (error.code !== 'ENOENT') throw error }
const simulation = await createSimulator({ ...config, extraHandler: async ({ req, res, url, body, json }) => {
  if (url.pathname === '/mcp') {
    if (req.method === 'GET') { res.writeHead(405); res.end(); return true }
    if (body.method?.startsWith('notifications/')) { res.writeHead(202); res.end(); return true }
    let result
    if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-personal-plugin', version: '1.0.0' } }
    else if (body.method === 'tools/list') result = { tools: Array.from({ length: 320 }, (_, index) => ({ name: index ? `catalog_item_${index}` : 'personal_echo', description: `Synthetic personal catalog tool ${index}; returns its input for verification`, inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } })) }
    else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ marker: 'GXZS_SIM_PERSONAL_OK', value: body.params.arguments.value }) }] }
    else if (body.method === 'ping') result = {}
    else { json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown fixture method' } }); return true }
    json(res, 200, { jsonrpc: '2.0', id: body.id, result }); return true
  }
  if (url.pathname === '/__test/bindings') { json(res, 200, [...bindings.values()]); return true }
  if (url.pathname === '/__test/fault' && req.method === 'GET') { json(res, 200, [...faults.values()]); return true }
  if (url.pathname === '/__test/fault' && req.method === 'POST') {
    if (!bindings.has(body.owner) || !['mcp/catalog', 'workbench/config', 'scheduling'].includes(body.route)
        || !Number.isInteger(body.remaining) || body.remaining < 0 || body.remaining > 4 || body.status !== 503) throw new Error('Invalid fixture fault')
    faults.set(body.owner, body); json(res, 200, { configured: true }); return true
  }
  if (!url.pathname.startsWith('/internal/')) return false
  if (req.headers.authorization !== `Bearer ${config.token}`) { json(res, 401, { error: 'Synthetic platform token mismatch' }); return true }
  if (url.pathname === '/internal/ai/orchestration/hosts/heartbeat') {
    if (!/^soak1017:\d+$/.test(body.owner_id)) throw new Error('Unexpected fixture owner')
    bindings.set(body.owner_id, body); await persist(); json(res, 200, { ok: true }); return true
  }
  if (url.pathname === '/internal/ai/mcp/authorize') {
    const known = grants.get(body.authorization?.jti)
    const authorized = known && !known.consumed && known.deadline > Date.now() && JSON.stringify(known.value) === JSON.stringify(body.authorization)
    if (authorized && body.action === 'consume') known.consumed = true
    json(res, 200, { authorized: Boolean(authorized) }); return true
  }
  const owner = req.headers['x-gxzs-owner'], binding = bindings.get(owner)
  if (!binding || String(binding.generation) !== req.headers['x-gxzs-host-generation'] || binding.instance_id !== req.headers['x-gxzs-host-instance']) {
    json(res, 401, { code: 'HOST_NOT_REGISTERED', message: 'Synthetic owner generation mismatch' }); return true
  }
  const route = url.pathname.replace('/internal/workbench/', '')
  const fault = faults.get(owner)
  if (fault && (fault.route === route || fault.route === '*') && fault.remaining > 0) {
    fault.remaining--;
    await simulation.record({ event: 'injected_platform_failure', owner, route, status: fault.status, remaining: fault.remaining })
    json(res, fault.status, { code: 'FIXTURE_TRANSIENT', message: 'Injected transient dependency failure', retry_after: 1 }); return true
  }
  if (route === 'workbench/config') {
    json(res, 200, { data: { enabled: true, system_prompt: '这是隔离的合成稳定性测试。模型响应由可控服务生成。', global_skills: config.globalSkills, models: { default: 'simulator/gxzs-simulator', providers: { simulator: { api: 'openai-completions', baseURL: config.publicURL + '/v1', apiKeyEnv: 'GXZS_SIM_MODEL_KEY', compat: { supportsDeveloperRole: false }, models: [{ id: 'gxzs-simulator', name: '零费用模拟模型', input: ['text', 'image'], contextWindow: 1050000, maxTokens: 128000 }] } } } } }); return true
  }
  if (route === 'mcp/policy') {
    const reply = await fetch(config.managerURL + '/mcp-policy', { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(10000) })
    if (!reply.ok) throw new Error('Fixture policy authority returned ' + reply.status)
    json(res, 200, { data: { policy: await reply.json() } }); return true
  }
  if (route === 'mcp/catalog' || route === 'mcp/plugins') {
    const personal = await manager(binding, 'personal-mcp', { operation: 'mcp_list' })
    const tools = [fixtureTool], plugins = [fixturePlugin]
    for (const server of personal.mcp ?? []) {
      plugins.push({ id: `personal:mcp:${server.id}`, name: server.call_name ?? server.id, displayName: server.name, description: server.description, scope: 'personal', available: server.status === 'ready' && server.enabled })
      if (server.status !== 'ready' || !server.enabled) continue
      for (const tool of server.tools) tools.push({ id: `personal:mcp:${server.id}:${tool.name}`, runtime_name: `personal_mcp_${tool.name}`, scope: 'personal', group: 'mcp', provider: `personal:mcp:${server.id}`, provider_call_name: server.call_name ?? server.id, provider_name: server.name, provider_description: server.description, name: tool.name, tool_name: tool.name, server_id: server.id, description: tool.description, version: server.version, manifest_version: server.manifest_version, inputSchema: tool.inputSchema })
    }
    json(res, 200, { data: { tools, plugins } }); return true
  }
  if (route === 'mcp/call') {
    if (body.resource_id === fixtureTool.id) { json(res, 200, { data: { result: { content: [{ type: 'text', text: JSON.stringify({ marker: 'GXZS_SIM_MCP_OK', value: body.arguments ?? body.input ?? null }) }] } } }); return true }
    if (!body.resource_id.startsWith('personal:mcp:soak-personal:')) throw new Error('Unknown synthetic plugin')
    const grant = { purpose: 'dsh-mcp-call', owner_id: owner, workspace_id: binding.workspace_id, binding_id: body.run_id, run_id: body.run_id, resource_id: body.resource_id, version: body.version, manifest_version: body.manifest_version, runtime_version: body.version, arguments: body.arguments, deadline_ms: body.deadline_ms, request_key: body.request_key, jti: randomUUID() }
    grants.set(grant.jti, { value: grant, deadline: body.deadline_ms, consumed: false })
    try {
      const result = await manager(binding, 'personal-mcp', { operation: 'mcp_call', name: body.server_id, version: body.version, manifest_version: body.manifest_version, tool: body.tool_name, arguments: body.arguments, request_key: body.run_id + ':' + body.request_key, authorization: grant, deadline_ms: body.deadline_ms })
      json(res, 200, { data: { result } }); return true
    } finally { grants.delete(grant.jti) }
  }
  if (route === 'mcp/cancel') { json(res, 200, { data: { fenced: true } }); return true }
  if (route === 'scheduling') {
    const reply = await fetch(`${config.managerURL}/sandboxes/${binding.workspace_id}/schedule`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, owner_id: owner, generation: binding.generation, instance_id: binding.instance_id }), signal: AbortSignal.timeout(5000) })
    const result = await reply.json(); json(res, reply.status, reply.ok ? { data: result } : result); return true
  }
  if (route === 'schedule-wakeups' && Number.isSafeInteger(body.sequence) && body.sequence > 0 && Array.isArray(body.tasks)) {
    // An empty native catalog needs no durable wakeup. Positive scheduling is
    // verified against the real Java/SnailJob stack, never simulated here.
    if (body.tasks.length) { json(res, 503, { error: 'Use the Java fixture for durable schedule wakeups' }); return true }
    await simulation.record({ event: 'empty_schedule_wakeups', owner, sequence: body.sequence })
    json(res, 200, { data: { sequence: body.sequence, tasks: [], complete: true } }); return true
  }
  json(res, 404, { error: 'Unimplemented synthetic platform route', route }); return true
} })
console.log(JSON.stringify({ ready: true, port: simulation.port, synthetic: true, upstreamCalls: 0 }))
