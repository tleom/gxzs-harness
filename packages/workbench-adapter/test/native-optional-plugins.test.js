import { afterEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as TerminalActivity from '../src/persistent-terminal-activity.js'
import { nativeHostActivity } from '../src/host-activity.js'

const profile = fileURLToPath(new URL('../../../profiles/workbench/', import.meta.url))
const require = createRequire(join(profile, 'package.json'))
const native = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const [{ Context }, boot] = await Promise.all([native('cordis'), native('dsh-app-boot')])
const cleanups = []
afterEach(async () => { for (const dispose of cleanups.splice(0).reverse()) await dispose() })

async function context(names) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  for (const name of names) await ctx.plugin((await native('dsh-' + name)).default)
  return ctx
}

function call(ctx, agent, name, args) {
  return ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: AbortSignal.timeout(20_000) })
}
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

it('searches real native sessions and refuses another workspace even with a known session id', async () => {
  const ctx = await context(['llm', 'session', 'session-projection', 'system-prompt', 'tools'])
  await ctx.plugin((await native('dsh-session-query-sqlite')).default, { path: ':memory:', openAt: 'first-search' })
  await ctx.plugin(await native('dsh-tool-session-query'))
  const { createUserMessage } = await native('dsh-llm')
  const current = ctx.sessions.create(undefined, { meta: { cwd: '/workspace/project' } })
  const shared = ctx.sessions.create(undefined, { meta: { cwd: '/workspace/project' } })
  const foreign = ctx.sessions.create(undefined, { meta: { cwd: '/workspace/other' } })
  const add = (session, value) => session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: value }] }), { surfaceOp: 'append' })
  const event = add(shared, 'needle-shared searchable evidence')
  add(foreign, 'needle-foreign hidden evidence')
  const agent = { id: current.id, session: current }
  const result = await call(ctx, agent, 'session_search', { query: 'needle' })
  expect(result.isError, text(result)).not.toBe(true)
  expect(text(result)).toContain(shared.id)
  expect(text(result)).not.toContain(foreign.id)
  const read = await call(ctx, agent, 'session_event_read', { session_id: shared.id, seq: event.seq })
  expect(read.isError, text(read)).not.toBe(true)
  expect(text(read)).toContain('needle-shared')
  const denied = await call(ctx, agent, 'session_event_read', { session_id: foreign.id, seq: event.seq })
  expect(denied.isError).toBe(true)
  expect(text(denied)).not.toContain('needle-foreign')
})

it('runs the official Ralph script through the real PTC process with fresh structured child rounds', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gxzs-ralph-'))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const ctx = await context(['llm', 'session', 'session-projection', 'agent', 'system-prompt', 'tools', 'fs-local', 'subprocess-local', 'sandbox-local'])
  ctx.provide('workingDirectory', { ensure: async () => cwd, get: () => cwd })
  await ctx.plugin((await native('dsh-sandbox-policy')).default, { mode: 'danger-full-access', workspaceRoot: cwd })
  await ctx.plugin((await native('dsh-ptc-runtime-node')).default, {})
  await ctx.plugin((await native('dsh-subagent')).default)
  const requests = []
  ctx.subagents.registerProvider({ name: 'spawn', inheritsParentContext: false,
    capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false },
    async start(request) {
      requests.push(request)
      const done = requests.length === 2
      return { id: randomUUID(), result: Promise.resolve({ output: [], stopReason: 'completed', structured: {
        status: done ? 'complete' : 'continue', summary: done ? 'verified' : 'first pass',
        evidence: done ? ['fixture checked'] : [], nextSteps: done ? [] : ['verify the fixture'], blocker: '',
      } }), dispose: async () => {} }
    } })
  await ctx.plugin((await native('dsh-workflow-ptc')).default, { provider: 'spawn' })
  await ctx.plugin(await native('dsh-tool-ralph'), { subagentProvider: 'spawn', maxRounds: 64 })
  const session = ctx.sessions.create(undefined, { meta: { cwd } })
  const agent = { id: session.id, ctx, session, options: {}, status: 'idle' }
  ctx.agents.register(agent)
  const result = await call(ctx, agent, 'ralph', { objective: 'Verify the synthetic fixture', maxRounds: 2 })
  expect(result.isError, text(result)).not.toBe(true)
  expect(text(result)).toContain('verified')
  expect(requests).toHaveLength(2)
  expect(JSON.stringify(requests[1].prompt)).toContain('first pass')
}, 30_000)

it('revises the native title from all user messages and projects it into the Workbench chat', async () => {
  const { LlmAdapter, createUserMessage } = await native('dsh-llm')
  const { turnBoundaryProjectionDefinition } = await native('dsh-agent-loop')
  const { WorkbenchDatabase } = await import('../src/persistence.js')
  const { projectSessionEvent } = await import('../src/projection.js')
  const ctx = await context(['llm', 'session', 'session-projection'])
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin((await native('dsh-session-title')).default, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  const requests = []
  class TitleAdapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      yield { type: 'text-delta', index: 0, text: requests.length === 1 ? '初始标题' : '完整主题标题' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new TitleAdapter())
  await ctx.plugin(await native('dsh-session-title-all-prompts-llm'), { provider: 'fixture', model: 'fixture',
    targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 1000 })
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace/project' } })
  const db = new WorkbenchDatabase(':memory:')
  cleanups.push(() => db.close())
  const chat = db.createChat({ ownerId: 'fixture', sessionId: session.id, selection: {} })
  ctx.on('session/event', (current, event) => projectSessionEvent(db, current.id, event, 'fixture'))
  for (const value of ['核查第一部分', '增加第二部分']) {
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }), { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'change' })
    await expect.poll(() => db.getChat('fixture', chat.id).title).toBe(value === '核查第一部分' ? '初始标题' : '完整主题标题')
  }
  expect(requests).toHaveLength(2)
  expect(JSON.stringify(requests[1].messages)).toContain('核查第一部分')
  expect(JSON.stringify(requests[1].messages)).toContain('增加第二部分')
  expect(db.getChat('fixture', chat.id).title).toBe('完整主题标题')
  ctx.sessionTitle.rename(session, '手动命名')
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '另一个主题' }] }), { surfaceOp: 'append' })
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'change' })
  await new Promise(resolve => setImmediate(resolve))
  expect(requests).toHaveLength(2)
  expect(db.getChat('fixture', chat.id).title).toBe('手动命名')
})

it('composes all four official bundles once and retains their native providers and title policy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gxzs-optional-profile-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  symlinkSync(join(profile, 'node_modules'), join(dir, 'node_modules'), 'junction')
  const rows = boot.composeEntries([boot.readProfilePatches('dsh', { name: 'workbench', dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: require.resolve('@deepseek-ai/dsh/package.json'),
    cwd: profile, home: dir, startedBundles: manifest.dsh.profile.bundles, overlays: [] })])
  const flatten = rows => rows.flatMap(row => [row, ...(row.group ? flatten(row.config) : [])])
  const all = flatten(rows)
  for (const id of ['optional-tool-session-query', 'tool-ralph', 'optional-tool-terminal',
    'optional-session-title-all-prompts', 'gxzs-persistent-terminal-activity']) {
    expect(all.filter(row => row.id === id && !row.disabled), id).toHaveLength(1)
  }
  const registry = rows.find(row => row.id === 'optional-persistent-terminals')
  expect(registry.isolate).toEqual({ terminals: true })
  expect(registry.config.map(row => row.id)).toEqual(expect.arrayContaining([
    'optional-terminal-registry', 'optional-terminal-bash', 'optional-tool-terminal', 'gxzs-persistent-terminal-activity']))
  expect(all.find(row => row.id === 'session-title-llm').disabled).toBe(true)
  expect(all.find(row => row.id === 'optional-session-title-all-prompts').config).toMatchObject({ maxInputBytes: 4096, maxOutputTokens: 64 })
  expect(all.find(row => row.id === 'tool-ralph').config).toMatchObject({ subagentProvider: 'spawn', maxRounds: 64 })
  expect(all.find(row => row.id === 'optional-session-query-sqlite').config).toMatchObject({
    openAt: 'first-search',
    path: { __jsExpr: "(process.env.DSH_HOME ?? process.cwd()) + '/session-search.sqlite'" },
  })
})

it('holds the Host for isolated native PTYs, observes pending creation and releases its observer on unload', async () => {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const agent = { id: 'owner', status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
  ctx.provide('agents', { list: () => [agent] })
  ctx.provide('jobs', { list: () => [] })
  ctx.provide('schedule', { catalog: async () => [] })
  let busy = true
  const child = ctx.isolate('terminals')
  child.provide('terminals', { hasOwnerActivity: current => current === agent && busy })
  const fork = child.plugin(TerminalActivity)
  await fork
  expect((await nativeHostActivity(ctx)).activeSidebarResources).toBe(1)
  busy = false
  expect((await nativeHostActivity(ctx)).activeSidebarResources).toBe(0)
  await fork.dispose()
  busy = true
  expect((await nativeHostActivity(ctx)).activeSidebarResources).toBe(0)
})
