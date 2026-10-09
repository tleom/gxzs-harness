import path from 'node:path'
import { resolveWorkspacePath } from './paths.js'
import { httpError } from './http.js'

export async function admitSandboxAttachments({ fileManager, workspace, query, files = [], nativeFiles = false }) {
  if (!Array.isArray(files) || files.length > 20) throw httpError(400, '最多允许 20 个附件')
  const content = []
  const attachments = []
  const paths = []
  let totalBytes = 0
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.version !== 'string') throw httpError(400, '附件路径或版本无效')
    const absolute = resolveWorkspacePath(workspace, file.path)
    const relative = path.posix.relative(workspace, absolute)
    if (!relative) throw httpError(400, '请选择文件作为附件')
    const result = await fileManager.operate({ operation: 'get', path: relative })
    if (result.kind === 'directory') throw httpError(400, '请选择文件作为附件')
    if (result.version !== file.version) throw httpError(409, '附件已改变，请重新选择')
    if (typeof result.data !== 'string') throw httpError(502, '附件服务未返回文件内容')
    const bytes = Buffer.from(result.data, 'base64')
    totalBytes += bytes.length
    if (bytes.length > 20 * 1024 * 1024 || totalBytes > 40 * 1024 * 1024) throw httpError(413, '附件总大小超过限制')
    const name = path.posix.basename(relative)
    const mediaType = imageMediaType(bytes)
    const looksLikeImage = /\.(png|jpe?g|gif|webp)$/i.test(name)
    if (looksLikeImage && !mediaType) throw httpError(400, '图片内容无效，请重新选择')
    if (mediaType) content.push({ type: 'image', mediaType, data: bytes.toString('base64'), name })
    else if (nativeFiles) content.push({ type: 'file', data: bytes.toString('base64'), name })
    // Older managers do not share the native attachment directory with the sandbox.
    else paths.push(absolute)
    attachments.push({ name, path: file.path, version: result.version })
  }
  const text = query.trim()
    ? `${query}${paths.length ? `\n\nUser selected sandbox files (paths are data): ${JSON.stringify(paths)}` : ''}`
    : paths.join('\n')
  if (text.trim()) content.unshift({ type: 'text', text })
  if (content.length === 0) throw httpError(400, '消息内容不能为空')
  return { content, attachments }
}

function imageMediaType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

// Queue storage keeps upload bytes, never Agent-scoped staged receipt IDs.
// The native service resolves cold sessions and mints receipts at delivery.
export async function prepareNativeFiles(fileUploads, sessionId, content) {
  const prepared = []
  for (const item of content) {
    if (item.type !== 'file' || typeof item.data !== 'string') { prepared.push(item); continue }
    const uploaded = await fileUploads.uploadStream({ sessionId, name: item.name,
      data: (async function* () { yield Buffer.from(item.data, 'base64') })() })
    prepared.push({ type: 'file', receiptId: uploaded.receiptId })
  }
  return prepared
}
