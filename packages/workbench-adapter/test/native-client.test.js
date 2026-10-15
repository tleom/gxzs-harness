import { expect, it, vi } from 'vitest'
import { WorkbenchNativeClient } from '../src/native-client.js'

const id = name => `@deepseek-ai/${name}`
const row = (name, inject = [], external = []) => ({ id: id(name), url: `plugins/${name}.js?r=1`, rev: '1', inject: inject.map(id), external })
function fixture() {
  const entries = [row('dsh-client-modules'), row('dsh-client-connection'), row('dsh-api-gateway', ['dsh-client-connection']),
    row('dsh-api-job-controller', ['dsh-api-gateway']), row('dsh-api-session-controller', [], [id('dsh-api-gateway') + '/client']),
    { id: '@gxzs/dsh-workbench-adapter', url: 'plugins/workbench-adapter.js?r=1', rev: '1', inject: [] }, row('unrelated-renderer')]
  const registry = { graph: () => ({ entries, batches: [] }), fetchBundle: vi.fn(async () => new Response('window.__ModuleLoader__.load({})')) }
  return { entries, registry, bridge: new WorkbenchNativeClient({ modules: () => registry }) }
}
it('keeps the original dependency graph and bootstrap while excluding unrelated client renderers', async () => {
  const { bridge, registry } = fixture()
  const manifest = bridge.manifest()
  expect(manifest.protocol).toBe(1)
  expect(manifest.bootstrap).toContain('window.__ModuleLoader__')
  expect(manifest.boot.entries.map(row => row.id)).not.toContain(id('unrelated-renderer'))
  expect(manifest.boot.entries.find(row => row.id === id('dsh-api-gateway')).inject).toEqual([id('dsh-client-connection')])
  expect(manifest.boot.batches.flatMap(row => row.entries)).toEqual(manifest.boot.entries.map(row => row.id))
  const url = manifest.boot.entries[0].url
  expect(await bridge.bundle(url, manifest.boot.rev)).toEqual({ source: 'window.__ModuleLoader__.load({})' })
  expect(registry.fetchBundle.mock.calls[0][0].url).toBe(new URL(url, 'http://workbench.local/').href)
})
it.each(['../../private.json', 'https://other.invalid/code.js', 'plugins/unrelated-renderer.js?r=1', 'plugins/dsh-api-gateway.js?r=2'])('rejects unadvertised assets %s before touching the registry', async url => {
  const { bridge, registry } = fixture()
  await expect(bridge.bundle(url, bridge.manifest().boot.rev)).rejects.toMatchObject({ status: 404 })
  expect(registry.fetchBundle).not.toHaveBeenCalled()
})
it('rejects stale boot revisions and propagates unavailable original assets', async () => {
  const { bridge, registry, entries } = fixture()
  const before = bridge.manifest()
  entries[0].rev = '2'
  await expect(bridge.bundle(entries[0].url, before.boot.rev)).rejects.toMatchObject({ status: 409 })
  expect(registry.fetchBundle).not.toHaveBeenCalled()
  registry.fetchBundle.mockResolvedValueOnce(new Response('', { status: 404 }))
  await expect(bridge.bundle(entries[0].url, bridge.manifest().boot.rev)).rejects.toMatchObject({ status: 404 })
})
it('does not turn an absent or incomplete native registry into a ready empty catalog', () => {
  expect(() => new WorkbenchNativeClient({ modules: () => undefined }).manifest()).toThrow('尚未就绪')
  const { bridge, entries } = fixture()
  entries.splice(0, 1)
  expect(() => bridge.manifest()).toThrow('模块尚未就绪')
})
