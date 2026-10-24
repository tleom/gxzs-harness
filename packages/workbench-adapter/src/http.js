export const MAX_JSON_BYTES = 32 * 1024 * 1024

/** Bind upstream work to the connection; mutations must also settle their outcome. */
export async function withResponseSignal(res, operation) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  res.once('close', cancel)
  if (res.destroyed) cancel()
  try {
    controller.signal.throwIfAborted()
    return await operation(controller.signal)
  } finally { res.off('close', cancel) }
}

export async function readBody(req, limit = MAX_JSON_BYTES, expand) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit && expand) {
      limit = Math.max(limit, await expand())
      expand = undefined
    }
    if (size > limit) throw httpError(413, '请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export function parseJson(body) {
  if (body.length === 0) return {}
  try { return JSON.parse(body.toString('utf8')) }
  catch { throw httpError(400, '请求体不是合法 JSON') }
}

export function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function sendError(res, error) {
  const { status, body } = errorResponse(error)
  sendJson(res, status, body)
}

export function errorResponse(error) {
  if (error?.name === 'ScheduleInputError') {
    const message = { invalid_prompt: '请填写有效的任务名称和内容', not_future: '运行时间必须在未来',
      invalid_time_zone: '请选择有效的时区', invalid_rule: '定时规则无效', invalid_selector: '请选择一种运行规则',
      frequency_too_high: '重复间隔至少为一分钟', time_out_of_range: '运行时间超出支持范围', subagent_session: '请在主对话中创建定时任务' }[error.code]
    if (message) return { status: 400, body: { code: error.code, message } }
  }
  if (Object.hasOwn(GOAL_ERRORS, error?.code ?? '')) {
    const [status, message] = GOAL_ERRORS[error.code]
    return { status, body: { code: error.code, message } }
  }
  const remote = nativeError(error)
  const explicitStatus = Number(error?.status)
  const status = remote?.status ?? (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599 ? explicitStatus : 500)
  // Native diagnostic details can contain host paths and configuration. Only
  // publish reviewed domain failures; leave unexpected failures in host logs.
  const code = remote ? error.code : status !== 500 && typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_/-]{0,99}$/.test(error.code)
    ? error.code : (STATUS_CODES[status] ?? 'REQUEST_FAILED')
  const message = remote?.message ?? (status === 500 ? '工作台请求失败，请稍后重试' : error?.message || '工作台请求失败，请稍后重试')
  const metadata = {}
  if (typeof error?.request_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(error.request_id)) metadata.request_id = error.request_id
  if (Number.isInteger(error?.retry_after) && error.retry_after >= 0 && error.retry_after <= 60) metadata.retry_after = error.retry_after
  return { status, body: { code, message, ...metadata } }
}

const GOAL_ERRORS = {
  GOAL_INVALID_TRANSITION: [409, '当前目标状态不支持此操作；若轮次已耗尽，请先提高轮次上限'],
  GOAL_STALE_REF: [409, '目标已改变，请刷新后重试'],
  GOAL_INVALID_EDIT: [400, '请填写目标内容或有效的轮次上限'],
  GOAL_INVALID_OBJECTIVE: [400, '目标内容不能为空'],
  GOAL_INVALID_MAX_ROUNDS: [400, '目标轮次上限必须为正整数'],
}

const STATUS_CODES = { 400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'STATE_CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 502: 'UPSTREAM_ERROR', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' }
const REMOTE_ERRORS = {
  'job/not-found': [404, '后台任务不存在或不属于此对话'],
  'terminal/unavailable': [404, '终端已关闭或当前不可用'],
  'terminal/control-unavailable': [409, '当前终端不能接受输入，请重新连接'],
  'terminal/limit-reached': [409, '当前会话无法继续创建终端'],
  'gateway/bad-request': [400, '请求参数无效'],
  'gateway/cancelled': [409, '请求已取消，请刷新当前状态'],
  'session/not-found': [404, '会话不存在或已被删除'],
  'subagent/not-found': [404, '子任务不存在'],
  'subagent/parent-unavailable': [409, '父会话当前不可用，无法发送后续消息'],
  'subagent/not-resumable': [409, '此子智能体不支持后续消息'],
  'subagent/unauthorized': [404, '子智能体不属于此对话'],
  'subagent/delivery-unavailable': [409, '子智能体当前无法接收消息，请稍后重试'],
  'subagent/invalid-time-zone': [400, '时区参数无效'],
  'subagent/attachment-invalid': [400, '图片无效或所选模型不支持图片'],
  'session/conflict': [409, '会话配置已改变，请刷新后重试'],
  'settings/conflict': [409, '设置已在其他位置更新，请放弃修改后重试'],
  'settings/rejected': [400, '设置未被接受，请检查填写的值'],
  'session/writer-held': [409, '会话正在被其他执行器使用，请稍后重试'],
  'session/agent-busy': [409, '会话正在执行其他任务，请刷新当前状态'],
  'agent-preset/conflict': [409, '会话预设已改变，请刷新后重试'],
  'session/model-unavailable': [409, '所选模型当前不可用，请重新选择'],
  'session/queue-item-not-found': [409, '排队消息已被处理，请刷新当前状态'],
  'session/steer-unavailable': [409, '当前任务已不能接受插话，排队消息已保留'],
  'session/fork-unavailable': [409, '当前会话暂不能分叉，请刷新后重试'],
  'session/invalid-time-zone': [400, '时区参数无效'],
  'session/attachment-invalid': [400, '附件参数无效'],
  'session/title-invalid': [400, '会话标题无效'],
  'workspace/invalid-path': [400, '所选目录无法用作工作区'],
  'workspace/name-conflict': [409, '已存在同名工作区'],
  'workspace/session-active': [409, '会话仍有运行中的任务，请先停止任务'],
  'workspace/move-invalid': [409, '会话顺序已改变，请刷新工作区'],
}

// HTTP and queued admission share the same reviewed native failure projection.
export function nativeError(error) {
  if (error?.isDSHRemoteError !== true || !Object.hasOwn(REMOTE_ERRORS, error.code)) return undefined
  const [status, fallback] = REMOTE_ERRORS[error.code]
  const reason = error.code === 'session/attachment-invalid' ? error.details?.reason : undefined
  const messages = {
    MODEL_DOES_NOT_SUPPORT_IMAGES: '所选模型不支持图片输入，请选择支持图片的模型后重新发送',
    FILE_NOT_STAGED: '附件上传凭据已失效，请重新上传后发送',
  }
  return { status, code: error.code, message: Object.hasOwn(messages, reason ?? '') ? messages[reason] : fallback }
}

export function encodeSse(entry) {
  const lines = []
  if (entry._id) lines.push(`id: ${entry._id}`)
  for (const line of JSON.stringify(entry).split('\n')) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}

export function httpError(status, message, code = STATUS_CODES[status] ?? 'REQUEST_FAILED') { return Object.assign(new Error(message), { status, code }) }
