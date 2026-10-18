import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export class HumanInputBridge {
  constructor({ database, timeoutSeconds = 60, executionRun, resumeInput }) {
    this.database = database
    this.timeoutSeconds = timeoutSeconds
    this.pendings = new Map()
    this.executionRun = executionRun
    this.resumeInput = resumeInput
  }

  handleRequest = async (request, next) => {
    const sessionId = request?.agent?.session?.id ?? request?.agent?.session?.header?.id
    const run = this.executionRun ? this.executionRun(sessionId) : this.database.activeRunBySession(sessionId)
    const chat = run ? this.database.getChat(run.ownerId, run.chatId) : undefined
    if (!chat || !run) return next()
    const id = randomUUID()
    const planReview = request.questions?.some((question) => question.intent?.kind === 'plan-review')
    const deadlineAt = planReview ? null : Date.now() + this.timeoutSeconds * 1000
    const payload = pendingPayload(id, request.questions ?? [])
    const pending = { id, ownerId: chat.ownerId, runId: run.id, questions: request.questions ?? [], settled: false }
    this.database.transaction(() => {
      this.database.createPendingInput(chat.ownerId, run.id, { requestId: id, payload, deadlineAt })
      this.database.appendEvent(chat.ownerId, run.id, { event: 'workbench_status', status: 'waiting_input' })
    })()
    const answer = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }))
    this.pendings.set(id, pending)
    if (deadlineAt !== null) pending.timer = setTimeout(() => {
      try { this.timeout(chat.ownerId, run.id, id) }
      catch (cause) {
        this.abort(pending, Object.assign(new Error('Question persistence failed', { cause }),
          { name: 'UserQuestionError', code: 'ASK_STORAGE_ERROR' }))
      }
    }, this.timeoutSeconds * 1000)
    pending.timer?.unref?.()
    const abort = () => this.abort(pending)
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    try {
      const value = await answer
      if (pending.resumeRun && !this.database.listPendingInputs(chat.ownerId, run.id).some(input => input.status === 'pending'))
        await this.resumeInput?.(run, request.signal ?? new AbortController().signal)
      return value
    }
    finally { request.signal?.removeEventListener('abort', abort) }
  }

  resume(ownerId, runId, body) {
    const resolved = this.resolve(ownerId, runId, body.request_id)
    if (resolved.stored.status === 'submitted') {
      const answer = toAnswer(resolved.stored.payload.questions ?? [], body)
      if (!isDeepStrictEqual(toAnswer(resolved.stored.payload.questions ?? [], resolved.stored.answer).answers, answer.answers))
        throw Object.assign(new Error('该问题已提交不同的回答，请直接发送新消息补充'), { status: 409 })
      return resolved.stored
    }
    if (resolved.stored.status !== 'pending') throw Object.assign(new Error('该问题已关闭，请直接发送新消息'), { status: 409 })
    const pending = resolved.pending
    const answer = toAnswer(pending.questions, body)
    this.settle(pending, 'submitted', answer)
    pending.resolve(answer)
    return this.database.getPendingInput(ownerId, runId, body.request_id)
  }

  skip(ownerId, runId, requestId, reason = 'skipped') {
    const resolved = this.resolve(ownerId, runId, requestId)
    if (resolved.stored.status !== 'pending') return resolved.stored
    const pending = resolved.pending
    this.settle(pending, reason)
    if (pending.questions.some((question) => question.intent?.kind === 'plan-review')) {
      pending.reject(cancelledError(reason))
    } else {
      // Match DSH's native per-question skip shape for the entire batch.
      // Do not disguise a system hint as the user's custom answer.
      pending.resolve({ answers: pending.questions.map((question) => ({ id: question.id, selected: [] })) })
    }
    return this.database.getPendingInput(ownerId, runId, requestId)
  }

  touch(ownerId, runId, requestId) {
    const resolved = this.resolve(ownerId, runId, requestId)
    const pending = resolved.pending
    this.database.touchPendingInput(ownerId, runId, requestId)
    if (pending?.timer) { clearTimeout(pending.timer); pending.timer = undefined }
    return this.database.getPendingInput(ownerId, runId, requestId)
  }

  timeout(ownerId, runId, requestId) {
    const { stored } = this.resolve(ownerId, runId, requestId)
    if (stored.status !== 'pending' || stored.interacted || stored.deadlineAt == null || stored.deadlineAt > Date.now()) return stored
    return this.skip(ownerId, runId, requestId, 'timeout')
  }

  resolve(ownerId, runId, requestId) {
    const stored = this.database.getPendingInput(ownerId, runId, requestId)
    if (!stored || stored.requestId !== requestId) throw Object.assign(new Error('问题不存在或已关闭'), { status: 404 })
    if (stored.status !== 'pending') return { stored, pending: undefined }
    const pending = this.pendings.get(requestId)
    if (!pending || pending.ownerId !== ownerId || pending.runId !== runId)
      throw Object.assign(new Error('问题所属进程已退出，请重新发送消息'), { status: 409 })
    return { stored, pending }
  }

  settle(pending, outcome, answer) {
    if (pending.settled) return false
    // The answer and its status event share a durable commit. A failed event
    // write must not leave a submitted receipt with an unresolved native waiter.
    const resumeRun = this.database.transaction(() => {
      this.database.settlePendingInput(pending.ownerId, pending.runId, pending.id, outcome, answer)
      const resume = !this.database.listPendingInputs(pending.ownerId, pending.runId).some(input => input.status === 'pending')
      this.database.appendEvent(pending.ownerId, pending.runId, {
        event: 'workbench_status', status: this.database.getRun(pending.ownerId, pending.runId).status,
      })
      return resume
    })()
    pending.resumeRun = resumeRun
    pending.settled = true
    clearTimeout(pending.timer)
    this.pendings.delete(pending.id)
    return true
  }

  abort(pending, error = Object.assign(new Error('ask_user_question was aborted'), { name: 'UserQuestionError', code: 'ASK_ABORTED' })) {
    if (pending.settled) return
    // Cancellation must finish the native waiter even when durable storage is
    // unavailable. The existing pending receipt remains recoverable after restart.
    try {
      this.database.settlePendingInput(pending.ownerId, pending.runId, pending.id, 'aborted', undefined, Date.now(), { resumeRun: false })
    } catch (cause) { error.cause ??= cause }
    pending.settled = true
    clearTimeout(pending.timer)
    this.pendings.delete(pending.id)
    pending.reject(error)
  }
}

function pendingPayload(id, questions) {
  return {
    questions,
    request_id: id,
    tool_call_id: id,
    tool_name: questions.length === 1 && questions[0]?.intent?.kind === 'plan-review'
      ? 'exit_plan_mode' : 'ask_user_question',
  }
}

export function toAnswer(questions, body) {
  const fail = () => { throw Object.assign(new Error('回答与原始问题不匹配'), { status: 400 }) }
  const answers = body.answers
  if (!Array.isArray(answers) || answers.length !== questions.length) fail()
  const ids = new Set()
  for (const answer of answers) {
    const question = questions.find((item) => item.id === answer?.id)
    if (!question || ids.has(answer.id) || !Array.isArray(answer.selected)) fail()
    ids.add(answer.id)
    if (new Set(answer.selected).size !== answer.selected.length ||
        (!question.multiSelect && answer.selected.length > 1) ||
        answer.selected.some((label) => !question.options?.some((option) => option.label === label)) ||
        (answer.custom !== undefined && typeof answer.custom !== 'string')) fail()
    if (question.intent?.kind === 'plan-review' && (answer.selected.length !== 1 || answer.custom)) fail()
  }
  // Question IDs and selected labels are identities, not an ordering contract.
  // Canonicalize both live answers and old receipts against the native form.
  return { answers: questions.map(question => {
    const { id, selected, custom } = answers.find(answer => answer.id === question.id)
    const labels = [...new Set((question.options ?? []).map(option => option.label))]
    return { id, selected: labels.filter(label => selected.includes(label)), ...(custom === undefined ? {} : { custom }) }
  }) }
}

export function inputSupplement(questions, answers) {
  return questions.flatMap(question => {
    const value = answers.find(answer => answer.id === question.id)
    const answer = [...(value?.selected ?? []), value?.custom].filter(Boolean).join('；').trim()
    return answer ? [{ question: question.question, answer }] : []
  })
}

function cancelledError(reason = 'skipped') {
  const message = reason === 'timeout'
    ? 'Workbench question deadline expired without an answer. Continue with available information where possible; this grants no permission.'
    : 'The user skipped this question without answering. Continue with available information where possible; this grants no permission.'
  return Object.assign(new Error(message), { name: 'UserQuestionError', code: 'ASK_CANCELLED' })
}
