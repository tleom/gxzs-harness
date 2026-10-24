import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import SandboxSpillStore from '../../workbench-sandbox-runtime/src/spill.js'
import * as McpTools from '../src/index.js'

const requireNative = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = async name => import(pathToFileURL(requireNative.resolve(`@deepseek-ai/${name}`)).href)

async function fixture(scopeName = 'global') {
  const [{ Context }, { default: Tools }, Prompt, { createScope }, FsTools, SpillPolicy] = await Promise.all([
    native('cordis'), native('dsh-tools'), native('dsh-system-prompt'), native('dsh-scope'), native('dsh-tool-fs'),
    native('dsh-spill-policy'),
  ])
  const ctx = new Context(), files = new Map()
  const fs = {
    resolve: async path => ({ targetKey: path, displayPath: path }), contains: () => true, processPath: target => target.targetKey,
    writeText: vi.fn(async (target, text) => { files.set(target.targetKey, text) }),
    stat: async target => files.has(target.targetKey) ? { type: 'file', size: Buffer.byteLength(files.get(target.targetKey)), version: 'v1' } : undefined,
    readText: async target => files.get(target.targetKey),
    streamText: async function* (target) { yield files.get(target.targetKey) },
  }
  ctx.provide('fs', fs)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/workspace' }) })
  ctx.provide('workingDirectory', { ensure: async () => '/workspace' })
  await ctx.plugin(Prompt.default)
  await ctx.plugin(Tools, { mode: 'native' })
  await ctx.plugin(SandboxSpillStore, { workspace: '/workspace' })
  await ctx.plugin(FsTools, { read: true, write: false, edit: false, readImage: false })
  await ctx.plugin(SpillPolicy, { maxInlineTokens: 1000 })
  const agent = { id: 'owner-agent', session: { id: 'session-1', header: { id: 'session-1' } } }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  const call = vi.fn()
  const tool = { id: `${scopeName}:mcp:fixture:large`, runtime_name: 'fixture_large', scope: scopeName,
    server_id: 'fixture', tool_name: 'large', version: 'v1', manifest_version: 'm1', description: 'large structured result',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }
  const run = { id: 'run-1', ownerId: 'owner', status: 'running', mcpTools: [tool] }
  ctx.provide('workbenchRuntime', { ownerId: 'owner', executionRun: () => run,
    authorizeMcpCall: async () => ({ ownerId: 'owner', runId: run.id, resource: tool }) })
  ctx.provide('workbenchPlatformClient', { json: async request => {
    if (request.route === 'mcp/catalog') return { tools: [tool] }
    const result = await call(request)
    return { data: { result: scopeName === 'global' ? result : { result } } }
  } })
  await ctx.plugin(McpTools)
  const execute = (name = 'large', args = {}) => ctx.tools.execute({ name, arguments: args, agent,
    callId: 'combined-spill', signal: new AbortController().signal })
  return { ctx, fs, files, call, execute, close: async () => { scope.rawDispose(); await ctx.fiber.dispose() } }
}

it.each(['global', 'personal'])('%s: proxy validates the original outputSchema and preserves the program value while native spill/read recovers the entire long tail', async scope => {
  const h = await fixture(scope)
  try {
    const text = '中文😀'.repeat(4000) + 'TAIL_完整末尾'
    const original = { content: [{ type: 'text', text }], structuredContent: { value: text } }
    h.call.mockResolvedValue(original)
    const result = await h.execute()
    expect(result.isError).toBe(false)
    expect(result.value.structuredContent).toEqual(original.structuredContent)
    expect(original.content[0].text).toBe(text)
    const raw = [...h.files].find(([path]) => !path.endsWith('.readable.txt'))
    const view = [...h.files].find(([path]) => path.endsWith('.readable.txt'))
    expect(raw[1]).toBe(text)
    expect(result.content.map(block => block.text).join('')).toContain(view[0])
    const lines = view[1].split('\n')
    const read = await h.execute('read', { file_path: view[0], offset: lines.length, limit: 1 })
    expect(read.isError).toBe(false)
    expect(read.value.lines.at(-1).text).toContain('TAIL_完整末尾')
    const recovered = []
    for (let offset = 1; offset <= lines.length; offset++) {
      const page = await h.execute('read', { file_path: view[0], offset, limit: 1 })
      recovered.push(page.value.lines[0].text)
    }
    expect(recovered.join('')).toBe(text)
  } finally { await h.close() }
})

it('preserves a successful structured result when native storage fails', async () => {
  const h = await fixture()
  try {
    const text = 'z'.repeat(16000)
    h.fs.writeText.mockRejectedValue(new Error('fixture disk full'))
    h.call.mockResolvedValue({ content: [{ type: 'text', text }], structuredContent: { value: 'complete' } })
    const result = await h.execute()
    expect(result.isError).toBe(false)
    expect(result.value.structuredContent).toEqual({ value: 'complete' })
    expect(result.content[0].text).toBe(text)
    expect(h.files.size).toBe(0)
  } finally { await h.close() }
})

it('retains native rejection of invalid structured output and explicit provider failures', async () => {
  const h = await fixture()
  try {
    h.call.mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }], structuredContent: { value: 1 } })
    expect((await h.execute()).isError).toBe(true)
    expect(h.fs.writeText).not.toHaveBeenCalled()
    h.call.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'provider rejected' }] })
    const result = await h.execute()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('provider rejected')
  } finally { await h.close() }
})
