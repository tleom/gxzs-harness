import { randomUUID } from 'node:crypto'

export class HumanInputBridge {
  constructor({ database, timeoutSeconds = 60 }) {
    this.database = database
    this.timeoutSeconds = timeoutSeconds
    this.pendings = new Map()
  }

  handleRequest = async (request, next) => {
    const sessionId = request?.agent?.session?.id ?? request?.agent?.session?.header?.id
    const chat = this.database.getChatBySession(sessionId)
    const run = chat ? this.database.activeRun(chat.ownerId, chat.id) : undefined
    if (!chat || !run) return next()
    const id = randomUUID()
    const deadlineAt = Date.now() + this.timeoutSeconds * 1000
    const payload = pendingPayload(id, request.questions ?? [])
    const pending = { id, ownerId: chat.ownerId, runId: run.id, questions: request.questions ?? [], settled: false }
    const answer = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }))
    this.pendings.set(id, pending)
    this.database.createPendingInput(chat.ownerId, run.id, { requestId: id, payload, deadlineAt })
    this.database.appendEvent(chat.ownerId, run.id, { event: 'workbench_status', status: 'waiting_input' })
    pending.timer = setTimeout(() => this.timeout(chat.ownerId, run.id, id), this.timeoutSeconds * 1000)
    pending.timer.unref?.()
    const abort = () => this.abort(pending)
    request.signal?.addEventListener('abort', abort, { once: true })
    try { return await answer }
    finally { request.signal?.removeEventListener('abort', abort) }
  }

  resume(ownerId, runId, body) {
    const resolved = this.resolve(ownerId, runId, body.request_id)
    if (resolved.stored.status === 'submitted') return resolved.stored
    if (resolved.stored.status !== 'pending') throw Object.assign(new Error('该问题已关闭，请直接发送新消息'), { status: 409 })
    const pending = resolved.pending
    const answer = toAnswer(pending.questions, body)
    this.settle(pending, 'submitted', answer)
    pending.resolve(answer)
    return this.database.getPendingInput(ownerId, runId)
  }

  skip(ownerId, runId, requestId, reason = 'skipped') {
    const resolved = this.resolve(ownerId, runId, requestId)
    if (resolved.stored.status !== 'pending') return resolved.stored
    const pending = resolved.pending
    this.settle(pending, 'skipped')
    if (pending.questions.some((question) => question.intent?.kind === 'plan-review')) {
      pending.reject(cancelledError())
    } else {
      pending.resolve({ answers: pending.questions.map((question) => ({
        id: question.id,
        selected: [],
        custom: `【系统提示，非用户回答】${reason === 'timeout' ? '等待超时，用户未回答，本次补充提问已自动跳过。' : '用户跳过了本次补充提问，未提供回答。'}请根据已有信息自行判断，采用合理假设继续完成任务；必要时简要说明假设。不要因本次未回答而将任务标记为失败，也不要重复询问同一问题。未回答不代表同意任何选项或授予操作权限；确实缺少必要授权或无法推断的关键事实时，继续完成不依赖它的部分，并说明剩余限制。`,
      })) })
    }
    return this.database.getPendingInput(ownerId, runId)
  }

  touch(ownerId, runId, requestId) {
    const resolved = this.resolve(ownerId, runId, requestId)
    const pending = resolved.pending
    if (pending?.timer) { clearTimeout(pending.timer); pending.timer = undefined }
    this.database.touchPendingInput(ownerId, runId, requestId)
    return this.database.getPendingInput(ownerId, runId)
  }

  timeout(ownerId, runId, requestId) {
    const { stored } = this.resolve(ownerId, runId, requestId)
    if (stored.status !== 'pending' || stored.interacted || stored.deadlineAt == null || stored.deadlineAt > Date.now()) return stored
    return this.skip(ownerId, runId, requestId, 'timeout')
  }

  resolve(ownerId, runId, requestId) {
    const stored = this.database.getPendingInput(ownerId, runId)
    if (!stored || stored.requestId !== requestId) throw Object.assign(new Error('问题不存在或已关闭'), { status: 404 })
    if (stored.status !== 'pending') return { stored, pending: undefined }
    const pending = this.pendings.get(requestId)
    if (!pending || pending.ownerId !== ownerId || pending.runId !== runId)
      throw Object.assign(new Error('问题所属进程已退出，请重新发送消息'), { status: 409 })
    return { stored, pending }
  }

  settle(pending, outcome, answer) {
    if (pending.settled) return false
    pending.settled = true
    clearTimeout(pending.timer)
    this.pendings.delete(pending.id)
    this.database.settlePendingInput(pending.ownerId, pending.runId, pending.id, outcome, answer)
    this.database.appendEvent(pending.ownerId, pending.runId, { event: 'workbench_status', status: 'running' })
    return true
  }

  abort(pending) {
    if (pending.settled) return
    pending.settled = true
    clearTimeout(pending.timer)
    this.pendings.delete(pending.id)
    this.database.settlePendingInput(pending.ownerId, pending.runId, pending.id, 'aborted', undefined, Date.now(), { resumeRun: false })
    pending.reject(Object.assign(new Error('ask_user_question was aborted'), { name: 'UserQuestionError', code: 'ASK_ABORTED' }))
  }
}

function pendingPayload(id, questions) {
  const plan = questions.length === 1 && questions[0]?.intent?.kind === 'plan-review'
  if (plan) return {
    request_id: id, tool_call_id: id, tool_name: 'exit_plan_mode',
    args: {
      question: questions[0].question, title: questions[0].header, markdown: questions[0].detail,
      actions: (questions[0].options ?? []).map((option) => ({ id: option.label, label: option.label })),
    },
  }
  return {
    request_id: id,
    tool_call_id: id,
    tool_name: 'ask_user_question',
    args: {
      fields: questions.map((question) => ({
        name: question.id, label: question.question,
        type: question.options?.length ? 'select' : 'paragraph', required: !question.options?.length,
        options: question.options?.map((option) => ({ label: option.label, value: option.label, description: option.description ?? null })),
      })),
    },
  }
}

function toAnswer(questions, body) {
  const values = body.values ?? {}
  return { answers: questions.map((question) => {
    const value = typeof values[question.id] === 'string' ? values[question.id] : ''
    const selected = (question.options ?? []).some((option) => option.label === value) ? [value] : []
    return { id: question.id, selected, ...(value && selected.length === 0 ? { custom: value } : {}) }
  }) }
}

function cancelledError() {
  return Object.assign(new Error('the user cancelled ask_user_question'), { name: 'UserQuestionError', code: 'ASK_CANCELLED' })
}
