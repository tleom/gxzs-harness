import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Config } from '../src/index.js'
import { activationEntry, buildCatalog, renderCatalog, search } from '../src/catalog.js'
import { ACTIVE_EVENT, activeStateSchema, discoveryProjection } from '../src/projection.js'
import { row } from './helpers.mjs'

const config = Config({})
const snapshot = tools => ({ ready: true, authorityKey: 'owner\0run', revision: 'r1', tools, plugins: [
  { id: 'global:mcp:records', name: '共享平台', callName: 'shared_records', description: '法律文书与裁判档案', scope: 'global' },
  { id: 'personal:mcp:records', name: '个人平台', callName: 'my_records', description: '客户沟通记录', scope: 'personal', preferred: true },
] })

test('search handles exact names, English identifiers, Chinese descriptions, plugin call names and scoped plugin identities', () => {
  const catalog = buildCatalog(snapshot([
    row('g:one', 'findCourtCases', 'global', '按案号检索案件'), row('g:two', 'findCourtJudgments', 'global', '裁判文书下载'),
    row('p:one', 'lookupContacts', 'personal', '检索客户电话', { pluginCallName: 'my_records' }),
  ]), config)
  assert.deepEqual(search(catalog, 'findCourtCases').map(t => t.id), ['g:one'])
  assert.equal(search(catalog, 'g:one').length, 0)
  assert.ok(search(catalog, 'court judgments').some(t => t.id === 'g:two'))
  assert.equal(search(catalog, '客户电话')[0].id, 'p:one')
  assert.equal(search(catalog, 'my_records')[0].id, 'p:one')
  assert.deepEqual(search(catalog, '法律文书').map(t => t.pluginScope), ['global', 'global'])
  assert.deepEqual(search(catalog, '', 'personal:mcp:records').map(t => t.id), ['p:one'])
  assert.equal(search(catalog, 'volcanology').length, 0)
  const summary = renderCatalog(catalog, config)
  assert.match(summary, /my_records/)
  assert.match(summary, /shared_records/)
  assert.ok(summary.indexOf('my_records') < summary.indexOf('shared_records'))
  assert.ok(!summary.includes('global:mcp:records'))
  assert.ok(!summary.includes('findCourtCases'))
})

test('plugin summaries remain complete and search indexes include description tails', () => {
  const description = '插件说明'.repeat(500) + '罕见尾部能力'
  const catalog = buildCatalog({ ready: true, tools: [row('a', 'alpha')], plugins: [
    { id: 'global:mcp:records', name: 'records', displayName: '完整插件', description },
  ] }, config)
  assert.ok(renderCatalog(catalog, config).includes(description))
  assert.deepEqual(search(catalog, '罕见尾部能力').map(tool => tool.name), ['alpha'])
})

test('catalog and projection validate identities, schema fingerprints and bounded state', () => {
  const item = row('a', 'lookup_alpha'), catalog = buildCatalog(snapshot([item]), config)
  const entry = activationEntry(catalog.byId.get('a'))
  assert.ok(activeStateSchema.safeParse({ version: 1, authorityKey: 'owner\0run', tools: [entry] }).success)
  assert.notEqual(buildCatalog(snapshot([{ ...item, parameters: { type: 'object', properties: { changed: { type: 'boolean' } } } }]), config).byId.get('a').fingerprint, entry.fingerprint)
  assert.throws(() => buildCatalog(snapshot([item, item]), config), /重复/)
  assert.throws(() => buildCatalog(snapshot([{ ...item, name: 'tool_search' }]), config), /保留/)
  assert.throws(() => buildCatalog(snapshot([item]), { ...config, maxIndexBytes: 10 }), /索引/)
  assert.deepEqual(discoveryProjection.apply({ tools: [entry] }, { type: ACTIVE_EVENT, ignorable: true, data: { invalid: true } }).tools, [])
})

test('plugin names are validated and collisions across scopes are explicit', () => {
  const tools = [row('g', 'global_lookup'), row('p', 'personal_lookup', 'personal')]
  assert.throws(() => buildCatalog({ ready: true, tools, plugins: [
    { id: 'global:mcp:records', name: 'same' }, { id: 'personal:mcp:records', name: 'same' },
  ] }, config), /插件名称重复/)
  assert.throws(() => buildCatalog({ ready: true, tools: [], plugins: [
    { id: 'legacy', name: '中文名称' },
  ] }, config), /插件名称无效/)
  assert.throws(() => buildCatalog(snapshot([row('reserved', 'mcp')]), config), /保留/)
})

test('activation budgets count callable schemas while source differences remain complete and fingerprinted', () => {
  const parameters = { type: 'object', properties: { query: { type: 'string' } } }
  const make = inputSchema => buildCatalog(snapshot([row('a', 'lookup', 'global', 'lookup', { parameters, inputSchema })]), config).byId.get('a')
  const base = make(undefined), identical = make({ properties: parameters.properties, type: 'object' })
  assert.equal(identical.definitionBytes, base.definitionBytes)
  assert.equal(identical.definition.inputSchema, undefined)
  const original = { ...parameters, required: ['query'], additionalProperties: false }
  const different = make(original)
  assert.deepEqual(different.definition.inputSchema, original)
  assert.equal(different.definitionBytes, base.definitionBytes)
  assert.notEqual(different.fingerprint, base.fingerprint)
})
