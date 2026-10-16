import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { mount, row, call, response } from './helpers.mjs'

const cleanups = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

const plugins = () => [
  { id: 'global:mcp:records', name: 'records', displayName: '案件检索', description: '案件资料' },
  { id: 'global:mcp:offline', name: 'offline', displayName: '离线插件', available: false },
  { id: 'global:mcp:restricted', name: 'restricted', displayName: '未授权插件', available: false, unavailableReason: 'run_authorization_required' },
]
const catalogs = agent => agent.session.snapshotEvents()
  .filter(event => event.type === 'user/message' && event.data.source.kind === 'mcp-catalog')
  .map(event => event.data.content[0].text)

for (const mode of ['native', 'ptc']) {
  test(`${mode}: reminder and mcp directory expose the same available plugins without changing internal inventory`, async () => {
    const h = await mount({ mode, rows: [row('a', 'lookup')], script: [call('mcp', {}, mode), response()] })
    cleanups.push(() => h.close())
    h.bridge.plugins = plugins()
    const agent = await h.create(); await h.send(agent)
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    const value = JSON.parse(result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    assert.deepEqual(value.items.map(plugin => plugin.name), ['records'])
    assert.equal(value.items[0]['display-name'], '案件检索')
    for (const text of catalogs(agent)) {
      assert.ok(text.includes('`records`（案件检索）'))
      assert.doesNotMatch(text, /offline|restricted|离线插件|未授权插件|暂不可用/)
    }
    assert.equal(h.bridge.plugins.length, 3, 'filtering a directory must preserve the full authority inventory')
    assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')
  })

  test(`${mode}: availability changes replace the visible catalog without interrupting or repeating work`, async () => {
    const h = await mount({ mode, rows: [], script: [response(), response(), response()] })
    cleanups.push(() => h.close())
    h.bridge.plugins = plugins()
    const agent = await h.create(); await h.send(agent)
    assert.equal(catalogs(agent).length, 1)
    assert.ok(catalogs(agent)[0].includes('`records`'))
    h.bridge.plugins = plugins().map(plugin => ({ ...plugin, available: plugin.name === 'offline' }))
    h.bridge.notify()
    await h.send(agent)
    assert.equal(catalogs(agent).length, 2)
    assert.ok(catalogs(agent)[1].includes('`offline`（离线插件）'))
    assert.doesNotMatch(catalogs(agent)[1], /`records`|restricted|未获授权|暂不可用/)
    h.bridge.notify()
    await h.send(agent)
    assert.equal(catalogs(agent).length, 2, 'a revision without a visible directory change must not republish')
    assert.equal(h.adapter.requests.length, 3)
    assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')
  })
}
