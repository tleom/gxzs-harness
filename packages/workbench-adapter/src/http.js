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
  sendJson(res, Number(error?.status) || 500, { message: error?.message || '工作台请求失败，请稍后重试' })
}

export function encodeSse(entry) {
  const lines = []
  if (entry._id) lines.push(`id: ${entry._id}`)
  for (const line of JSON.stringify(entry).split('\n')) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }) }
