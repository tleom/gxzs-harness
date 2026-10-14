import { expect, it, vi } from 'vitest'
import { WorkbenchNativeSessions } from '../src/native-sessions.js'

const owner = { ownerId: 'owner' }
function fixture() {
  const listeners = new Map()
  const sessions = {
    list: vi.fn(async () => ({ items: [
      { sessionId: 'root' }, { sessionId: 'child', parentSessionId: 'root' },
      { sessionId: 'grandchild', parentSessionId: 'child' }, { sessionId: 'deleted-root' },
      { sessionId: 'deleted-child', parentSessionId: 'deleted-root' },
      { sessionId: 'cycle-a', parentSessionId: 'cycle-b' }, { sessionId: 'cycle-b', parentSessionId: 'cycle-a' },
    ] })),
    follow: vi.fn(async function* (request) { yield { type: 'snapshot', header: { id: request.address.childSessionId }, cursor: 1 } }),
    page: vi.fn(async request => ({ header: { id: request.address.childSessionId }, records: [], hasMore: false })),
    projections: vi.fn(async () => ({ kind: 'current', asOfSeq: 1, values: { inbox: {} } })),
    attachment: vi.fn(async () => ({ attachment: { attachmentId: 'image' }, data: 'AQI=' })),
    control: vi.fn(async function* () { yield { type: 'baseline', value: { projections: {} } } }),
  }
  const service = { requireChat(who, id) { if (who.ownerId !== 'owner' || id !== 'chat') throw Object.assign(new Error('foreign chat'), { status: 404 }); return { sessionId: 'root' } } }
  const subagents = { requireChild: vi.fn(async (who, id, child) => {
    service.requireChat(who, id)
    if (child !== 'grandchild') throw Object.assign(new Error('foreign child'), { status: 404 })
    return { id: child, parentSessionId: 'child', mode: 'continuable' }
  }) }
  const ctx = { on: (name, callback) => { listeners.set(name, callback); return () => listeners.delete(name) } }
  const gateway = new WorkbenchNativeSessions({ ctx, sessions, subagents, service, database: { listChats: () => [{ sessionId: 'root' }] } })
  return { gateway, sessions, listeners }
}
it('retains original metadata and only returns roots owned by the platform and their recursive descendants', async () => {
  const { gateway } = fixture()
  expect((await gateway.list(owner)).items.map(item => item.sessionId)).toEqual(['root', 'child', 'grandchild'])
})
it('passes the exact native addressed follow, pagination and projection contract after checking the real direct parent', async () => {
  const { gateway, sessions } = fixture()
  const signal = new AbortController().signal
  const address = { kind: 'subagent', parentSessionId: 'child', childSessionId: 'grandchild', mode: 'unknown' }
  const request = { address, maxMessages: 50, turnWindow: 2, assistantStream: true }
  expect((await gateway.follow(owner, 'chat', request, signal).next()).value.event).toBe('native_session')
  expect(sessions.follow).toHaveBeenCalledWith(request, signal)
  await gateway.read(owner, 'chat', 'page', { address, throughSeq: 10, beforeSeq: 5 }, signal)
  expect(sessions.page).toHaveBeenCalledWith({ address, throughSeq: 10, beforeSeq: 5 }, signal)
  await gateway.read(owner, 'chat', 'projections', { address, keys: ['inbox'] }, signal)
  expect(sessions.projections).toHaveBeenCalledWith({ sessionId: 'grandchild', keys: ['inbox'] }, signal)
  expect(await gateway.read(owner, 'chat', 'attachment', { address, attachmentId: 'image' }, signal)).toMatchObject({ data: 'AQI=' })
})
it('rejects another root, a forged direct parent and a bare child identity before any native history access', async () => {
  const { gateway, sessions } = fixture()
  const signal = new AbortController().signal
  for (const address of [
    { kind: 'session', sessionId: 'grandchild' },
    { kind: 'subagent', parentSessionId: 'root', childSessionId: 'grandchild', mode: 'continuable' },
    { kind: 'subagent', parentSessionId: 'child', childSessionId: 'foreign', mode: 'continuable' },
  ]) await expect(gateway.follow(owner, 'chat', { address }, signal).next()).rejects.toBeInstanceOf(Error)
  await expect(gateway.follow({ ownerId: 'foreign' }, 'chat', { address: { kind: 'session', sessionId: 'root' } }, signal).next()).rejects.toMatchObject({ status: 404 })
  expect(sessions.follow).not.toHaveBeenCalled()
})
it('forwards original Session lifecycle notifications and releases every Host listener on close', async () => {
  const { gateway, listeners } = fixture()
  const controller = new AbortController()
  const source = gateway.events(owner, controller.signal)
  expect((await source.next()).value.value.type).toBe('ready')
  listeners.get('api-session/status')('grandchild', true)
  expect((await source.next()).value.value).toEqual({ type: 'emit', event: 'api-session/status', args: ['grandchild', true] })
  controller.abort()
  await source.return()
  expect(listeners.size).toBe(0)
})
it('forwards native settings and model invalidations without exposing other settings namespaces or requiring session-list reads', async () => {
  const {gateway,listeners,sessions}=fixture()
  const controller=new AbortController(), source=gateway.events(owner,controller.signal)
  await source.next()
  listeners.get('settings/document-updated')('llm-pi-ai',1)
  listeners.get('settings/document-updated')('subagent',2)
  const changed=(await source.next()).value
  expect(changed.value).toEqual({type:'emit',event:'settings/document-updated',args:['subagent',2]})
  listeners.get('llm/adapters-updated')()
  expect((await source.next()).value.value).toEqual({type:'emit',event:'llm/adapters-updated',args:[]})
  listeners.get('schedule/changed')()
  expect((await source.next()).value.value).toEqual({type:'emit',event:'schedule/changed',args:[]})
  expect(sessions.list).not.toHaveBeenCalled()
  controller.abort();await source.return()
  expect(listeners.size).toBe(0)
})
