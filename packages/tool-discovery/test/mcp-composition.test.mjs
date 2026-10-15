import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
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

async function setup(mode = 'native') {
  const names = platformToolNames(catalog), calls = []
  let available = catalog, run = { id: 'run-1', ownerId: 'owner-a', status: 'running', mcpTools: catalog }
  const personalName = names.get(catalog[1].id)
  const h = await mount({ rows: [], mode, mountDiscovery: false,
    script: [call('tool_search', { query: '档案', plugin_id: 'personal:mcp:records' }, mode), call(personalName, { query: 'one' }, mode), response()],
    bridgeFactory: async ctx => {
      ctx.provide('workbenchPlatformClient', { json: async request => {
        if (request.route === 'mcp/catalog') return { tools: available }
        calls.push(JSON.parse(request.body.toString()))
        return { data: { result: { result: { content: [{ type: 'text', text: 'fixture archived record' }] } } } }
      } })
      ctx.provide('workbenchRuntime', { ownerId: 'owner-a', agents: ctx.agents,
        executionRun: () => run,
        authorizeMcp: (_sessionId, id, version) => {
          const resource = run.ownerId === 'owner-a' && run.status === 'running' && run.mcpTools.find(item => item.id === id && item.version === version)
          return resource ? { ownerId: run.ownerId, runId: run.id, resource } : undefined
        },
      })
      await ctx.plugin(mcp, { discovery: true })
      return ctx.toolDiscoveryCatalog
    },
  })
  cleanups.push(() => h.close())
  return { ...h, names, calls, personalName,
    setRun: value => { run = value }, getRun: () => run,
    setAvailable: async value => { available = value; await h.ctx.parallel('workbench/resources-changed') },
  }
}

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

for (const mode of ['native', 'ptc']) test(`${mode}: required-task declarations remain visible as unsupported and cannot be activated`, async () => {
  const h = await setup(mode)
  const required = catalog.map(tool => ({ ...tool, execution: { taskSupport: 'required' } }))
  h.setRun({ ...h.getRun(), mcpTools: required }); await h.setAvailable(required)
  await h.remount()
  h.adapter.script = [call('tool_search', { query: '档案' }, mode), response()]
  const agent = await h.create(); await h.send(agent)
  assert.equal(h.calls.length, 0)
  assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools, [])
  assert.ok(agent.session.snapshotEvents().some(event => JSON.stringify(event.data).includes('task_execution_required')))
  assert.equal(h.ctx.tools.get(h.personalName, agent), undefined)
  const optional = required.map(tool => ({ ...tool, execution: { taskSupport: 'optional' }, manifest_version: 'm2' }))
  h.setRun({ ...h.getRun(), mcpTools: optional }); await h.setAvailable(optional)
  h.adapter.script = [call('tool_search', { query: '档案', plugin_id: 'personal:mcp:records' }, mode),
    call(h.personalName, { query: 'ordinary optional call' }, mode), response()]
  await h.send(agent)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].manifest_version, 'm2')
})

test('a scoped same-name definition is not mistaken for the catalog MCP executor', async () => {
  const h = await setup(); await h.remount()
  const agent = await h.create()
  agent.ctx.tools.register({ name: h.personalName, description: 'Scoped replacement', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'scoped',
  })
  h.adapter.script = [call('tool_search', { query: '档案', plugin_id: 'personal:mcp:records' }), response()]
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
  await h.ctx.plugin(discovery, { maxActiveTools: 1 })
  h.adapter.script = [response()]; await h.send(agent)
  assert.equal(h.ctx.tools.get(before[0], agent), undefined)
  assert.ok(h.ctx.tools.get(before[1], agent))
  assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.map(item => item.name), [before[1]])
})
