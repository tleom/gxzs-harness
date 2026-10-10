import { expect, it, vi } from 'vitest'
import { loadNativeHistoryPage } from '../src/history-page.js'

function fixture(page) {
  const dispose = vi.fn()
  return {
    dispose,
    sessionQuery: { observeSession: vi.fn(async () => ({ events: [{ seq: 99 }], [Symbol.dispose]: dispose })) },
    sessions: { page: vi.fn(async () => page) },
  }
}
const signal = () => new AbortController().signal
it('delegates the exact native window and keeps replacement records intact', async () => {
  const records = [{ type: 'event', event: { seq: 40, type: 'turn/start' } },
    { type: 'event', event: { seq: 41, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 10 } } }]
  const services = fixture({ records, hasMore: true }), abort = signal()
  const result = await loadNativeHistoryPage(services, 'session-a', undefined, abort)
  expect(services.sessions.page).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'session-a' },
    throughSeq: 99, maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } }, abort)
  expect(result.records).toBe(records)
  expect(services.sessionQuery.observeSession).toHaveBeenCalledWith('session-a', { signal: abort, projectionMode: 'none' })
  expect(result.cursor).toEqual({ sessionId: 'session-a', throughSeq: 99, beforeSeq: 40 })
  expect(services.dispose).toHaveBeenCalledOnce()
})
it('pins subsequent reads to the opening cursor despite newer events', async () => {
  const services = fixture({ records: [{ type: 'event', event: { seq: 0 } }], hasMore: false })
  const result = await loadNativeHistoryPage(services, 's', { sessionId: 's', throughSeq: 99, beforeSeq: 40 }, signal())
  expect(services.sessionQuery.observeSession).not.toHaveBeenCalled()
  expect(services.sessions.page.mock.calls[0][0]).toMatchObject({ throughSeq: 99, beforeSeq: 40 })
  expect(result.cursor).toBeNull()
})
it('rejects cross-session, malformed and non-advancing cursors', async () => {
  const services = fixture({ records: [{ type: 'event', event: { seq: 40 } }], hasMore: true })
  for (const cursor of [null, { sessionId: 'other', throughSeq: 99, beforeSeq: 40 },
    { sessionId: 's', throughSeq: 99, beforeSeq: 101 }, { sessionId: 's', throughSeq: NaN, beforeSeq: 1 }]) {
    await expect(loadNativeHistoryPage(services, 's', cursor, signal())).rejects.toThrow('游标无效')
  }
  expect(services.sessions.page).not.toHaveBeenCalled()
  await expect(loadNativeHistoryPage(services, 's', { sessionId: 's', throughSeq: 99, beforeSeq: 40 }, signal())).rejects.toThrow('未向前推进')
})
it('releases a cold observation when cancelled and does not request a page', async () => {
  const services = fixture({ records: [], hasMore: false }), abort = new AbortController()
  services.sessionQuery.observeSession.mockImplementation(async () => {
    abort.abort()
    return { events: [], [Symbol.dispose]: services.dispose }
  })
  await expect(loadNativeHistoryPage(services, 's', undefined, abort.signal)).rejects.toThrow()
  expect(services.dispose).toHaveBeenCalledOnce()
  expect(services.sessions.page).not.toHaveBeenCalled()
})
