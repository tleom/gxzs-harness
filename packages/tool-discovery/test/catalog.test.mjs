import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Config } from '../src/index.js'
import { activationEntry, buildCatalog, bytes, cursorSignature, decodeCursor, encodeCursor, renderCatalog, search } from '../src/catalog.js'
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
  assert.deepEqual(search(catalog, 'g:one').map(t => t.id), ['g:one'])
  assert.ok(search(catalog, 'court judgments').some(t => t.id === 'g:two'))
  assert.equal(search(catalog, '客户电话')[0].id, 'p:one')
  assert.equal(search(catalog, 'my_records')[0].id, 'p:one')
  assert.deepEqual(search(catalog, '法律文书').map(t => t.pluginScope), ['global', 'global'])
  assert.deepEqual(search(catalog, '', 'personal:mcp:records').map(t => t.id), ['p:one'])
  assert.equal(search(catalog, 'volcanology').length, 0)
  const summary = renderCatalog(catalog, config)
  assert.match(summary, /my_records/)
  assert.match(summary, /shared_records/)
  assert.ok(summary.indexOf('personal:mcp:records') < summary.indexOf('global:mcp:records'))
  assert.ok(!summary.includes('findCourtCases'))
})

test('summary has a UTF-8 byte bound and stable cursors invalidate on metadata, authority or query changes', () => {
  const input = snapshot(Array.from({ length: 100 }, (_, index) => row(`t${index}`, `lookup_${index}`, 'global', '中文说明'.repeat(80), { pluginId: `global:mcp:provider${index}` })))
  const catalog = buildCatalog(input, config)
  const summary = renderCatalog(catalog, { ...config, maxSummaryBytes: 512 })
  assert.ok(bytes(summary) <= 512)
  assert.match(summary, /另有/)
  const signature = cursorSignature(catalog, 'lookup', '')
  const cursor = encodeCursor(signature, 8)
  assert.equal(decodeCursor(cursor, signature, 100), 8)
  assert.equal(decodeCursor(cursor, cursorSignature({ ...catalog, revision: 'r2' }, 'lookup', ''), 100), undefined)
  assert.equal(decodeCursor(cursor, cursorSignature({ ...catalog, authorityKey: 'foreign' }, 'lookup', ''), 100), undefined)
  assert.equal(decodeCursor(cursor, cursorSignature(catalog, 'different', ''), 100), undefined)
  assert.equal(decodeCursor('not-a-cursor', signature, 100), undefined)
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

test('an oversized preferred summary row does not hide later plugins that fit', () => {
  const longId = `global:mcp:${'long-'.repeat(150)}`
  const catalog = buildCatalog({ ready: true, tools: [row('long', 'lookup_long', 'global', 'long', { pluginId: longId }),
    row('short', 'lookup_short', 'personal', 'short')], plugins: [{ id: longId, preferred: true }] }, config)
  const summary = renderCatalog(catalog, { ...config, maxSummaryBytes: 512 })
  assert.ok(bytes(summary) <= 512)
  assert.ok(summary.includes('personal:mcp:records'))
  assert.ok(!summary.includes(longId))
})
