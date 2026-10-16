import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { agentLoopPath, prepareAgentInbox } from '../../../scripts/prepare-dsh-agent-inbox.mjs'
import { WorkbenchDatabase } from '../src/persistence.js'
import { TaskScheduler } from '../src/scheduler.js'
import { prepareRecoveredInboxes, reconcileNativeSessions, projectInboxClaim, projectSessionEvent } from '../src/projection.js'

const profile = fileURLToPath(new URL('../../../profiles/workbench/', import.meta.url))
const require = createRequire(join(profile, 'package.json'))
const native = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const [{ Context }, { default: Llm, LlmAdapter, createUserMessage }, { default: Sessions },
  { default: Projections }, { default: Prompt }, { default: Tools }, { default: Agents }] = await Promise.all([
  native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'),
  native('dsh-system-prompt'), native('dsh-tools'), native('dsh-agent'),
])
const files = []
let original, prepared, baselineLoop, fixedLoop
beforeAll(async () => {
  const path = await agentLoopPath(profile)
  original = (await readFile(path, 'utf8')).replace('machine.cancel({ kind: "disposed" }, { keepInbox: true });', 'machine.cancel({ kind: "disposed" });')
    .replace('\tresumePending() {\n\t\tif (this.phase.kind === "idle" && this.inbox.hasPending) this.wakeDriver();\n\t}\n', '')
  prepared = prepareAgentInbox(original)
  const load = async source => {
    const file = join(dirname(path), `gxzs-inbox-${randomUUID()}.js`)
    files.push(file)
    await writeFile(file, source)
    return (await import(pathToFileURL(file).href)).default
  }
  baselineLoop = await load(original)
  fixedLoop = await load(prepared)
})
afterAll(async () => { await Promise.all(files.map(path => unlink(path))) })

async function mount(Loop, block = false) {
  const ctx = new Context(), entered = Promise.withResolvers()
  ctx.provide('workingDirectory', { defaultDirectory: process.cwd(), get: () => process.cwd(), ensure: async () => process.cwd() })
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents, Loop]) await ctx.plugin(plugin)
  let requests = 0
  class Model extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream({ signal }) {
      requests++
      entered.resolve()
      if (block) await new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Model())
  return { ctx, entered: entered.promise, requests: () => requests, close: () => ctx.fiber.dispose() }
}
const message = (text, kind = 'user') => createUserMessage({ source: { kind }, content: [{ type: 'text', text }] })
function pending(events) {
  const state = { 'next-turn': [], 'next-step': [] }
  for (const event of events) if (event.type === 'agent/inbox/spliced') {
    const data = event.data
    state[data.target].splice(data.start, data.removedCount ?? 0, ...(data.inserted ?? []))
  }
  return [...state['next-turn'], ...state['next-step']]
}

it('guards the pinned lifecycle contract and applies idempotently', () => {
  expect(prepareAgentInbox(prepared)).toBe(prepared)
  expect(() => prepareAgentInbox(original.replace('await machine.whenIdle();', 'await machine.changed();'))).toThrow('contract changed')
})

it('reproduces upstream disposal losing unclaimed schedule messages', async () => {
  const h = await mount(baselineLoop, true)
  try {
    const agent = await h.ctx.agentLoop.create('baseline', { provider: 'fixture', model: 'fixture' })
    agent.followup(message('active'))
    await h.entered
    agent.followup(message('pending schedule', 'schedule'))
    expect(pending(agent.session.snapshotEvents())).toHaveLength(1)
    await h.close()
    expect(pending(agent.session.snapshotEvents())).toEqual([])
  } finally { await h.close() }
})

it('automatically drains preserved messages after cold recovery and capacity admission without replaying the claimed turn', async () => {
  const h = await mount(fixedLoop, true)
  let seed, first, second, active
  try {
    const agent = await h.ctx.agentLoop.create('original', { provider: 'fixture', model: 'fixture' })
    active = message('active')
    agent.followup(active)
    await h.entered
    first = message('first reminder', 'schedule')
    second = message('second reminder', 'schedule')
    agent.followup(first)
    agent.followup(second)
    await h.close()
    seed = agent.session.snapshotEvents()
    expect(pending(seed).map(row => row.id)).toEqual([first.id, second.id])
    expect(h.requests()).toBe(1)
    expect(seed.filter(event => event.type === 'turn/end').at(-1).data.reason).toMatchObject({ kind: 'aborted', reason: { kind: 'disposed' } })
  } finally { await h.close() }
  const restored = await mount(fixedLoop)
  const db = new WorkbenchDatabase(':memory:')
  const owner = 'test:owner'
  const chat = db.createChat({ ownerId: owner, sessionId: 'restored', selection: {} })
  let handle, capacity = 'queued'
  const admissions = []
  const scheduler = new TaskScheduler({ database: db, ownerId: owner, agents: restored.ctx.agents,
    sessions: {}, platformClient: { json: async request => {
      admissions.push(request)
      return { state: capacity }
    } } })
  try {
    const queued = await reconcileNativeSessions(db, { observeSession: async () => ({ events: seed }) }, owner, { mcpTools: [] })
    expect(queued).toEqual([first.id, second.id])
    const sessions = { resolveAgent: async () => {
      handle ??= await restored.ctx.agents.create({ sessionId: chat.sessionId, seed, agentOptions: { provider: 'fixture', model: 'fixture' } })
      return { agent: handle.agent }
    } }
    restored.ctx.on('agent/pre-step', async (payload, next) => {
      for (const message of payload.messages) projectInboxClaim(db, { agent: payload.agent, message, turn: payload.turn }, owner)
      return scheduler.admitNativeStep(payload, next)
    }, { global: true })
    restored.ctx.on('session/event', (session, event) => projectSessionEvent(db, session.id, event, owner), { global: true })
    const resume = await prepareRecoveredInboxes(db, sessions, owner, queued)
    expect(restored.requests()).toBe(0)
    resume()
    resume() // Recovery retry must not create a second driver or message.
    await vi.waitFor(() => expect(admissions.length).toBeGreaterThan(0))
    expect(restored.requests()).toBe(0)
    capacity = 'running'
    await handle.agent.whenIdle()
    expect(restored.requests()).toBe(2)
    const ids = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id)
    for (const row of [active, first, second]) expect(ids.filter(id => id === row.id)).toHaveLength(1)
    expect(db.getRun(owner, first.id).status).toBe('completed')
    expect(db.getRun(owner, second.id).status).toBe('completed')
    expect(pending(handle.agent.session.snapshotEvents())).toEqual([])
  } finally { scheduler.close(); await restored.close(); db.close() }
})

it('does not start any recovered inbox if another restore fails or a receipt is cancelled or archived', async () => {
  const db = new WorkbenchDatabase(':memory:')
  const owner = 'test:owner', resume = vi.fn()
  const create = sessionId => {
    const chat = db.createChat({ ownerId: owner, sessionId, selection: {} })
    const { run } = db.createRun({ ownerId: owner, chatId: chat.id, sessionId, query: 'queued', selection: {} })
    db.adoptInboxMessage(sessionId, run.id, 'message-' + sessionId)
    return run
  }
  const first = create('one'), second = create('two')
  try {
    await expect(prepareRecoveredInboxes(db, { resolveAgent: async id => id === 'one'
      ? { agent: { resumePending: resume } } : { error: new Error('restore failed') } }, owner, [first.id, second.id])).rejects.toThrow('restore failed')
    expect(resume).not.toHaveBeenCalled()
    const wake = await prepareRecoveredInboxes(db, { resolveAgent: async () => ({ agent: { resumePending: resume } }) }, owner, [first.id, second.id], () => ['two'])
    db.transitionRun(owner, first.id, 'cancelled')
    wake()
    expect(resume).not.toHaveBeenCalled()
  } finally { db.close() }
})

it('retains explicit user cancellation of pending work', async () => {
  const h = await mount(fixedLoop, true)
  try {
    const agent = await h.ctx.agentLoop.create('cancelled', { provider: 'fixture', model: 'fixture' })
    agent.followup(message('active'))
    await h.entered
    agent.followup(message('cancel this reminder', 'schedule'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(pending(agent.session.snapshotEvents())).toEqual([])
    await h.close()
    expect(pending(agent.session.snapshotEvents())).toEqual([])
    expect(h.requests()).toBe(1)
  } finally { await h.close() }
})
