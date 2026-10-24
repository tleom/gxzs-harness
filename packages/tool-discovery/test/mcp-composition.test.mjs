import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import * as mcp from '../../workbench-mcp-tools/src/index.js'
import { platformToolNames } from '../../workbench-mcp-tools/src/names.js'
import { mount, call, response } from './helpers.mjs'
import { PROJECTION_KEY } from '../src/projection.js'
import * as discovery from '../src/index.js'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

const catalog = ['global', 'personal'].map(scope => ({
  id: `${scope}:mcp:records:lookup`, runtime_name: `${scope}_records_lookup`, version: 'v1', manifest_version: 'm1',
  scope, server_id: 'records', tool_name: 'lookup', provider_name: scope === 'global' ? '共享档案' : '个人档案',
  provider_call_name: scope === 'global' ? 'shared_records' : 'my_records', provider_description: '案件文书和档案检索',
  description: '检索案件记录', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}))

async function setup(mode = 'native', taskReply) {
  const names = platformToolNames(catalog), calls = []
  let available = catalog, plugins = [], run = { id: 'run-1', ownerId: 'owner-a', status: 'running', mcpTools: catalog }
  const personalName = names.get(catalog[1].id)
  const db = taskReply ? new DatabaseSync(':memory:') : undefined
  db?.exec("PRAGMA foreign_keys=ON; CREATE TABLE runs(id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('run-1')")
  const h = await mount({ rows: [], mode, mountDiscovery: false,
    script: [call('tool_search', { query: '档案', name: 'my_records' }, mode), call(personalName, { query: 'one' }, mode), response()],
    bridgeFactory: async ctx => {
      ctx.provide('workbenchPlatformClient', { json: async request => {
        if (request.route === 'mcp/catalog') return { tools: available, plugins }
        const payload = JSON.parse(request.body.toString())
        calls.push(payload)
        if (request.route === 'mcp/task' && taskReply) return { data: taskReply(payload) }
        return { data: { result: { result: { content: [{ type: 'text', text: 'fixture archived record' }] } } } }
      } })
      ctx.provide('workbenchRuntime', { ownerId: 'owner-a', agents: ctx.agents,
        ...(db ? { database: { db } } : {}),
        executionRun: () => run,
        authorizeMcpCall: async (_sessionId, id, version) => {
          const resource = run.ownerId === 'owner-a' && run.status === 'running' && run.mcpTools.find(item => item.id === id && item.version === version)
          return resource ? { ownerId: run.ownerId, runId: run.id, resource } : undefined
        },
      })
      await ctx.plugin(mcp, { discovery: true })
      return ctx.toolDiscoveryCatalog
    },
  })
  cleanups.push(async () => { try { await h.close() } finally { db?.close() } })
  return { ...h, names, calls, personalName,
    setRun: value => { run = value }, getRun: () => run,
    setAvailable: async value => { available = value; await h.ctx.parallel('workbench/resources-changed') },
    setPlugins: async value => { plugins = value; await h.ctx.parallel('workbench/resources-changed') },
  }
}

for (const mode of ['native', 'ptc']) test(`${mode}: publication reorder reaches runtime and model without losing active tools or duplicating history`, async () => {
  const h = await setup(mode)
  const tool = (name, order_num) => ({ ...catalog[0], id: `global:mcp:${name}:lookup`,
    runtime_name: `global_${name}_lookup`, server_id: name, provider_call_name: name, order_num })
  const first = [tool('alpha', 0), tool('beta', 10), tool('zeta', 20)]
  h.setRun({ ...h.getRun(), mcpTools: first })
  await h.setAvailable(first)
  await h.remount()
  const agent = await h.create(), zetaName = platformToolNames(first).get(first[2].id)
  const catalogs = () => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'mcp-catalog')
  const modelNames = () => {
    const text = JSON.stringify(h.adapter.requests.at(-1)).match(/<available_plugins>[\s\S]*?<\/available_plugins>/g)?.at(-1) ?? ''
    return [...text.matchAll(/- `([^`]+)`/g)].map(match => match[1])
  }
  h.adapter.script = [call('mcp', { name: 'zeta', tools: ['lookup'] }, mode), call(zetaName, { query: 'before' }, mode), response()]
  await h.send(agent)
  assert.deepEqual(modelNames(), ['alpha', 'beta', 'zeta'])
  assert.equal(h.calls.length, 1)
  const moved = [first[0], tool('zeta', 5), first[1]]
  await h.setAvailable(moved)
  const admitted = await h.ctx.workbenchRuntime.refreshMcpCatalog()
  assert.deepEqual(admitted.tools.map(item => item.server_id), ['alpha', 'zeta', 'beta'])
  assert.deepEqual(h.ctx.workbenchRuntime.mcpResources().map(item => item.server_id), ['alpha', 'zeta', 'beta'])
  assert.ok(h.ctx.tools.get(zetaName, agent), 'an order-only refresh retains the loaded tool')
  h.adapter.script = [call(zetaName, { query: 'after' }, mode), response(), response()]
  await h.send(agent)
  assert.deepEqual(modelNames(), ['alpha', 'zeta', 'beta'])
  assert.equal(catalogs().length, 2)
  assert.deepEqual(h.calls.map(item => item.arguments.query), ['before', 'after'])
  assert.ok(h.calls.every(item => item.run_id === 'run-1' && item.resource_id === first[2].id))
  await h.setAvailable(moved)
  await h.send(agent)
  assert.equal(catalogs().length, 2, 'an unchanged catalog never adds another history record')
  assert.equal(h.calls.length, 2, 'refreshes never execute tools')
})

for (const mode of ['native', 'ptc']) test(`${mode}: unrelated plugin refreshes do not interrupt a multi-step task`, async () => {
  const h = await setup(mode); await h.remount()
  const agent = await h.create()
  let executed = 0
  h.ctx.tools.register({ name: 'local_probe', description: 'Local operation without MCP', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => { executed++; return 'ok' },
  })
  h.adapter.script = [call('local_probe', {}, mode), call('tool_search', { query: '档案', name: 'my_records' }, mode),
    ...Array.from({ length: 32 }, () => call('local_probe', {}, mode)), call(h.personalName, { query: 'one' }, mode), response()]
  h.ctx.on('agent/pre-step', async ({ step }, next) => {
    if (step > 1) await h.setPlugins([{ id: 'global:mcp:weather', name: 'weather', displayName: '天气', scope: 'global',
      description: `Metadata refresh ${step}`, available: step % 2 === 0 }])
    return next()
  })
  await h.send(agent)
  assert.equal(h.adapter.requests.length, 36)
  assert.equal(executed, 33, 'completed operations are never replayed')
  assert.equal(h.calls.length, 1)
  assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')
})

for (const mode of ['native', 'ptc']) test(`${mode}: actual MCP bridge startup, discovery, authorized proxy dispatch and HMR stay fail closed`, async () => {
  const h = await setup(mode), agent = await h.create()
  assert.equal(h.ctx.tools.get(h.personalName, agent), undefined)
  assert.equal(h.bridge.snapshot(agent).tools.length, 2, 'catalog availability is independent of missing-core fallback')
  const plugin = await h.remount()
  assert.equal(h.ctx.tools.get(h.personalName, agent), undefined)
  await h.send(agent)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].resource_id, catalog[1].id)
  assert.equal(h.calls[0].run_id, 'run-1')
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, 1)
  assert.ok(!JSON.stringify(h.adapter.requests[0]).includes(h.personalName))
  assert.match(JSON.stringify(h.adapter.requests[0]), /my_records/)
  assert.equal(h.ctx.tools.get(h.names.get(catalog[0].id), agent), undefined)
  await plugin.dispose()
  assert.equal(h.ctx.tools.get(h.personalName, agent), undefined, 'adapter fallback is installed before discovery mask is released')
  assert.equal(h.ctx.tools.get('tool_search', agent), undefined)
  await h.remount()
  assert.ok(h.ctx.tools.get(h.personalName, agent), 'replayed hints match current authorized metadata')
  h.setRun({ ...h.getRun(), mcpTools: [catalog[0]] })
  await h.ctx.systemPrompt.assemble({ scope: agent })
  assert.equal(h.ctx.tools.get(h.personalName, agent), undefined)
  await h.setAvailable([])
  assert.deepEqual(h.bridge.managedNames(), [])
  assert.equal(h.ctx.tools.get(h.personalName), undefined)
})

test('actual bridge rejects a changed manifest and an owner/run change before a request', async () => {
  const h = await setup(), agent = await h.create(); await h.remount(); await h.send(agent)
  await h.setAvailable(catalog.map(tool => ({ ...tool, manifest_version: 'm2' })))
  assert.equal(h.ctx.tools.get(h.personalName, agent), undefined)
  assert.equal(h.bridge.snapshot(agent).tools.length, 0)
  h.setRun({ ...h.getRun(), ownerId: 'other-owner' })
  h.ctx.toolDiscovery.refresh(agent)
  assert.equal(h.bridge.snapshot(agent).ready, false)
  assert.equal(h.ctx.tools.get(h.personalName, agent), undefined)
})

for (const mode of ['native', 'ptc']) test(`${mode}: required-task declarations without task capability stay unavailable`, async () => {
  const h = await setup(mode)
  const required = catalog.map(tool => ({ ...tool, execution: { taskSupport: 'required' } }))
  h.setRun({ ...h.getRun(), mcpTools: required }); await h.setAvailable(required)
  await h.remount()
  h.adapter.script = [call('tool_search', { query: '档案' }, mode), response()]
  const agent = await h.create(); await h.send(agent)
  assert.equal(h.calls.length, 0)
  assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools, [])
  assert.ok(agent.session.snapshotEvents().some(event => JSON.stringify(event.data).includes('task_capability_unavailable')))
  assert.equal(h.ctx.tools.get(h.personalName, agent), undefined)
  const optional = required.map(tool => ({ ...tool, execution: { taskSupport: 'optional' }, manifest_version: 'm2' }))
  h.setRun({ ...h.getRun(), mcpTools: optional }); await h.setAvailable(optional)
  h.adapter.script = [call('tool_search', { query: '档案', name: 'my_records' }, mode),
    call(h.personalName, { query: 'ordinary optional call' }, mode), response()]
  await h.send(agent)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].manifest_version, 'm2')
})

for (const mode of ['native', 'ptc']) for (const modern of [false, true])
  test(`${mode}: discovers, loads and executes an authorized ${modern ? 'modern' : 'legacy'} required task`, async () => {
    const task = { taskId: 'discovered-task', createdAt: '2026-10-24T00:00:00Z', lastUpdatedAt: '2026-10-24T00:00:00Z',
      ...(modern ? { ttlMs: 60000, pollIntervalMs: 1 } : { ttl: 60000, pollInterval: 1 }) }
    const result = { content: [{ type: 'text', text: 'discovered task result' }], ...(modern ? { resultType: 'complete' } : {}) }
    const h = await setup(mode, request => {
      if (request.method === 'tools/call') return { task_ticket: 'ticket', result: modern
        ? { ...task, status: 'working', resultType: 'task' } : { task: { ...task, status: 'working' } } }
      if (request.method === 'tasks/get') return { result: { ...task, status: 'completed',
        ...(modern ? { resultType: 'complete', result } : {}) } }
      if (request.method === 'tasks/result') return { result }
      throw new Error(`unexpected task method: ${request.method}`)
    })
    const required = catalog.map(tool => ({ ...tool, execution: { taskSupport: 'required' } }))
    h.setRun({ ...h.getRun(), mcpTools: required })
    await h.setAvailable(required)
    const servers = required.map(tool => ({ id: `${tool.scope}:mcp:${tool.server_id}`, name: tool.provider_call_name, scope: tool.scope,
      version: tool.version, manifest_version: tool.manifest_version, protocol_version: modern ? '2026-07-28' : '2025-11-25',
      capabilities: modern ? { extensions: { 'io.modelcontextprotocol/tasks': {} } }
        : { tasks: { requests: { tools: { call: {} } }, cancel: {} } } }))
    await h.setPlugins(servers)
    await h.remount()
    const agent = await h.create()
    const revision = h.bridge.snapshot(agent).revision
    assert.equal(h.bridge.snapshot(agent).tools.length, required.length)
    assert.ok(h.bridge.snapshot(agent).tools.every(tool => !tool.unavailableReason))
    await h.send(agent)
    assert.deepEqual(h.calls.map(request => request.method), modern ? ['tools/call', 'tasks/get'] : ['tools/call', 'tasks/get', 'tasks/result'])
    assert.equal(h.calls[0].resource_id, catalog[1].id)
    assert.equal(h.calls[0].params.arguments.query, 'one')
    assert.ok(agent.session.snapshotEvents().some(event => JSON.stringify(event.data).includes('discovered task result')))
    assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, 1)
    await h.setPlugins(servers.map(server => ({ ...server, capabilities: {} })))
    assert.notEqual(h.bridge.snapshot(agent).revision, revision)
    assert.ok(h.bridge.snapshot(agent).tools.every(tool => tool.unavailableReason === 'task_capability_unavailable'))
    assert.equal(h.ctx.tools.get(h.personalName, agent), undefined, 'capability removal revokes the loaded tool')
  })

test('a scoped same-name definition is not mistaken for the catalog MCP executor', async () => {
  const h = await setup(); await h.remount()
  const agent = await h.create()
  agent.ctx.tools.register({ name: h.personalName, description: 'Scoped replacement', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'scoped',
  })
  h.adapter.script = [call('tool_search', { query: '档案', name: 'my_records' }), response()]
  await h.send(agent)
  assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools, [])
  assert.equal(h.calls.length, 0)
})

test('HMR applies current policy before a reduced active budget when restoring real MCP tools', async () => {
  const h = await setup(), agent = await h.create(), plugin = await h.remount()
  h.adapter.script = [call('tool_search', { query: '档案' }), response()]
  await h.send(agent)
  const before = h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.map(item => item.name)
  assert.equal(before.length, 2)
  await plugin.dispose(); agent.ctx.tools.restrict({ deny: [before[0]] })
  await h.ctx.plugin(discovery)
  h.adapter.script = [response()]; await h.send(agent)
  assert.equal(h.ctx.tools.get(before[0], agent), undefined)
  assert.ok(h.ctx.tools.get(before[1], agent))
  assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.map(item => item.name), [before[1]])
})
