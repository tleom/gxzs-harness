import { createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { httpError } from './http.js'

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 + 128 * 1024

// The assertion is authenticated before reading, and its digest is checked
// before any sandbox mutation. Only bounded chunks are retained in memory.
export async function spoolUpload(request, verifyBody, signal) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/octet-stream') throw httpError(415, '文件上传需要二进制请求')
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_UPLOAD_BYTES))
    throw httpError(413, '单个文件或技能包最大 100 MiB')
  const directory = await mkdtemp(join(tmpdir(), 'gxzs-upload-'))
  const path = join(directory, 'body')
  const dispose = () => rm(directory, { recursive: true, force: true })
  let file
  let size = 0, completed = false
  const digest = createHash('sha256')
  try {
    file = await open(path, 'wx+', 0o600)
    for await (const chunk of request) {
      signal?.throwIfAborted()
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) throw httpError(413, '单个文件或技能包最大 100 MiB')
      digest.update(chunk)
      await file.writeFile(chunk)
    }
    signal?.throwIfAborted()
    if (declared !== undefined && size !== Number(declared)) throw httpError(400, '文件上传不完整')
    verifyBody(digest.digest('hex'))
    const headerBuffer = Buffer.alloc(Math.min(size, 128 * 1024))
    const { bytesRead } = await file.read(headerBuffer, 0, headerBuffer.length, 0)
    const newline = headerBuffer.subarray(0, bytesRead).indexOf(10)
    if (newline < 0) throw httpError(400, '文件上传元数据无效')
    let metadata
    try { metadata = JSON.parse(headerBuffer.subarray(0, newline).toString('utf8')) }
    catch { throw httpError(400, '文件上传元数据无效') }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw httpError(400, '文件上传元数据无效')
    if (size - newline - 1 > 100 * 1024 * 1024) throw httpError(413, '单个文件或技能包最大 100 MiB')
    completed = true
    return { path, size, metadata, offset: newline + 1, dispose }
  } finally {
    await file?.close()
    if (!completed) await dispose()
  }
}
