import { Context, Service } from '@deepseek-ai/cordis'
import SshSubprocessRuntime from '@deepseek-ai/dsh-subprocess-ssh'
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WorkbenchSubprocess from '../src/subprocess.js'
import SandboxSpillStore from '../src/spill.js'

afterEach(() => vi.restoreAllMocks())

describe('sandbox search executable', () => {
  it('resolves rg remotely and preserves arguments, cwd, streams and cancellation', async () => {
    const ctx = new Context()
    const request = vi.fn().mockResolvedValue('/usr/bin/rg')
    ctx.provide('ssh', { request })
    const runtime = new WorkbenchSubprocess(ctx, { ripgrepExecutable: 'rg' })
    await runtime[Service.init]()
    const spawn = vi.spyOn(SshSubprocessRuntime.prototype, 'spawn').mockReturnValue({ marker: true })
    const spec = { argv: [await resolveRgPath(), '--no-config', '--files', '/workspace'], cwd: '/workspace',
      stdio: { stdin: 'ignore' }, signal: new AbortController().signal }
    expect(runtime.spawn(spec)).toEqual({ marker: true })
    expect(request).toHaveBeenCalledWith('executable', { command: 'rg', env: undefined }, expect.anything(), undefined)
    expect(spawn).toHaveBeenCalledWith({ ...spec, argv: ['/usr/bin/rg', ...spec.argv.slice(1)] })
    expect(spec.argv[0]).toBe(await resolveRgPath())
    const ordinary = { ...spec, argv: ['/workspace/custom/rg', 'something'] }
    runtime.spawn(ordinary)
    expect(spawn.mock.calls[1][0]).toBe(ordinary)
    await ctx.fiber.dispose()
  })

  it('fails initialization when the sandbox cannot resolve rg', async () => {
    const ctx = new Context()
    ctx.provide('ssh', { request: vi.fn().mockRejectedValue(new Error('remote rg missing')) })
    const runtime = new WorkbenchSubprocess(ctx, { ripgrepExecutable: 'rg' })
    await expect(runtime[Service.init]()).rejects.toThrow('remote rg missing')
    await ctx.fiber.dispose()
  })
})

describe('sandbox output storage', () => {
  function setup() {
    const ctx = new Context()
    const fs = {
      resolve: vi.fn(async path => ({ targetKey: path })),
      contains: vi.fn(() => true),
      processPath: target => target.targetKey,
      writeText: vi.fn().mockResolvedValue({}),
    }
    ctx.provide('fs', fs)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/workspace' }) })
    return { ctx, fs, store: new SandboxSpillStore(ctx, { workspace: '/workspace' }) }
  }

  it('stores complete UTF-8 output remotely in unique session-scoped files', async () => {
    const { ctx, fs, store } = setup()
    const input = { owner: { sessionId: '../../other' }, suggestedName: '../../escape', content: '中文\nfull output' }
    const a = await store.saveText(input), b = await store.saveText(input)
    expect(a.locator).toMatch(/^\/workspace\/\.agent-output\/[a-f0-9]{32}\/[a-f0-9-]+\.txt$/)
    expect(a.locator).not.toBe(b.locator)
    expect(a.bytes).toBe(Buffer.byteLength(input.content))
    expect(fs.writeText).toHaveBeenCalledWith({ targetKey: a.locator }, input.content,
      { kind: 'createIfAbsent' }, expect.any(AbortSignal), { mode: 'danger-full-access', workspaceRoot: '/workspace' })
    const other = await store.saveText({ ...input, owner: { sessionId: 'other' } })
    expect(other.locator.split('/')[3]).not.toBe(a.locator.split('/')[3])
    await ctx.fiber.dispose()
  })

  it('rejects a resolved path outside the user workspace before writing', async () => {
    const { ctx, fs, store } = setup()
    fs.contains.mockReturnValue(false)
    await expect(store.saveText({ owner: { sessionId: 's' }, content: 'text' })).rejects.toThrow('inside the user workspace')
    expect(fs.writeText).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('propagates remote write failures without returning a local recovery path', async () => {
    const { ctx, fs, store } = setup()
    fs.writeText.mockRejectedValue(new Error('remote disk full'))
    await expect(store.saveText({ owner: { sessionId: 's' }, content: 'text' })).rejects.toThrow('remote disk full')
    await ctx.fiber.dispose()
  })
})
