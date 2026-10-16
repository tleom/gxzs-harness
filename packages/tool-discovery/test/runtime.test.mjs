import { test, afterEach, vi } from 'vitest'
import assert from 'node:assert/strict'
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope'
import { ACTIVE_EVENT, PROJECTION_KEY } from '../src/projection.js'
import { mount, row, call, response } from './helpers.mjs'

vi.mock('@deepseek-ai/dsh-session', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, appendPluginRecord: vi.fn(actual.appendPluginRecord) }
})

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

for (const mode of ['native', 'ptc']) test(`${mode}: discovery stages activation, original executor runs next step, and durable native state exists`, async t => {
  const h = await mount({ mode, script: [call('tool_search', { query: '案件' }, mode), call('case_lookup', { query: 'one' }, mode), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create()
  await h.send(agent)
  assert.deepEqual(h.executions, ['case_lookup'])
  const state = h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
  assert.equal(state.tools[0].name, 'case_lookup')
  const records = agent.session.snapshotEvents().filter(e => e.type === ACTIVE_EVENT)
  assert.equal(records.length, 1)
  assert.equal(records[0].ignorable, true)
  assert.equal(h.adapter.requests.length, 3)
  if (mode === 'native') {
    assert.deepEqual(h.adapter.requests[0].tools.map(t => t.name), ['mcp', 'tool_search'])
    assert.deepEqual(h.adapter.requests[1].tools.map(t => t.name), ['case_lookup', 'mcp', 'tool_search'])
  } else {
    assert.deepEqual(h.ctx.ptcRuntime.observations[0].sort(), ['mcp', 'tool_search'])
    assert.ok(h.ctx.ptcRuntime.observations[1].includes('case_lookup'))
    assert.ok(!JSON.stringify(h.adapter.requests[0]).includes('case_lookup'))
  }
})

test('native rejects same-batch guessed tool and admits it on the following model step', async t => {
  const h = await mount({ script: [response([['tool_search', { query: '案件' }], ['case_lookup', {}]]), call('case_lookup'), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  assert.deepEqual(h.executions, ['case_lookup'])
  const failures = agent.session.snapshotEvents().filter(e => e.type === 'tool/result' && e.data.message.isError)
  assert.equal(failures.length, 1)
})

test('normalized post-execute failure does not activate a prepared definition', async t => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response()] })
  cleanups.push(() => h.close())
  h.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'tool_search' ? { kind: 'block', feedback: [{ type: 'text', text: 'Fixture denied final result' }] } : next())
  const agent = await h.create(); await h.send(agent)
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, 0)
  assert.deepEqual(h.adapter.requests[1].tools.map(t => t.name), ['mcp', 'tool_search'])
})

test('native cancellation after successful discovery settlement does not commit at unconditional step/end', async t => {
  const h = await mount({ script: [call('tool_search', { query: '案件' })] })
  cleanups.push(() => h.close())
  const agent = await h.create()
  h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'tool_search' && !result.isError) agent.cancel({ kind: 'user' }) })
  await h.send(agent)
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, 0)
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === ACTIVE_EVENT).length, 0)
})

test('PTC outer program failure discards a successful inner discovery', async t => {
  const h = await mount({ mode: 'ptc', script: [response([['run_code', { description: 'Fixture failed program', code: JSON.stringify({ name: 'tool_search', args: { query: '案件' }, failAfter: true }) }]]), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, 0)
})

test('MCP-only mask preserves later native registrations and independent authorization restrictions', async t => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create()
  h.ctx.tools.register({ name: 'new_native', description: 'Native capability', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'native' })
  agent.ctx.tools.restrict({ deny: ['case_lookup'] })
  await h.send(agent)
  assert.ok(h.ctx.tools.get('new_native', agent))
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
  assert.ok(h.ctx.tools.get('case_lookup'))
})

test('same-preset Agent scopes load independently and new run authority resets the visible set', async t => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response(), response()] })
  cleanups.push(() => h.close())
  const presetKey = { id: 'fixture-preset' }
  await h.ctx.plugin(Object.assign(inner => { createScope(inner, presetKey) }, { inject: ['tools', 'systemPrompt'] }))
  const parent = await h.create('parent'), child = await h.create('child')
  bindScopeParent(parent, presetKey); bindScopeParent(child, presetKey)
  await h.send(parent)
  assert.ok(h.ctx.tools.get('case_lookup', parent))
  assert.equal(h.ctx.tools.get('case_lookup', child), undefined)
  h.bridge.run = 'run-2'; h.bridge.notify()
  assert.equal(h.ctx.tools.get('case_lookup', parent), undefined)
  await h.send(child)
  assert.deepEqual(h.adapter.requests.at(-1).tools.map(t => t.name), ['mcp', 'tool_search'])
})

test('native projection replays and checkpoints active hints; current bridge invalidates revoked versions', async t => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  const events = agent.session.snapshotEvents(), checkpoint = h.ctx.sessionProjections.checkpoint(agent.session)
  const restored = Session.create(agent.id, events, agent.session.header)
  assert.deepEqual(h.ctx.sessionProjections.stateOf(restored, PROJECTION_KEY).tools.map(t => t.name), ['case_lookup'])
  assert.equal(checkpoint[PROJECTION_KEY].val.tools[0].name, 'case_lookup')
  h.bridge.rows[0] = { ...h.bridge.rows[0], manifestVersion: 'm2' }; h.bridge.notify()
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
})

test('HMR removes its tool and mask, restores same-authority hints, and releases catalog subscriptions', async t => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  await h.plugin.dispose()
  assert.equal(h.ctx.tools.get('tool_search'), undefined)
  assert.equal(h.bridge.listeners.size, 0)
  assert.deepEqual(h.bridge.readyTransitions, [true, false])
  await h.remount()
  assert.ok(h.ctx.tools.get('case_lookup', agent))
  assert.ok(h.ctx.tools.get('tool_search', agent))
  assert.equal(h.bridge.listeners.size, 1)
})

test('changed authority cannot recover another owner activation hint after HMR', async t => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  await h.plugin.dispose(); h.bridge.owner = 'owner-b'; h.bridge.notify(); await h.remount()
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
})

test('PTC cancellation uses the native turn signal and never activates successful inner discovery', async () => {
  const h = await mount({ mode: 'ptc', script: [call('tool_search', { query: '案件' }, 'ptc')] })
  cleanups.push(() => h.close())
  const agent = await h.create()
  h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'tool_search' && !result.isError) agent.cancel({ kind: 'user' }) })
  await h.send(agent)
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, 0)
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
})

test('failed native active-event append blocks the next provider request', async () => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create()
  vi.mocked(appendPluginRecord).mockImplementationOnce(() => { throw new Error('Fixture durable append failure') })
  await h.send(agent)
  assert.equal(h.adapter.requests.length, 1)
  assert.equal(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.length, 0)
})

test('temporary catalog loss hides activation; removal revokes it and invalid catalogs fail closed', async () => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  h.bridge.ready = false; h.bridge.notify()
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
  h.bridge.ready = true; h.bridge.notify()
  assert.ok(h.ctx.tools.get('case_lookup', agent))
  h.bridge.rows = [h.bridge.rows[0], h.bridge.rows[0]]
  assert.doesNotThrow(() => h.bridge.notify())
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
  h.bridge.rows = []; h.registrations.get('g:cases')(); h.bridge.notify()
  assert.equal(h.ctx.tools.get('case_lookup', agent), undefined)
})

test('replace_active releases the old working set only after a successful replacement step', async () => {
  const rows = [row('a', 'lookup_alpha', 'global', 'alpha'), row('b', 'lookup_beta', 'personal', 'beta')]
  const h = await mount({ rows, config: { maxActiveTools: 1 }, script: [
    call('tool_search', { query: 'lookup_alpha' }), call('tool_search', { query: 'lookup_beta' }),
    call('tool_search', { query: 'lookup_beta', replace_active: true }), call('lookup_beta'), response(),
  ] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  assert.deepEqual(h.executions, ['lookup_beta'])
  assert.ok(h.adapter.requests[2].tools.some(t => t.name === 'lookup_alpha'))
  assert.deepEqual(h.adapter.requests[3].tools.map(t => t.name), ['lookup_beta', 'mcp', 'tool_search'])
  assert.deepEqual(h.ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY).tools.map(t => t.name), ['lookup_beta'])
  const results = agent.session.snapshotEvents().filter(e => e.type === 'tool/result')
  assert.match(JSON.stringify(results[1]), /active_tool_limit/)
})

test('same-step replacement conflicts explicitly and failed replacement retains the old working set', async () => {
  const rows = [row('a', 'lookup_alpha', 'global', 'alpha'), row('b', 'lookup_beta', 'personal', 'beta')]
  const h = await mount({ rows, script: [call('tool_search', { query: 'lookup_alpha' }),
    response([['tool_search', { query: 'lookup_beta', replace_active: true }], ['tool_search', { query: 'lookup_alpha' }]]), response()] })
  cleanups.push(() => h.close())
  h.ctx.on('tools/post-execute', async (exec, _result, next) => exec.arguments?.replace_active === true
    ? { kind: 'block', feedback: [{ type: 'text', text: 'Fixture block replacement' }] } : next())
  const agent = await h.create(); await h.send(agent)
  assert.ok(h.ctx.tools.get('lookup_alpha', agent))
  assert.equal(h.ctx.tools.get('lookup_beta', agent), undefined)
})

test('successful replacement rejects a second discovery in the same step', async () => {
  const rows = [row('a', 'lookup_alpha', 'global', 'alpha'), row('b', 'lookup_beta', 'personal', 'beta')]
  const h = await mount({ rows, script: [call('tool_search', { query: 'lookup_alpha' }),
    response([['tool_search', { query: 'lookup_beta', replace_active: true }], ['tool_search', { query: 'lookup_alpha' }]]), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  assert.equal(h.ctx.tools.get('lookup_alpha', agent), undefined)
  assert.ok(h.ctx.tools.get('lookup_beta', agent))
  assert.ok(agent.session.snapshotEvents().some(e => e.type === 'tool/result' && e.data.message.isError))
})

test('fresh native Agent from replayed history enforces reduced configuration budgets before first assembly', async () => {
  const rows = [row('a', 'lookup_alpha'), row('b', 'lookup_beta')]
  const first = await mount({ rows, script: [call('tool_search', { query: '案件' }), response()] })
  const original = await first.create(); await first.send(original)
  const seed = original.session.snapshotEvents(); await first.close()
  const h = await mount({ rows, config: { maxActiveTools: 1 }, script: [response()] })
  cleanups.push(() => h.close())
  const handle = await h.ctx.agents.create({ sessionId: 'replayed', seed, agentOptions: { provider: 'fixture', model: 'fixture' } })
  assert.ok(h.ctx.tools.get('lookup_alpha', handle.agent))
  assert.equal(h.ctx.tools.get('lookup_beta', handle.agent), undefined)
  await h.send(handle.agent)
  assert.deepEqual(h.adapter.requests[0].tools.map(t => t.name), ['lookup_alpha', 'mcp', 'tool_search'])
})

test('native owned child and sibling roots have independent activation sets', async () => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response()] })
  cleanups.push(() => h.close())
  const root = await h.ctx.agents.create({ sessionId: 'owned-parent', agentOptions: { provider: 'fixture', model: 'fixture' } })
  const child = await h.ctx.agents.create({ sessionId: 'owned-child', parentAgent: root.agent, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const sibling = await h.create('other-root')
  await h.send(child.agent)
  assert.ok(h.ctx.tools.get('case_lookup', child.agent))
  assert.equal(h.ctx.tools.get('case_lookup', root.agent), undefined)
  assert.equal(h.ctx.tools.get('case_lookup', sibling), undefined)
  await child.dispose()
  assert.equal(h.ctx.agents.get('owned-child'), undefined)
})

test('pre-schema guard picks up unnotified definition changes and tolerates inventory-only revisions', async () => {
  const h = await mount({ script: [call('tool_search', { query: '案件' }), response(), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  h.bridge.rows[0] = { ...h.bridge.rows[0], version: 'v2' }; h.bridge.revision++
  const assembly = await h.ctx.systemPrompt.assemble({ scope: agent })
  assert.deepEqual(assembly.tools.map(t => t.name), ['mcp', 'tool_search'])
  h.ctx.on('agent/pre-step', (payload, next) => { h.bridge.revision++; return next() })
  await h.send(agent)
  assert.equal(h.adapter.requests.length, 3, 'inventory-only changes do not invalidate assembled schemas')
})

for (const mode of ['native', 'ptc']) test(`${mode}: reordered nested schema keys do not revoke an active tool during request preparation`, async () => {
  const parameters = { type: 'object', properties: { query: { type: 'string', description: 'Query' } }, required: ['query'] }
  const h = await mount({ mode, rows: [row('g:cases', 'case_lookup', 'global', '案件', { parameters, inputSchema: parameters })],
    script: [call('tool_search', { query: '案件' }, mode), call('case_lookup', { query: 'fixture' }, mode), response()] })
  cleanups.push(() => h.close())
  const agent = await h.create()
  h.ctx.on('agent/pre-step', async ({ step }, next) => {
    if (step === 2) {
      const reordered = { required: ['query'], properties: { query: { description: 'Query', type: 'string' } }, type: 'object' }
      h.bridge.rows[0] = { ...h.bridge.rows[0], parameters: reordered, inputSchema: reordered }
      h.bridge.notify()
    }
    return next()
  })
  await h.send(agent)
  assert.equal(h.adapter.requests.length, 3)
  assert.deepEqual(h.executions, ['case_lookup'])
  assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')
})

for (const mode of ['native', 'ptc']) for (const change of ['definition', 'authorization', 'run', 'availability'])
  test(`${mode}: request guard rejects active ${change} changes even after a preview assembly`, async () => {
    const h = await mount({ mode, script: [call('tool_search', { query: '案件' }, mode), response()] })
    cleanups.push(() => h.close())
    const agent = await h.create()
    h.ctx.on('agent/pre-step', async ({ step }, next) => {
      if (step === 2) {
        if (change === 'definition') h.bridge.rows[0] = { ...h.bridge.rows[0], version: 'v2' }
        if (change === 'authorization') h.bridge.rows = []
        if (change === 'run') h.bridge.run = 'other-run'
        if (change === 'availability') h.bridge.ready = false
        h.bridge.notify()
        await h.ctx.systemPrompt.assemble({ scope: agent })
      }
      return next()
    })
    await h.send(agent)
    assert.equal(h.adapter.requests.length, 1, 'a preview cannot replace the original request snapshot')
    assert.match(agent.session.snapshotEvents().at(-1).data.reason.error.message, /已加载的插件工具权限或定义/)
    assert.equal(h.executions.length, 0)
  })

for (const mode of ['native', 'ptc']) test(`${mode}: adding an unloaded tool during preparation keeps it hidden without interrupting native work`, async () => {
  const h = await mount({ mode })
  cleanups.push(() => h.close())
  const agent = await h.create()
  h.ctx.on('agent/pre-step', (_payload, next) => {
    const item = row('new', 'new_lookup')
    h.bridge.rows.push(item); h.register(item); h.bridge.notify()
    return next()
  })
  await h.send(agent)
  assert.equal(h.adapter.requests.length, 1)
  assert.ok(!JSON.stringify(h.adapter.requests[0]).includes('new_lookup'))
  assert.equal(h.ctx.tools.get('new_lookup', agent), undefined)
  assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')
})

test('browse returns the whole directory without activation and definition budgets report actionable statuses', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(`r${index}`, `record_${index}`, 'global', '案件记录检索'.repeat(35)))
  rows.push(row('huge', 'huge_schema', 'global', 'large definition', { parameters: { type: 'object', properties: { query: { type: 'string', description: 'x'.repeat(3000) } } } }))
  const h = await mount({ rows, config: { maxToolDefinitionBytes: 2048 }, script: [
    call('mcp', { name: 'records' }), call('tool_search', { query: '案件' }),
    call('tool_search', { query: 'huge_schema' }), response(),
  ] })
  cleanups.push(() => h.close())
  const agent = await h.create(); await h.send(agent)
  assert.deepEqual(h.adapter.requests[1].tools.map(t => t.name), ['mcp', 'tool_search'])
  const results = agent.session.snapshotEvents().filter(e => e.type === 'tool/result').map(e => JSON.parse(e.data.message.content[0].text))
  assert.equal(results[0].items.length, rows.length)
  assert.equal(results[0].items[0].description, rows[0].description)
  assert.equal(results[0].next_cursor, undefined)
  assert.equal(results[0].status, 'browse')
  assert.equal(results[2].items[0].reason, 'definition_too_large')
  assert.equal(h.ctx.tools.get('huge_schema', agent), undefined)
})
