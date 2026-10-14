import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { subagentPromptIdentity } from '../../../scripts/prepare-subagent-prompt.mjs'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const source = await readFile(require.resolve('@deepseek-ai/dsh-subagent'), 'utf8')
const prepared = subagentPromptIdentity(source)
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href)
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
  __disposeResources$2: () => {},
  foldSubagentDescriptor: () => ({ mode: 'continuable', provider: 'test' }),
  SubagentError: Error,
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
it('guards the exact alpha.2 admission contract and applies the native repair idempotently', () => {
  expect(prepared).toContain('gxzs: retain the native prompt identity')
  expect(subagentPromptIdentity(prepared)).toBe(prepared)
  const firstAttempt = prepared.replace('agent.session.isOwnSeq(event.seq)', 'event.seq >= agent.session.firstLiveSeq')
  expect(subagentPromptIdentity(firstAttempt)).toBe(prepared)
  expect(() => subagentPromptIdentity(prepared.replace('\tsubmitAdmitted(activation, content, options, parent) {', '\tchangedAdmission() {'))).toThrow('contract changed')
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
    requireSessionQuery: () => ({ observeSession: async () => ({ header: restored.header, inheritedEventCount: restored.inheritedEventCount, events: restored.snapshotEvents() }) }),
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
