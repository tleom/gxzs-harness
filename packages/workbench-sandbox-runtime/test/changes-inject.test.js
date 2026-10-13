import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { inject } from '../src/changes.js'
import { prepareWorkspaceChanges } from '../../../scripts/prepare-workspace-changes.mjs'

it('allows the native mutation recorder to resolve fs inside the actual Cordis plugin scope', async () => {
  await prepareWorkspaceChanges(resolve('profiles/workbench'))
  const require = createRequire(new URL('../package.json', import.meta.url))
  const modulePath = join(dirname(require.resolve('@deepseek-ai/dsh-workspace-changes')), 'gxzs-sandbox.js')
  const { createWorkspaceChanges } = await import(pathToFileURL(modulePath).href)
  const ctx = new Context(), handlers = new Map(), seen = []
  ctx.provide('subprocess', { resolveExecutable: async () => { throw new Error('no git') } })
  ctx.provide('fs', { processPath: target => { seen.push(target); return '/workspace/file.txt' } })
  const native = createWorkspaceChanges({ homedir: () => '/workspace', tmpdir: () => '/tmp',
    mkdtemp: async () => '/tmp/test', mkdir: async () => {}, rm: async () => {},
    captureFile: async () => ({ kind: 'missing' }) })
  try {
    await ctx.plugin({ name: 'test-remote-recorder', inject, apply(scope) {
      const on = scope.on.bind(scope)
      scope.on = (name, handler, ...options) => { handlers.set(name, handler); return on(name, handler, ...options) }
      native.apply(scope, { timeoutMs: 30000, outputMaxBytes: 8388608, maxFiles: 500, maxFileBytes: 2097152, diffTimeoutMs: 100 })
    } })
    const session = { id: 's', header: { cwd: '/workspace' }, append() {} }
    handlers.get('session/event')(session, { type: 'turn/start', data: { turn: 1 } })
    const exec = { agent: { session }, name: 'write', arguments: { file_path: 'file.txt', content: 'text' } }
    await handlers.get('tools/pre-execute')(exec, () => handlers.get('fs/write-intent')({ path: 'file.txt' }, exec, () => undefined))
    expect(seen).toEqual([{ path: 'file.txt' }])
    const edit = { ...exec, name: 'edit' }
    await handlers.get('tools/pre-execute')(edit, () => handlers.get('fs/edit-intent')({ path: 'file.txt' }, edit, () => undefined))
    expect(seen).toHaveLength(2)
  } finally { await ctx.fiber.dispose() }
})
