import { expect, it, vi } from 'vitest'
import { WorkbenchTerminals } from '../src/terminals.js'
import { WorkbenchSubagents } from '../src/subagents.js'
import { sendError } from '../src/http.js'
const owner = { ownerId: 'signed-owner' }
const chat = { id: 'chat', sessionId: 'root' }
const child = { id: 'child', mode: 'continuable', label: '调查' }
const attachment = '12345678-1234-1234-1234-123456789abc'
const service = { requireChat: (who, id) => {
  if (who.ownerId !== owner.ownerId || id !== chat.id) throw Object.assign(new Error('missing'), { status: 404 })
  return chat
} }
it('binds terminals to the signed Session and holds the native process until stream cancellation', async () => {
  const agent = { session: { id: chat.sessionId } }
  const released = vi.fn()
  const native = { list: vi.fn(() => []), create: vi.fn(), close: vi.fn(), write: vi.fn(),
    retain: vi.fn(async function* (_session, _id, signal) { try { yield { type: 'retained' }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) } finally { released() } }),
    follow: vi.fn(async function* () { yield { type: 'snapshot', screen: 'ready' } }) }
  const sessions = { resolveAgent: vi.fn(async () => ({ agent })) }
  const gateway = new WorkbenchTerminals({ native, service, sessions })
  await expect(gateway.create({ ownerId: 'foreign' }, chat.id, { id: attachment }, new AbortController().signal)).rejects.toMatchObject({ status: 404 })
  expect(native.create).not.toHaveBeenCalled()
  const signal = new AbortController().signal
  const stream = gateway.follow(owner, chat.id, attachment, attachment, signal)[Symbol.asyncIterator]()
  expect((await stream.next()).value).toEqual({ event: 'workbench_terminal', value: { type: 'snapshot', screen: 'ready' } })
  expect(native.retain).toHaveBeenCalledWith(chat.sessionId, attachment, expect.any(AbortSignal))
  await stream.return()
  expect(released).toHaveBeenCalledOnce()
  await expect(gateway.control(owner, chat.id, attachment, 'write', { attachment_id: 'invalid' })).rejects.toMatchObject({ status: 400 })
  expect(native.write).not.toHaveBeenCalled()
})
it('authorizes native child history only through its parent catalog and rejects external local addresses', async () => {
  const sessions = { list: vi.fn(async () => ({ items: [
    { sessionId: 'root', projections: { values: { subagentCatalog: [child, { id: 'external', mode: 'external' }] } } },
    { sessionId: 'child', running: true, projections: { values: { title: '原生标题' } } },
    { sessionId: 'foreign' },
  ] })), page: vi.fn(async () => ({ records: [], hasMore: false })) }
  const gateway = new WorkbenchSubagents({ sessions, service })
  const signal = new AbortController().signal
  expect((await gateway.catalog(owner, chat.id, signal))[0]).toMatchObject({ title: '原生标题', running: true })
  await expect(gateway.history(owner, chat.id, 'foreign', {}, signal)).rejects.toMatchObject({ status: 404 })
  await expect(gateway.history(owner, chat.id, 'external', {}, signal)).rejects.toMatchObject({ status: 409 })
  await expect(gateway.history(owner, chat.id, child.id, { sessionId: 'foreign', throughSeq: 9, beforeSeq: 5 }, signal)).rejects.toMatchObject({ status: 400 })
  expect(sessions.page).not.toHaveBeenCalled()
  const result = await gateway.history(owner, chat.id, child.id, { sessionId: 'child', throughSeq: 9, beforeSeq: 5 }, signal)
  expect(sessions.page.mock.calls[0][0].address).toEqual({ kind: 'subagent', parentSessionId: 'root', childSessionId: 'child', mode: 'continuable' })
  expect(result.history_cursor).toBeNull()
})
it('returns stable input and terminal errors without publishing internal diagnostics', () => {
  const res = { writeHead: vi.fn(), end: vi.fn() }
  sendError(res, Object.assign(new Error('/private/config'), { name: 'ScheduleInputError', code: 'frequency_too_high' }))
  expect(res.writeHead.mock.calls[0][0]).toBe(400)
  expect(res.end.mock.calls[0][0]).not.toContain('/private')
  sendError(res, { isDSHRemoteError: true, code: 'terminal/unavailable', message: '/host/path' })
  expect(res.writeHead.mock.calls[1][0]).toBe(404)
})
