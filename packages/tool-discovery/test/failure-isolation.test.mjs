import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mount, row, call, response } from './helpers.mjs'
import { ACTIVE_EVENT, PROJECTION_KEY } from '../src/projection.js'

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

for (const mode of ['native', 'ptc']) for (const budget of ['count', 'bytes']) {
  test(`${mode}: ${budget} catalog overflow leaves ordinary tools usable and can recover`, async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`id-${i}`, `lookup_${i}`, 'global', '案件记录'.repeat(30)))
    const h = await mount({ mode, rows, config: budget === 'count' ? { maxCatalogTools: 2 } : { maxIndexBytes: 1024 },
      script: [call('native_status', {}, mode), call('tool_search', { query: 'lookup_0' }, mode), response(),
        call('tool_search', { query: 'lookup_0' }, mode), call('lookup_0', {}, mode), response()],
    })
    cleanups.push(() => h.close())
    const builtinCalls = []
    h.ctx.tools.register({ name: 'native_status', description: 'Native status', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { builtinCalls.push('ok'); return 'ok' },
    })
    const agent = await h.create()
    await h.send(agent, 'Ordinary conversation can continue')
    assert.deepEqual(builtinCalls, ['ok'])
    assert.deepEqual(h.executions, [])
    assert.equal(h.adapter.requests.length, 3)
    assert.equal(h.ctx.tools.get('lookup_0', agent), undefined)
    assert.match(JSON.stringify(h.adapter.requests[0].messages), /超出发现预算/)
    assert.ok(agent.session.snapshotEvents().some(event => event.type === 'tool/result'
      && JSON.stringify(event.data).includes('unavailable')))
    h.bridge.rows = rows.slice(0, 1); h.bridge.notify()
    await h.send(agent, 'Use the repaired catalog')
    assert.deepEqual(h.executions, ['lookup_0'])
    assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.map(tool => tool.name), ['lookup_0'])
  })
}

test('a missing discovery allowlist entry produces an accurate policy notice', async () => {
  const h = await mount({ script: [response()] }); cleanups.push(() => h.close())
  const agent = await h.create()
  agent.ctx.tools.restrict({ allow: ['case_lookup'] })
  await h.send(agent)
  assert.deepEqual(h.adapter.requests[0].tools ?? [], [])
  assert.match(JSON.stringify(h.adapter.requests[0].messages), /当前会话策略未允许/)
  assert.doesNotMatch(JSON.stringify(h.adapter.requests[0].messages), /需要插件能力时先调用/)
})

for (const mode of ['native', 'ptc']) test(`${mode}: independently denied candidates do not persist or consume activation budget`, async () => {
  const rows = [row('denied', 'lookup_denied'), row('allowed', 'lookup_allowed')]
  const h = await mount({ rows, mode, config: { maxActiveTools: 1 }, script: [
    call('tool_search', { query: 'lookup_denied' }, mode),
    call('tool_search', { query: 'lookup_allowed' }, mode), call('lookup_allowed', {}, mode), response(),
  ] }); cleanups.push(() => h.close())
  const agent = await h.create(); agent.ctx.tools.restrict({ deny: ['lookup_denied'] })
  await h.send(agent)
  assert.deepEqual(h.executions, ['lookup_allowed'])
  assert.match(JSON.stringify(h.adapter.requests[1].messages), /最近一次准备有 1 项未获当前会话策略许可/)
  assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.map(tool => tool.name), ['lookup_allowed'])
  assert.ok(!agent.session.snapshotEvents().filter(event => event.type === ACTIVE_EVENT)
    .some(event => JSON.stringify(event.data).includes('lookup_denied')))
})

test('a snapshot failure remains fail closed without aborting native conversation', async () => {
  const h = await mount({ script: [response()] }); cleanups.push(() => h.close())
  h.bridge.snapshot = () => { throw new Error('Fixture metadata service unavailable') }
  const agent = await h.create(); await h.send(agent)
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
  assert.match(JSON.stringify(h.adapter.requests[0].messages), /插件目录暂不可用/)
})

for (const snapshot of [null, undefined, []]) test(`invalid snapshot ${String(snapshot)} leaves native conversation usable`, async () => {
  const h = await mount({ script: [response()] }); cleanups.push(() => h.close())
  h.bridge.snapshot = () => snapshot
  const agent = await h.create(); await h.send(agent)
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
  assert.match(JSON.stringify(h.adapter.requests[0].messages), /插件目录暂不可用/)
})

test('a scoped search replacement does not receive plugin discovery instructions', async () => {
  const h = await mount({ script: [response()] }); cleanups.push(() => h.close())
  const agent = await h.create()
  agent.ctx.tools.register({ name: 'tool_search', description: 'Search local notebook', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'note' })
  await h.send(agent)
  assert.equal(h.adapter.requests[0].tools[0].description, 'Search local notebook')
  assert.doesNotMatch(JSON.stringify(h.adapter.requests[0].messages), /需要插件能力时先调用/)
  assert.match(JSON.stringify(h.adapter.requests[0].messages), /当前会话策略未允许/)
})
