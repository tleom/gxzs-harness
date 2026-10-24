import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Config } from '../src/index.js'
import { buildCatalog } from '../src/catalog.js'
import { activeStateSchema, PROJECTION_KEY } from '../src/projection.js'
import { mount, row, call, response } from './helpers.mjs'

test('default discovery accepts complete catalogs beyond former count and index thresholds', () => {
  const tools = Array.from({ length: 10001 }, (_, index) => row(`r${index}`, `record_${index}`, 'global', 'x'.repeat(1800)))
  const catalog = buildCatalog({ ready: true, tools }, Config({}))
  assert.equal(catalog.byId.size, tools.length)
  assert.equal(catalog.byId.get('r10000').description.length, 1800)
})

test('activation and recovery have no fixed tool-count or definition-size rejection', async () => {
  const tools = Array.from({ length: 70 }, (_, index) => row(`r${index}`, `record_${index}`, 'global', 'x'.repeat(index ? 2200 : 40000)))
  const h = await mount({ rows: tools, script: [call('mcp', { name: 'records', tools: tools.map(tool => tool.name) }), response()] })
  try {
    const agent = await h.create()
    await h.send(agent)
    assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, tools.length)
    assert.ok(h.ctx.tools.get('record_0', agent))
    const entries = Array.from({ length: 300 }, (_, index) => ({ id: `t${index}`, name: `t${index}`, version: '1', manifestVersion: '1', fingerprint: 'a'.repeat(64) }))
    assert.equal(activeStateSchema.parse({ version: 1, authorityKey: 'owner/run', tools: entries }).tools.length, 300)
  } finally { await h.close() }
})

test('discovery exposes only search presentation settings and search accepts seventy tools', async () => {
  const tools = Array.from({ length: 70 }, (_, index) => row(`r${index}`, `record_${index}`, 'global', 'shared capability'))
  const h = await mount({ rows: tools,
    script: [call('tool_search', { query: 'shared '.repeat(100), limit: 70 }), response()] })
  assert.deepEqual(Object.keys(Config({})), ['pageSize'])
  try {
    const agent = await h.create()
    await h.send(agent)
    assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, 70)
  } finally { await h.close() }
})
