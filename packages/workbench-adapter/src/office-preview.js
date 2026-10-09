import { httpError } from './http.js'

const extensions = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])
const maxPdfBytes = 20 * 1024 * 1024
// The owner-scoped file manager retains authorization and source identity;
// DSH owns admission, conversion, shared cancellation and cache lifetime.
export async function nativeOfficePreview({ owner, path, fileManager, converter, signal }) {
  if (typeof path !== 'string' || !path || path.length > 1024) throw httpError(400, '文件路径无效')
  const extension = path.split('.').at(-1).toLowerCase()
  if (!extensions.has(extension)) return undefined
  const source = await fileManager.operate({ operation: 'stat', path }, signal)
  if (source.kind === 'missing') throw httpError(404, '文件不存在')
  if (source.size > maxPdfBytes) throw httpError(413, '文档超过 20 MiB，无法在线预览')
  if (source.kind !== 'file' || !source.version || !Number.isSafeInteger(source.size) || source.size < 0)
    throw httpError(400, '该文件无法预览')
  try {
    const result = await converter.convert({ extension, priority: 'foreground', source: {
      key: JSON.stringify([owner.ownerId, path]), version: source.version, bytes: source.size,
      read: async (readSignal, maxBytes) => {
        const file = await fileManager.operate({ operation: 'get', path }, readSignal)
        if (typeof file.data !== 'string' || file.data.length > Math.ceil(maxBytes / 3) * 4) throw httpError(413, '文档超过预览大小限制')
        const bytes = Buffer.from(file.data, 'base64')
        if (bytes.length > maxBytes) throw httpError(413, '文档超过预览大小限制')
        return { bytes, version: file.version }
      },
    } }, signal)
    if (result.pdf.length > maxPdfBytes) throw httpError(413, '预览结果过大，请下载文件查看')
    return result.pdf
  } catch (error) {
    if (error.status || signal?.aborted) throw error
    const statuses = { 'source-changed': 409, busy: 429, timeout: 504, unavailable: 503,
      'input-too-large': 413, 'output-too-large': 413, 'invalid-document': 400 }
    throw httpError(statuses[error.code] ?? 502, error.code === 'source-changed' ? '文件已改变，请重新预览' : '文档转换失败，请稍后重试')
  }
}
