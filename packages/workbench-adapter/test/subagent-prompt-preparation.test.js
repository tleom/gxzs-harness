import { createRequire } from 'node:module'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { afterAll, expect, it, vi } from 'vitest'
import { subagentPromptIdentity } from '../../../scripts/prepare-subagent-prompt.mjs'
import { prepareAgentInbox } from '../../../scripts/prepare-dsh-agent-inbox.mjs'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const source = await readFile(require.resolve('@deepseek-ai/dsh-subagent'), 'utf8')
const prepared = subagentPromptIdentity(source)
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
const loopSource = await readFile(require.resolve('@deepseek-ai/dsh-agent-loop'), 'utf8')
// Exercise the shipped durable inbox and fold, including claim removing pending
// input before prompt preparation/admission appends user/message.
const inboxStart = loopSource.indexOf('const inboxProjectionDefinition = {')
const inboxEnd = loopSource.indexOf('//#endregion', inboxStart)
const { Inbox, projection } = runInNewContext(`(() => {
  ${loopSource.slice(inboxStart, inboxEnd)}
  return { Inbox: ReactLoopInbox, projection: inboxProjectionDefinition };
})()`, { inboxProjectionSchema: {} })
const loopFile = join(dirname(require.resolve('@deepseek-ai/dsh-agent-loop')), `gxzs-prompt-${randomUUID()}.js`)
await writeFile(loopFile, prepareAgentInbox(loopSource))
afterAll(() => unlink(loopFile))
const { default: Loop } = await import(pathToFileURL(loopFile).href)
const native = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)
const [{ Context }, { default: Llm, LlmAdapter }, { default: Sessions }, { default: Projections },
  { default: Prompt }, { default: Tools }, { default: Agents }] = await Promise.all([
  native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'),
  native('dsh-system-prompt'), native('dsh-tools'), native('dsh-agent'),
])
async function runtime() {
  const ctx = new Context()
  ctx.provide('workingDirectory', { defaultDirectory: process.cwd(), get: () => process.cwd(), ensure: async () => process.cwd() })
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents, Loop]) await ctx.plugin(plugin)
  let calls = 0
  class Model extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream() {
      calls++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Model())
  return { ctx, calls: () => calls, close: () => ctx.fiber.dispose() }
}
const start = prepared.indexOf('\tsubmitAdmitted(activation, content, options, parent) {')
const end = prepared.indexOf('\t/** Refuse image content', start)
// Execute the exact published admission body; outer ownership and persistence
// integration is separately verified through the actual managed-child Host path.
const admit = runInNewContext(`(${prepared.slice(start,end).trim().replace('submitAdmitted(', 'function(')})`, {
  requireLocalActivation: activation => activation,
  createUserMessage,
  createAgentMessage: vi.fn(() => { throw new Error('This probe uses browser prompts only') }),
})
const coldStart = prepared.indexOf('\tasync coldResume(parent, childId, content, options) {')
const coldEnd = prepared.indexOf('\t/** Admit a materialized child', coldStart)
const coldResume = runInNewContext(`(${prepared.slice(coldStart,coldEnd).trim().replace('async coldResume(', 'async function(')})`, {
  __addDisposableResource$2: (_env, value) => value,
  __disposeResources$2: env => { if (env.hasError) throw env.error },
  foldSubagentDescriptor: () => ({ mode: 'continuable', provider: 'test' }),
  hasIndependentPresetSelection: () => false,
  SubagentError: Error,
  requireLocalActivation: activation => activation,
})
function fixture(rpcId = 'same-id') {
  const message = createUserMessage({ content: [{ type: 'text', text: 'proof' }], source: { kind: 'user', rpcId } })
  const inbox = { nextTurn: [], nextStep: [] }
  const parent = Session.create('parent')
  parent.append('turn/start', { turn: 1 })
  parent.append('user/message', { ...createUserMessage({ content: message.content, source: message.source }), turn: 1 }, { surfaceOp: 'append' })
  parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const session = Session.create('child', parent.snapshotEvents(), {
    ...parent.header, id: 'child', parentSession: 'parent', origin: 'subagent', isSeeded: true,
  }, parent.seq)
  const agent = { inbox, session }
  const activation = { childId: 'child', parent: { id: 'parent' }, handle: { agent } }
  const manager = {
    assertAdmitting: vi.fn(), authorizeLineage: vi.fn(), acquireOwnership: vi.fn(),
    deliver: vi.fn((_activation, value) => inbox.nextTurn.push(value)), wake: vi.fn(),
  }
  const signal = new AbortController().signal
  const submit = (requestId = rpcId) => admit.call(manager, activation, message.content,
    { source: { kind: 'user', rpcId: requestId }, delivery: 'queue', signal }, { id: 'parent' })
  return { message, manager, inbox, agent, submit }
}
function durableInbox(test) {
  const inbox = new Inbox({ stateOf: session => session.snapshotEvents()
    .filter(event => session.isOwnSeq(event.seq)).reduce(projection.apply, projection.init()) },
  test.agent.session, { emit: vi.fn() })
  test.agent.inbox = inbox
  test.manager.deliver.mockImplementation((_activation, message) => inbox.append('next-turn', message))
  return inbox
}
function observation(session) {
  return { header: session.header, inheritedEventCount: session.inheritedEventCount,
    events: session.snapshotEvents(), projections: { values: { inbox: session.snapshotEvents()
      .filter(event => session.isOwnSeq(event.seq)).reduce(projection.apply, projection.init()) } } }
}
it('guards the pinned admission contract and applies the native repair idempotently', () => {
  expect(prepared).toContain('gxzs: retain the native prompt identity')
  expect(subagentPromptIdentity(prepared)).toBe(prepared)
  const changedOwnership = prepared.replace('agent.session.isOwnSeq(event.seq)', 'event.seq >= agent.session.firstLiveSeq')
  expect(() => subagentPromptIdentity(changedOwnership)).toThrow('contract changed')
  expect(() => subagentPromptIdentity(prepared.replace('\tsubmitAdmitted(activation, content, options, parent) {', '\tchangedAdmission() {'))).toThrow('contract changed')
})
it('keeps one delivery when retries arrive after native claim but before user/message', async () => {
  const test = fixture(), inbox = durableInbox(test)
  const first = test.submit()
  expect(inbox.claim('next-turn', 1).map(message => message.id)).toEqual([first])
  expect(inbox.hasPending).toBe(false)
  expect(test.agent.session.snapshotEvents().filter(event => test.agent.session.isOwnSeq(event.seq)
    && event.type === 'user/message')).toEqual([])
  const retries = await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(() => test.submit())))
  expect(retries).toEqual(Array(8).fill(first))
  expect(test.manager.deliver).toHaveBeenCalledOnce()
  expect(test.manager.wake).toHaveBeenCalledOnce()
  expect(inbox.hasPending).toBe(false)
})
it('recognizes claimed next-step input and restored own acceptance without a user/message', () => {
  const test = fixture(), inbox = durableInbox(test)
  inbox.append('next-step', test.message)
  expect(inbox.claim('next-step', 1)).toHaveLength(1)
  const session = test.agent.session
  test.agent.session = Session.fromRestore(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount, 'shared-frozen')
  durableInbox(test)
  expect(test.submit()).toBe(test.message.id)
  expect(test.manager.deliver).not.toHaveBeenCalled()
})
it('does not resurrect canceled input on retry, while a new request still delivers', () => {
  const test = fixture(), inbox = durableInbox(test)
  const first = test.submit()
  expect(inbox.remove(first)).toBe(true)
  expect(inbox.hasPending).toBe(false)
  expect(test.submit()).toBe(first)
  expect(inbox.hasPending).toBe(false)
  const next = test.submit('new-request')
  expect(next).not.toBe(first)
  expect(inbox.nextTurn.map(message => message.id)).toEqual([next])
  expect(test.manager.deliver).toHaveBeenCalledTimes(2)
})
it.each(['claimed', 'canceled'])('answers cold %s acceptance without reactivating the child', async state => {
  const test = fixture(), inbox = durableInbox(test)
  const first = test.submit()
  if (state === 'claimed') inbox.claim('next-turn', 1)
  else inbox.remove(first)
  const session = test.agent.session
  const manager = { ...test.manager,
    requireSessionQuery: () => ({ observeSession: async () => observation(session) }),
    materialize: vi.fn(), submitMaterialized: vi.fn(),
  }
  expect(await coldResume.call(manager, { id: 'parent' }, 'child', test.message.content,
    { source: test.message.source, signal: new AbortController().signal })).toBe(first)
  expect(manager.materialize).not.toHaveBeenCalled()
  expect(manager.submitMaterialized).not.toHaveBeenCalled()
})
it('cold retry resumes the original unclaimed inbox without inserting another message', async () => {
  const test = fixture(), inbox = durableInbox(test)
  const first = test.submit()
  test.agent.resumePending = vi.fn(() => inbox.claim('next-turn', 1))
  const activation = { childId: 'child', parent: { id: 'parent' }, handle: { agent: test.agent } }
  const manager = { ...test.manager,
    requireSessionQuery: () => ({ observeSession: async () => observation(test.agent.session) }),
    materialize: vi.fn(async () => activation),
    submitMaterialized: vi.fn(async () => test.submit()),
  }
  expect(await coldResume.call(manager, { id: 'parent' }, 'child', test.message.content,
    { source: test.message.source, signal: new AbortController().signal })).toBe(first)
  expect(manager.materialize).toHaveBeenCalledOnce()
  expect(test.agent.resumePending).toHaveBeenCalledOnce()
  expect(test.agent.resumePending.mock.results[0].value.map(message => message.id)).toEqual([first])
  expect(test.manager.deliver).toHaveBeenCalledOnce()
})
it('does not deduplicate against inherited parent inbox acceptance', () => {
  const test = fixture()
  const parent = Session.create('parent')
  parent.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [test.message] })
  parent.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  test.agent.session = Session.create('child', parent.snapshotEvents(), {
    ...parent.header, id: 'child', parentSession: 'parent', origin: 'subagent', isSeeded: true,
  }, parent.seq)
  durableInbox(test)
  const first = test.submit()
  expect(first).not.toBe(test.message.id)
  expect(test.submit()).toBe(first)
  expect(test.manager.deliver).toHaveBeenCalledOnce()
})
it.each(['nextTurn','nextStep'])('returns the actual accepted %s identity without delivering or waking again', queue => {
  const test = fixture()
  test.inbox[queue].push(test.message)
  expect(test.submit()).toBe(test.message.id)
  expect(test.manager.authorizeLineage).toHaveBeenCalledWith({ id: 'parent' }, 'child', 'parent')
  expect(test.manager.acquireOwnership).toHaveBeenCalledOnce()
  expect(test.manager.deliver).not.toHaveBeenCalled()
  expect(test.manager.wake).not.toHaveBeenCalled()
})
it('returns the consumed own-suffix message identity after reconstruction without keeping a replay map', () => {
  const test = fixture()
  const session = test.agent.session
  session.append('turn/start', { turn: 2 })
  const own = session.append('user/message', { ...test.message, turn: 2 }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  test.agent.session = Session.fromRestore(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount, 'shared-frozen')
  expect(test.agent.session.firstLiveSeq).toBeGreaterThan(own.seq)
  expect(test.agent.session.inheritedEventCount).toBeLessThan(own.seq)
  expect(test.agent.session.isOwnSeq(own.seq)).toBe(true)
  expect(test.submit()).toBe(test.message.id)
  expect(test.manager.deliver).not.toHaveBeenCalled()
  expect(test.manager.wake).not.toHaveBeenCalled()
})
it('answers a cold persisted replay before materializing or announcing another activation', async () => {
  const test = fixture()
  const session = test.agent.session
  session.append('turn/start', { turn: 2 })
  session.append('user/message', { ...test.message, turn: 2 }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  const restored = Session.fromRestore(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount, 'shared-frozen')
  const manager = { ...test.manager,
    requireSessionQuery: () => ({ observeSession: async () => observation(restored) }),
    materialize: vi.fn(), submitMaterialized: vi.fn(),
  }
  expect(await coldResume.call(manager, { id: 'parent' }, 'child', test.message.content,
    { source: test.message.source, signal: new AbortController().signal })).toBe(test.message.id)
  expect(manager.authorizeLineage).toHaveBeenCalledWith({ id: 'parent' }, 'child', 'parent')
  expect(manager.materialize).not.toHaveBeenCalled()
  expect(manager.submitMaterialized).not.toHaveBeenCalled()
})
it('excludes inherited seed events and admits exactly one occurrence for each new child request', () => {
  const test = fixture()
  const inherited = test.agent.session.snapshotEvents().find(event => event.type === 'user/message')
  expect(test.agent.session.isOwnSeq(inherited.seq)).toBe(false)
  const first = test.submit()
  expect(first).not.toBe(inherited.data.id)
  expect(first).not.toBe(test.message.id)
  expect(test.submit()).toBe(first)
  expect(test.submit('new-id')).not.toBe(first)
  expect(test.manager.deliver).toHaveBeenCalledTimes(2)
  expect(test.manager.wake).toHaveBeenCalledTimes(2)
})
it('retains lineage admission and carrier cancellation ahead of any replay answer', () => {
  const test = fixture()
  test.inbox.nextTurn.push(test.message)
  test.manager.authorizeLineage.mockImplementation(() => { throw new Error('not owned') })
  expect(test.submit).toThrow('not owned')
  expect(test.manager.deliver).not.toHaveBeenCalled()
  const signal = AbortSignal.abort(new Error('cancelled'))
  expect(() => admit.call(test.manager, {}, [], { signal }, {})).toThrow('cancelled')
})
it('executes once in the real loop when retries arrive inside a blocked native pre-step', async () => {
  const h = await runtime(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  try {
    h.ctx.on('agent/pre-step', async (_payload, next) => { entered.resolve(); await release.promise; return next() }, { global: true })
    const agent = await h.ctx.agentLoop.create('claimed-child', { provider: 'fixture', model: 'fixture' })
    const activation = { childId: agent.session.id, parent: { id: 'parent' }, handle: { agent } }
    const manager = { assertAdmitting: vi.fn(), authorizeLineage: vi.fn(), acquireOwnership: vi.fn(),
      deliver: vi.fn((_activation, message) => agent.followup(message)), wake: vi.fn() }
    const options = { source: { kind: 'user', rpcId: 'blocked-claim' }, delivery: 'queue', signal: new AbortController().signal }
    const submit = () => admit.call(manager, activation, [{ type: 'text', text: 'proof' }], options, { id: 'parent' })
    const first = submit()
    await entered.promise
    expect(agent.inbox.hasPending).toBe(false)
    expect(h.calls()).toBe(0)
    expect(await Promise.all(Array.from({ length: 8 }, () => Promise.resolve().then(submit)))).toEqual(Array(8).fill(first))
    release.resolve()
    await agent.whenIdle()
    expect(h.calls()).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source?.rpcId === options.source.rpcId).map(event => event.data.id)).toEqual([first])
    expect(manager.deliver).toHaveBeenCalledOnce()
  } finally { release.resolve(); await h.close() }
})
it('cold replay drives one original pending message through the real restored loop', async () => {
  const h = await runtime(), test = fixture(), inbox = durableInbox(test)
  const first = test.submit(), seed = test.agent.session.snapshotEvents()
  let restored
  const manager = { ...test.manager,
    requireSessionQuery: () => ({ observeSession: async () => observation(test.agent.session) }),
    materialize: vi.fn(async () => {
      restored = await h.ctx.agents.create({ sessionId: 'restored-child', seed, agentOptions: { provider: 'fixture', model: 'fixture' } })
      return { childId: 'restored-child', parent: { id: 'parent' }, handle: restored }
    }),
    submitMaterialized: async (activation, content, options, parent) => admit.call(manager, activation, content, options, parent),
  }
  try {
    expect(inbox.hasPending).toBe(true)
    const receipt = await coldResume.call(manager, { id: 'parent' }, 'child', test.message.content,
      { source: test.message.source, signal: new AbortController().signal })
    expect(receipt).toBe(first)
    await restored.agent.whenIdle()
    expect(h.calls()).toBe(1)
    expect(restored.agent.inbox.hasPending).toBe(false)
    const events = restored.agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'user/message' && event.data.id === first)).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted).filter(message => message.id === first)).toHaveLength(1)
    expect(test.manager.deliver).toHaveBeenCalledOnce()
  } finally { await h.close() }
})
