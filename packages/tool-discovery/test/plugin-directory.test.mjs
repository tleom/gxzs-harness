import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { mount, row, call, response } from './helpers.mjs'
import { PROJECTION_KEY } from '../src/projection.js'

const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

for (const mode of ['native', 'ptc']) {
  test(`${mode}: complete source metadata and large callable schemas remain available together`, async () => {
    const schema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 100 }, (_, i) =>
      [`field_${i}`, { type: 'string', description: 'x'.repeat(180) }])) }
    const rows = ['one', 'two', 'three'].map(name => row(name, `lookup_${name}`, 'global', 'lookup records',
      { parameters: schema, inputSchema: { ...schema, additionalProperties: false } }))
    rows.push(row('large', 'lookup_large', 'global', 'lookup records', { parameters: { ...schema, description: 'x'.repeat(20000) } }))
    const h = await mount({ rows, mode, script: [
      call('mcp', { name: 'records', tools: rows.map(tool => tool.name) }, mode),
      call('lookup_one', {}, mode), call('lookup_two', {}, mode), response(),
    ] })
    cleanups.push(() => h.close())
    const agent = await h.create(); await h.send(agent)
    assert.deepEqual(h.executions, ['lookup_one', 'lookup_two'])
    const result = JSON.stringify(h.adapter.requests[1].messages)
    assert.doesNotMatch(result, /"status":"rejected"/)
    assert.match(result, /inputSchema/)
    assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.map(tool => tool.name).sort(), rows.map(tool => tool.name).sort())
  })

  test(`${mode}: recovered but unauthorized plugins explain their status instead of disappearing`, async () => {
    const h = await mount({ rows: [], mode, script: [call('mcp', { name: 'recovered' }, mode),
      call('tool_search', { name: 'recovered', query: 'lookup' }, mode), response()] })
    cleanups.push(() => h.close())
    h.bridge.plugins = [{ id: 'g:recovered', name: 'recovered', available: false, unavailableReason: 'run_authorization_required' }]
    const agent = await h.create(); await h.send(agent)
    const request = JSON.stringify(h.adapter.requests.at(-1))
    assert.match(request, /run_authorization_required/)
    assert.match(request, /重新提交任务/)
    assert.doesNotMatch(request, /not_found/)
    assert.deepEqual(h.executions, [])
  })
  test(`${mode}: empty and unavailable installed plugins remain distinguishable from missing plugins`, async () => {
    const h = await mount({ rows: [], mode, script: [call('mcp', {}, mode), call('mcp', { name: 'empty' }, mode),
      call('mcp', { name: 'offline' }, mode), call('tool_search', { name: 'offline', query: 'lookup' }, mode), response()] })
    cleanups.push(() => h.close())
    h.bridge.plugins = [{ id: 'g:empty', name: 'empty', displayName: '空插件' },
      { id: 'g:offline', name: 'offline', displayName: '离线插件', available: false }]
    const agent = await h.create(); await h.send(agent)
    const request = JSON.stringify(h.adapter.requests.at(-1))
    assert.match(request, /空插件/)
    assert.match(request, /离线插件/)
    assert.match(request, /工具目录暂不可用/)
    assert.ok(!request.includes('not_found'))
    assert.deepEqual(h.executions, [])
  })

  test(`${mode}: a 300-tool directory above 64 KiB is complete and does not activate tools`, async () => {
    const rows = Array.from({ length: 300 }, (_, index) => row(`id-${index}`, `lookup_${index}`, 'global',
      `工具 ${index}：${'完整能力说明'.repeat(100)}；尾部唯一标记-${index}`))
    const h = await mount({ rows, mode, script: [call('mcp', { name: 'records' }, mode), response()] })
    cleanups.push(() => h.close())
    const agent = await h.create(); await h.send(agent)
    assert.deepEqual(h.executions, [])
    assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools, [])
    const rendered = JSON.stringify(h.adapter.requests[1])
    assert.ok(Buffer.byteLength(rendered) > 65536)
    for (const tool of rows) assert.ok(rendered.includes(tool.description), tool.name)
    assert.ok(!rendered.includes('next_cursor'))
    if (mode === 'native') assert.deepEqual(h.adapter.requests[1].tools.map(tool => tool.name), ['mcp', 'tool_search'])
  })

  test(`${mode}: batch exact loading reports missing tools and makes both complete definitions callable next step`, async () => {
    const rows = [row('a', 'lookup_alpha', 'global', 'first'), row('b', 'lookup_beta', 'global', 'second')]
    const h = await mount({ rows, mode, script: [
      call('mcp', { name: 'records', tools: ['lookup_alpha', 'absent', 'lookup_beta'] }, mode),
      call('lookup_alpha', { query: 'one' }, mode), call('lookup_beta', { query: 'two' }, mode), response(),
    ] })
    cleanups.push(() => h.close())
    const agent = await h.create(); await h.send(agent)
    assert.deepEqual(h.executions, ['lookup_alpha', 'lookup_beta'])
    const next = h.adapter.requests[1]
    assert.match(JSON.stringify(next), /tool_not_found/)
    assert.match(JSON.stringify(next), /partial/)
    if (mode === 'native') for (const tool of rows) {
      assert.deepEqual(next.tools.find(item => item.name === tool.name).parameters, tool.parameters)
    }
  })

  test(`${mode}: an empty batch is rejected without activation`, async () => {
    const h = await mount({ mode, script: [call('mcp', { name: 'records', tools: [] }, mode), response()] })
    cleanups.push(() => h.close())
    const agent = await h.create(); await h.send(agent)
    assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools, [])
    assert.deepEqual(h.executions, [])
  })
}

test('plugin summaries are durable user messages and republish only when changed or no longer visible', async () => {
  const h = await mount({ script: [response(), response(), response(), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create()
  await h.send(agent)
  const catalogs = () => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'mcp-catalog')
  assert.equal(catalogs().length, 1)
  const text = catalogs()[0].data.content[0].text
  assert.match(text, /`records`（全局案件）/)
  assert.ok(!text.includes('global:mcp:records'))
  await h.send(agent)
  assert.equal(catalogs().length, 1)
  h.bridge.rows = []
  h.bridge.notify()
  await h.send(agent)
  assert.equal(catalogs().length, 2)
  assert.match(catalogs()[1].data.content[0].text, /当前没有可用插件/)
})
