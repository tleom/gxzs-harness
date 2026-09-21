import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanInputBridge } from '../src/human-input.js'
import { WorkbenchDatabase } from '../src/persistence.js'

const opened = []
afterEach(() => opened.splice(0).forEach((database) => database.close()))

function setup(timeoutSeconds = 60) {
  const database = new WorkbenchDatabase(':memory:')
  opened.push(database)
  const chat = database.createChat({ ownerId: 'tenant:user', sessionId: 'session-1', selection: {} })
  const { run } = database.createRun({ ownerId: chat.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
  const bridge = new HumanInputBridge({ database, timeoutSeconds })
  const request = {
    agent: { session: { id: chat.sessionId } },
    questions: [{ id: 'environment', question: '部署到哪里？', options: [{ label: 'staging' }, { label: 'prod' }] }],
    signal: new AbortController().signal,
  }
  return { database, chat, run, bridge, request }
}

describe('durable human input bridge', () => {
  it('ignores early and stale timeout requests after interaction but still permits explicit skip', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    const pending = database.getPendingInput(chat.ownerId, run.id)
    expect(bridge.timeout(chat.ownerId, run.id, pending.requestId).status).toBe('pending')
    bridge.touch(chat.ownerId, run.id, pending.requestId)
    expect(bridge.timeout(chat.ownerId, run.id, pending.requestId)).toMatchObject({ status: 'pending', interacted: true, deadlineAt: null })
    bridge.skip(chat.ownerId, run.id, pending.requestId)
    await expect(waiting).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('expires an untouched question and ignores repeated expiry', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    const pending = database.getPendingInput(chat.ownerId, run.id)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(pending.deadlineAt + 1)
    try {
      expect(bridge.timeout(chat.ownerId, run.id, pending.requestId).status).toBe('skipped')
      expect(bridge.timeout(chat.ownerId, run.id, pending.requestId).status).toBe('skipped')
      await expect(waiting).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    } finally { clock.mockRestore() }
  })
  it('persists waiting state and resumes the in-process question', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    await vi.waitFor(() => expect(database.getRun(chat.ownerId, run.id)?.status).toBe('waiting_input'))
    const pending = database.getPendingInput(chat.ownerId, run.id)
    bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, values: { environment: 'prod' } })
    await expect(waiting).resolves.toEqual({ answers: [{ id: 'environment', selected: ['prod'] }] })
    expect(database.getPendingInput(chat.ownerId, run.id)?.status).toBe('submitted')
    expect(database.getRun(chat.ownerId, run.id)?.status).toBe('running')
  })

  it('makes repeated resume idempotent and rejects resume after skip', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    await vi.waitFor(() => expect(database.getPendingInput(chat.ownerId, run.id)).not.toBeNull())
    const pending = database.getPendingInput(chat.ownerId, run.id)
    bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, values: { environment: 'prod' } })
    await waiting
    expect(() => bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, values: { environment: 'staging' } })).not.toThrow()
    expect(database.getPendingInput(chat.ownerId, run.id)?.answer).toEqual({ answers: [{ id: 'environment', selected: ['prod'] }] })

    const next = setup()
    const skippedWaiting = next.bridge.handleRequest(next.request, vi.fn())
    await vi.waitFor(() => expect(next.database.getPendingInput(next.chat.ownerId, next.run.id)).not.toBeNull())
    const skipped = next.database.getPendingInput(next.chat.ownerId, next.run.id)
    next.bridge.skip(next.chat.ownerId, next.run.id, skipped.requestId)
    await expect(skippedWaiting).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(() => next.bridge.resume(next.chat.ownerId, next.run.id, { request_id: skipped.requestId, values: { environment: 'prod' } }))
      .toThrow('该问题已关闭')
  })

  it('touch removes the authoritative deadline', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    await vi.waitFor(() => expect(database.getPendingInput(chat.ownerId, run.id)).not.toBeNull())
    const pending = database.getPendingInput(chat.ownerId, run.id)
    bridge.touch(chat.ownerId, run.id, pending.requestId)
    expect(database.getPendingInput(chat.ownerId, run.id)).toMatchObject({ interacted: true, deadlineAt: null })
    bridge.skip(chat.ownerId, run.id, pending.requestId)
    await expect(waiting).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })
})
