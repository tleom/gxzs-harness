export const MAX_JSON_BYTES = 32 * 1024 * 1024

export async function readBody(req, limit = MAX_JSON_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
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
  const remote = error?.isDSHRemoteError === true && Object.hasOwn(REMOTE_ERRORS, error.code) ? REMOTE_ERRORS[error.code] : undefined
  const explicitStatus = Number(error?.status)
  const status = remote?.[0] ?? (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599 ? explicitStatus : 500)
  // Native diagnostic details can contain host paths and configuration. Only
  // publish reviewed domain failures; leave unexpected failures in host logs.
  const code = remote ? error.code : status !== 500 && typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_/-]{0,99}$/.test(error.code)
    ? error.code : (STATUS_CODES[status] ?? 'REQUEST_FAILED')
  const message = remote?.[1] ?? (status === 500 ? '工作台请求失败，请稍后重试' : error?.message || '工作台请求失败，请稍后重试')
  sendJson(res, status, { code, message })
}

const STATUS_CODES = { 400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'STATE_CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR', 502: 'UPSTREAM_ERROR', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' }
const REMOTE_ERRORS = {
  'gateway/bad-request': [400, '请求参数无效'],
  'gateway/cancelled': [409, '请求已取消，请刷新当前状态'],
  'session/not-found': [404, '会话不存在或已被删除'],
  'subagent/not-found': [404, '子任务不存在'],
  'session/conflict': [409, '会话配置已改变，请刷新后重试'],
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

export function encodeSse(entry) {
  const lines = []
  if (entry._id) lines.push(`id: ${entry._id}`)
  for (const line of JSON.stringify(entry).split('\n')) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}

export function httpError(status, message, code = STATUS_CODES[status] ?? 'REQUEST_FAILED') { return Object.assign(new Error(message), { status, code }) }
