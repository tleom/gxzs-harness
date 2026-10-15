import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mount, row, call, response } from './helpers.mjs'
import { bytes } from '../src/catalog.js'

const size = value => { const json = JSON.stringify(value); return { chars: json.length, bytes: bytes(json) } }
const rows = Array.from({ length: 600 }, (_, index) => {
  const plugin = Math.floor(index / 200), scope = plugin === 2 ? 'personal' : 'global'
  return row(`resource-${index}`, `provider_${plugin}_record_${String(index % 200).padStart(3, '0')}`, scope,
    '检索案件、裁判文书、当事人和执行记录。Search case records and related documents with filters.'.repeat(4),
    { pluginId: `${scope}:mcp:provider-${plugin}`, pluginName: `插件${plugin}`, pluginCallName: `provider_${plugin}`,
      parameters: { type: 'object', properties: { query: { type: 'string', description: '案件、客户、案号和关键词' },
        page: { type: 'integer' }, status: { type: 'string', enum: ['open', 'closed', 'pending'] },
        filters: { type: 'object', properties: { region: { type: 'string' }, since: { type: 'string' }, owner: { type: 'string' } } },
      }, required: ['query'], additionalProperties: false },
    })
})

for (const mode of ['native', 'ptc']) test(`${mode}: 600 tools in 3 global/personal plugins produce bounded initial and activated requests`, async () => {
  const measurements = {}
  for (const eager of [true, false]) {
    const h = await mount({ rows, mode, mountDiscovery: !eager, script: eager ? [response()] : [call('tool_search', { query: '案件' }, mode), response()] })
    try {
      for (const name of ['builtin_read', 'builtin_status']) h.ctx.tools.register({ name, description: 'Native fixture capability', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'ok' })
      const agent = await h.create(); await h.send(agent)
      for (const [index, request] of h.adapter.requests.entries()) {
        const label = eager ? 'eager' : index === 0 ? 'initial' : 'activated8'
        measurements[label] = { adapterOptions: size(request), messages: size(request.messages), wireSchemas: size(request.tools), wireToolCount: request.tools.length }
      }
      if (!eager && mode === 'native') {
        assert.equal(h.adapter.requests[0].tools.length, 3)
        assert.equal(h.adapter.requests[1].tools.length, 11)
      }
      if (!eager && mode === 'ptc') assert.equal(h.ctx.ptcRuntime.observations[0].length, 3)
    } finally { await h.close() }
  }
  assert.ok(measurements.initial.adapterOptions.bytes < measurements.eager.adapterOptions.bytes * 0.08)
  assert.ok(measurements.activated8.adapterOptions.bytes < measurements.eager.adapterOptions.bytes * 0.15)
  console.info(JSON.stringify({ fixture: '600 MCP definitions plus 2 native definitions; lazy adds tool_search; no tokenizer estimate', mode, measurements }))
})

for (const mode of ['native', 'ptc']) test(`${mode}: global and personal catalog sizes 1, 50, 600 and 1000 keep unused definitions out of requests`, async () => {
  for (const scope of ['global', 'personal']) {
    const initialSizes = []
    for (const count of [1, 50, 600, 1000]) {
      const catalog = Array.from({ length: count }, (_, index) => row(`${scope}:size:${index}`,
        `fixture_records_tool_${index}`, scope, '查询案件记录', {
          parameters: { type: 'object', properties: { query: { type: 'string', description: `SCHEMA_MARKER_${index}` } } },
        }))
      const target = catalog[0]
      const h = await mount({ rows: catalog, mode, script: [
        call('tool_search', { query: target.name, plugin_id: target.pluginId }, mode),
        call(target.name, { query: '合成只读记录' }, mode), response(),
      ] })
      try {
        const agent = await h.create(); await h.send(agent)
        const initial = h.adapter.requests[0], loaded = h.adapter.requests[1]
        const initialText = JSON.stringify({ messages: initial.messages, tools: initial.tools })
        const loadedText = JSON.stringify({ messages: loaded.messages, tools: loaded.tools })
        initialSizes.push(bytes(initialText))
        assert.ok(!initialText.includes('fixture_records_tool_'))
        assert.ok(!initialText.includes('SCHEMA_MARKER_'))
        assert.ok(loadedText.includes('SCHEMA_MARKER_0'))
        assert.ok(!loadedText.includes('SCHEMA_MARKER_1'))
        assert.deepEqual(h.executions, [target.name])
        if (mode === 'native') {
          assert.deepEqual(initial.tools.map(tool => tool.name), ['tool_search'])
          assert.equal(loaded.tools.length, 2)
        } else {
          assert.equal(h.ctx.ptcRuntime.observations[0].length, 1)
          assert.equal(h.ctx.ptcRuntime.observations[1].length, 2)
        }
      } finally { await h.close() }
    }
    assert.ok(Math.max(...initialSizes) - Math.min(...initialSizes) <= 128,
      `Initial ${scope} context must not scale with hidden definitions: ${initialSizes.join(', ')}`)
    console.info(JSON.stringify({ fixture: 'fixed plugin identity, catalog size matrix', mode, scope,
      toolCounts: [1, 50, 600, 1000], initialRequestBytes: initialSizes }))
  }
})
