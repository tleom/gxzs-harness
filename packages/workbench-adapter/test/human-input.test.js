import { afterEach, describe, expect, it, vi } from 'vitest'
import { HumanInputBridge, toAnswer } from '../src/human-input.js'
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
  it('treats reordered questions and multi-select labels as the same answer on retry', async () => {
    const { database, chat, run, bridge, request } = setup()
    request.questions.push({ id: 'format', question: '格式', multiSelect: true, options: [{ label: 'Word' }, { label: 'PDF' }] })
    const waiting = bridge.handleRequest(request, vi.fn())
    const request_id = database.getPendingInput(chat.ownerId, run.id).requestId
    const answers = [{ id: 'environment', selected: ['prod'] }, { id: 'format', selected: ['Word', 'PDF'] }]
    bridge.resume(chat.ownerId, run.id, { request_id, answers })
    const reversed = [{ id: 'format', selected: ['PDF', 'Word'] }, answers[0]]
    expect(bridge.resume(chat.ownerId, run.id, { request_id, answers: reversed }).answer.answers).toEqual(answers)
    // Persisted receipts from the previous release can have arbitrary order too.
    database.db.prepare('UPDATE pending_inputs SET answer_json=? WHERE request_id=?').run(JSON.stringify({ answers: reversed }), request_id)
    expect(() => bridge.resume(chat.ownerId, run.id, { request_id, answers })).not.toThrow()
    await expect(waiting).resolves.toEqual({ answers })
  })

  it.each([false, true])('reacquires admission once after all overlapping questions settle (same tick: %s)', async sameTick => {
    const { database, chat, run, bridge, request } = setup()
    bridge.resumeInput = vi.fn(async () => {})
    const first = bridge.handleRequest(request, vi.fn())
    const firstId = database.getPendingInput(chat.ownerId, run.id).requestId
    const second = bridge.handleRequest({ ...request, questions: [{ id: 'format', question: '格式' }] }, vi.fn())
    const secondId = database.getPendingInput(chat.ownerId, run.id).requestId
    bridge.skip(chat.ownerId, run.id, firstId)
    if (!sameTick) {
      await first
      expect(bridge.resumeInput).not.toHaveBeenCalled()
    }
    bridge.skip(chat.ownerId, run.id, secondId)
    await Promise.all([first, second])
    expect(bridge.resumeInput).toHaveBeenCalledOnce()
  })

  it('deduplicates identical answers but rejects a changed answer from an older form', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    const body = { request_id: database.getPendingInput(chat.ownerId, run.id).requestId,
      answers: [{ id: 'environment', selected: ['staging'] }] }
    bridge.resume(chat.ownerId, run.id, body)
    expect(bridge.resume(chat.ownerId, run.id, body).answer.answers).toEqual(body.answers)
    expect(() => bridge.resume(chat.ownerId, run.id, { ...body,
      answers: [{ id: 'environment', selected: ['prod'] }],
    })).toThrow('该问题已提交不同的回答')
    await expect(waiting).resolves.toEqual({ answers: body.answers })
  })
  it('settles concurrent questions by their own request IDs and keeps the remaining question pending', async () => {
    const { database, chat, run, bridge, request } = setup()
    const first = bridge.handleRequest(request, vi.fn())
    const firstId = database.getPendingInput(chat.ownerId, run.id).requestId
    const second = bridge.handleRequest({ ...request, questions: [{ id: 'format', question: '格式？' }] }, vi.fn())
    const secondId = database.getPendingInput(chat.ownerId, run.id).requestId
    bridge.skip(chat.ownerId, run.id, secondId)
    await expect(second).resolves.toEqual({ answers: [{ id: 'format', selected: [] }] })
    expect(database.getRun(chat.ownerId, run.id).status).toBe('waiting_input')
    expect(database.getPendingInput(chat.ownerId, run.id).requestId).toBe(firstId)
    bridge.skip(chat.ownerId, run.id, firstId)
    await expect(first).resolves.toEqual({ answers: [{ id: 'environment', selected: [] }] })
    expect(database.getRun(chat.ownerId, run.id).status).toBe('running')
    expect(bridge.pendings.size).toBe(0)
  })

  it('expires overlapping questions without an uncaught timer error or approving either question', async () => {
    vi.useFakeTimers()
    try {
      const { database, chat, run, bridge, request } = setup()
      const first = bridge.handleRequest(request, vi.fn())
      const second = bridge.handleRequest({ ...request, questions: [{ id: 'format', question: '格式？' }] }, vi.fn())
      await vi.advanceTimersByTimeAsync(60_000)
      await expect(first).resolves.toEqual({ answers: [{ id: 'environment', selected: [] }] })
      await expect(second).resolves.toEqual({ answers: [{ id: 'format', selected: [] }] })
      expect(database.listPendingInputs(chat.ownerId, run.id).map(input => input.status)).toEqual(['timeout', 'timeout'])
      expect(bridge.pendings.size).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('rejects obsolete field/action answers without settling the native question', async () => {
    const { database, chat, run, bridge, request } = setup()
    expect(() => toAnswer(request.questions, { values: { environment: 'prod' }, action: 'submit' })).toThrow('回答与原始问题不匹配')
    const waiting = bridge.handleRequest(request, vi.fn())
    const pending = database.getPendingInput(chat.ownerId, run.id)
    expect(pending.payload).not.toHaveProperty('args')
    expect(() => bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, values: { environment: 'prod' } })).toThrow()
    expect(database.getPendingInput(chat.ownerId, run.id).status).toBe('pending')
    bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, answers: [{ id: 'environment', selected: ['prod'] }] })
    await expect(waiting).resolves.toEqual({ answers: [{ id: 'environment', selected: ['prod'] }] })
  })
  it('keeps native plan review pending without a Workbench deadline', async () => {
    vi.useFakeTimers()
    try {
      const { database, chat, run, bridge, request } = setup()
      request.questions[0].intent = { kind: 'plan-review', approve: 'prod' }
      const waiting = bridge.handleRequest(request, vi.fn())
      await vi.advanceTimersByTimeAsync(120_000)
      const pending = database.getPendingInput(chat.ownerId, run.id)
      expect(pending).toMatchObject({ status: 'pending', deadlineAt: null })
      expect(bridge.timeout(chat.ownerId, run.id, pending.requestId).status).toBe('pending')
      bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, answers: [{ id: 'environment', selected: ['prod'] }] })
      await expect(waiting).resolves.toEqual({ answers: [{ id: 'environment', selected: ['prod'] }] })
    } finally { vi.useRealTimers() }
  })
  it('ignores early and stale timeout requests after interaction but still permits explicit skip', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    const pending = database.getPendingInput(chat.ownerId, run.id)
    expect(bridge.timeout(chat.ownerId, run.id, pending.requestId).status).toBe('pending')
    bridge.touch(chat.ownerId, run.id, pending.requestId)
    expect(bridge.timeout(chat.ownerId, run.id, pending.requestId)).toMatchObject({ status: 'pending', interacted: true, deadlineAt: null })
    bridge.skip(chat.ownerId, run.id, pending.requestId)
    await expect(waiting).resolves.toEqual({ answers: [{ id: 'environment', selected: [] }] })
  })

  it('expires an untouched question and ignores repeated expiry', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    const pending = database.getPendingInput(chat.ownerId, run.id)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(pending.deadlineAt + 1)
    try {
      expect(bridge.timeout(chat.ownerId, run.id, pending.requestId).status).toBe('timeout')
      expect(bridge.timeout(chat.ownerId, run.id, pending.requestId).status).toBe('timeout')
      await expect(waiting).resolves.toEqual({ answers: [{ id: 'environment', selected: [] }] })
      expect(database.getRun(chat.ownerId, run.id).status).toBe('running')
      expect(database.getPendingInput(chat.ownerId, run.id).answer).toBeNull()
    } finally { clock.mockRestore() }
  })
  it('automatically resumes at 60 seconds without a browser timeout request', async () => {
    vi.useFakeTimers()
    try {
      const { database, chat, run, bridge, request } = setup()
      request.questions.push({ id: 'format', question: '什么格式？' })
      const waiting = bridge.handleRequest(request, vi.fn())
      const cancelled = expect(waiting).resolves.toEqual({ answers: [
        { id: 'environment', selected: [] }, { id: 'format', selected: [] },
      ] })
      await vi.advanceTimersByTimeAsync(59_999)
      expect(database.getPendingInput(chat.ownerId, run.id).status).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      await cancelled
      expect(database.getPendingInput(chat.ownerId, run.id)).toMatchObject({ status: 'timeout', answer: null })
      expect(database.getRun(chat.ownerId, run.id).status).toBe('running')
      expect(bridge.pendings.size).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('keeps actual cancellation distinct and never approves an unanswered plan', async () => {
    const { database, chat, run, bridge, request } = setup()
    request.questions[0].intent = { kind: 'plan-review', approve: 'prod' }
    const waiting = bridge.handleRequest(request, vi.fn())
    bridge.skip(chat.ownerId, run.id, database.getPendingInput(chat.ownerId, run.id).requestId)
    await expect(waiting).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    const other = setup()
    const controller = new AbortController()
    const aborted = other.bridge.handleRequest({ ...other.request, signal: controller.signal }, vi.fn())
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  })

  it('persists waiting state and resumes the in-process question', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    await vi.waitFor(() => expect(database.getRun(chat.ownerId, run.id)?.status).toBe('waiting_input'))
    const pending = database.getPendingInput(chat.ownerId, run.id)
    bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, answers: [{ id: 'environment', selected: ['prod'] }] })
    await expect(waiting).resolves.toEqual({ answers: [{ id: 'environment', selected: ['prod'] }] })
    expect(database.getPendingInput(chat.ownerId, run.id)?.status).toBe('submitted')
    expect(database.getRun(chat.ownerId, run.id)?.status).toBe('running')
  })

  it('makes repeated resume idempotent and rejects resume after skip', async () => {
    const { database, chat, run, bridge, request } = setup()
    const waiting = bridge.handleRequest(request, vi.fn())
    await vi.waitFor(() => expect(database.getPendingInput(chat.ownerId, run.id)).not.toBeNull())
    const pending = database.getPendingInput(chat.ownerId, run.id)
    bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, answers: [{ id: 'environment', selected: ['prod'] }] })
    await waiting
    expect(() => bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, answers: [{ id: 'environment', selected: ['prod'] }] })).not.toThrow()
    expect(database.getPendingInput(chat.ownerId, run.id)?.answer).toEqual({ answers: [{ id: 'environment', selected: ['prod'] }] })

    const next = setup()
    const skippedWaiting = next.bridge.handleRequest(next.request, vi.fn())
    await vi.waitFor(() => expect(next.database.getPendingInput(next.chat.ownerId, next.run.id)).not.toBeNull())
    const skipped = next.database.getPendingInput(next.chat.ownerId, next.run.id)
    next.bridge.skip(next.chat.ownerId, next.run.id, skipped.requestId)
    await expect(skippedWaiting).resolves.toEqual({ answers: [{ id: 'environment', selected: [] }] })
    expect(() => next.bridge.resume(next.chat.ownerId, next.run.id, { request_id: skipped.requestId, answers: [{ id: 'environment', selected: ['prod'] }] }))
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
    await expect(waiting).resolves.toEqual({ answers: [{ id: 'environment', selected: [] }] })
  })
})

 it('preserves native question fields and accepts native multi-select answers', async () => {
   const { bridge, request, database, chat, run } = setup()
   request.questions[0].multiSelect = true
   request.questions[0].detail = 'deployment details'
   const waiting = bridge.handleRequest(request, vi.fn())
   const pending = database.getPendingInput(chat.ownerId, run.id)
   expect(pending.payload.questions).toEqual(request.questions)
   const answers = [{ id: 'environment', selected: ['staging', 'prod'], custom: 'both' }]
   bridge.resume(chat.ownerId, run.id, { request_id: pending.requestId, answers })
   await expect(waiting).resolves.toEqual({ answers })
 })
 it('validates plan labels before resolving and preserves native approval semantics', async () => {
   const { bridge, request, database, chat, run } = setup()
   request.questions[0].intent = { kind: 'plan-review', approve: 'prod' }
   const waiting = bridge.handleRequest(request, vi.fn())
   const request_id = database.getPendingInput(chat.ownerId, run.id).requestId
   expect(() => bridge.resume(chat.ownerId, run.id, { request_id, answers: [{ id: 'environment', selected: ['invented'] }] })).toThrow()
   bridge.resume(chat.ownerId, run.id, { request_id, answers: [{ id: 'environment', selected: ['prod'] }] })
   await expect(waiting).resolves.toEqual({ answers: [{ id: 'environment', selected: ['prod'] }] })
 })
 it('handles a signal aborted before registration without leaving a pending timer', async () => {
   const { bridge, request, database, chat, run } = setup()
   await expect(bridge.handleRequest({ ...request, signal: AbortSignal.abort() }, vi.fn())).rejects.toMatchObject({ code: 'ASK_ABORTED' })
   expect(bridge.pendings.size).toBe(0)
   expect(database.getPendingInput(chat.ownerId, run.id).status).toBe('aborted')
 })

it('binds the native call identity and resolves skip without recording an answer', async () => {
  const { database, chat, run, bridge, request } = setup()
  database.startToolCall(chat.ownerId, run.id, 'native-call', 'ask_user_question')
  const waiting = bridge.handleRequest(request, vi.fn())
  const pending = database.getPendingInput(chat.ownerId, run.id)
  expect(pending.payload.tool_call_id).toBe('native-call')
  bridge.skip(chat.ownerId, run.id, pending.requestId)
  const result = await waiting
  expect(result.answers[0]).toMatchObject({ id: 'environment', selected: [] })
  expect(result.answers[0]).not.toHaveProperty('custom')
  expect(database.getPendingInput(chat.ownerId, run.id)).toMatchObject({ status: 'skipped', answer: null })
  expect(database.getRun(chat.ownerId, run.id).status).toBe('running')
})
