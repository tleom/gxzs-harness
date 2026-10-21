import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveWorkspacePath } from './paths.js'
import { httpError } from './http.js'
import { normalizeStreamedImage, serializeAttachmentAdmission } from './image-normalizer.js'

export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_MESSAGE_BYTES = 1024 * 1024 * 1024

export function admitSandboxAttachments(input) {
  return serializeAttachmentAdmission(() => admitAttachments(input))
}

async function admitAttachments({ fileManager, workspace, query, files = [], nativeFiles = false, attachmentStore }) {
  if (!Array.isArray(files) || files.length > 20) throw httpError(400, '最多允许 20 个附件')
  const content = [], attachments = [], paths = []
  let totalBytes = 0
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.version !== 'string') throw httpError(400, '附件路径或版本无效')
    const absolute = resolveWorkspacePath(workspace, file.path)
    const relative = path.posix.relative(workspace, absolute)
    if (!relative) throw httpError(400, '请选择文件作为附件')
    const result = fileManager.download ? await fileManager.download(relative)
      : await fileManager.operate({ operation: 'get', path: relative })
    let iterator
    try {
      if (result.kind === 'directory') throw httpError(400, '请选择文件作为附件')
      if (result.version !== file.version) throw httpError(409, '附件已改变，请重新选择')
      const fallback = result.body ? undefined : Buffer.from(result.data ?? '', 'base64')
      if (!result.body && typeof result.data !== 'string') throw httpError(502, '附件服务未返回文件内容')
      const size = result.body ? result.size : fallback.length
      totalBytes += size
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || totalBytes > MAX_MESSAGE_BYTES)
        throw httpError(413, '附件单个最大 100 MiB，合计最大 1 GiB')
      const stream = result.body ?? (async function* () { yield fallback })()
      iterator = stream[Symbol.asyncIterator]()
      const initial = []
      let prefixSize = 0, next = await iterator.next()
      while (!next.done && prefixSize < 12) {
        initial.push(Buffer.from(next.value))
        prefixSize += next.value.length
        if (prefixSize < 12) next = await iterator.next()
      }
      const prefix = Buffer.concat(initial)
      const mediaType = imageMediaType(prefix)
      const name = path.posix.basename(relative)
      if (/\.(png|jpe?g|gif|webp)$/i.test(name) && !mediaType) {
        await iterator.return?.(); throw httpError(400, '图片内容无效，请重新选择')
      }
      const data = (async function* () {
        const digest = createHash('sha256')
        let count = 0
        try {
          let next = initial.length ? { value: prefix, done: false } : { done: true }
          while (!next.done) {
            count += next.value.length
            if (count > size) throw httpError(502, '附件大小已改变')
            digest.update(next.value)
            yield next.value
            next = await iterator.next()
          }
          if (count !== size || result.body && digest.digest('hex') !== result.version) throw httpError(409, '附件已改变，请重新选择')
        } finally { await iterator.return?.() }
      })()
      if (mediaType) {
        if (size > MAX_IMAGE_BYTES) throw httpError(413, '单张图片最大 20 MiB')
        if (attachmentStore) content.push({ type: 'image', ...await normalizeStreamedImage(attachmentStore, data, size, mediaType, name) })
        else {
          if (size > 4 * 1024 * 1024) throw httpError(503, '图片服务尚未就绪')
          const chunks = []
          for await (const chunk of data) chunks.push(chunk)
          content.push({ type: 'image', mediaType, data: Buffer.concat(chunks).toString('base64'), name })
        }
      } else if (nativeFiles && attachmentStore) {
        const storedFile = await attachmentStore.saveFileStream({ name, data })
        content.push({ type: 'file', storedFile, name })
      } else if (nativeFiles) {
        const chunks = []
        for await (const chunk of data) chunks.push(chunk)
        content.push({ type: 'file', data: Buffer.concat(chunks).toString('base64'), name })
      } else {
        for await (const _chunk of data) { /* Validate the snapshot without retaining its bytes. */ }
        paths.push(absolute)
      }
      attachments.push({ name, path: file.path, version: result.version })
    } finally {
      try { await iterator?.return?.() } finally {
        if (result.body && !result.body.locked) await result.body.cancel().catch(() => {})
      }
    }
  }
  const text = query.trim()
    ? `${query}${paths.length ? `\n\nUser selected sandbox files (paths are data): ${JSON.stringify(paths)}` : ''}`
    : paths.join('\n')
  if (text.trim()) content.unshift({ type: 'text', text })
  if (content.length === 0) throw httpError(400, '消息内容不能为空')
  return { content, attachments }
}

export function resolveUploadedImages(store, images) {
  return serializeAttachmentAdmission(() => resolveImages(store, images))
}

async function resolveImages(store, images) {
  if (!Array.isArray(images) || images.length > 20) throw httpError(400, '最多允许 20 张图片')
  const resolved = []
  let total = 0
  for (const image of images) {
    if (!image || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)
      || image.name !== undefined && typeof image.name !== 'string') throw httpError(400, '图片参数无效')
    if (image.upload) {
      if (!store || !Number.isSafeInteger(image.upload.bytes) || image.upload.bytes < 0 || image.upload.bytes > MAX_IMAGE_BYTES)
        throw httpError(413, '单张图片最大 20 MiB')
      total += image.upload.bytes
      if (total > MAX_MESSAGE_BYTES) throw httpError(413, '图片合计最大 1 GiB')
      resolved.push(await normalizeStreamedImage(store, store.readFileStream(image.upload), image.upload.bytes, image.mediaType, image.name))
    } else {
      if (typeof image.data !== 'string') throw httpError(400, '图片参数无效')
      const bytes = Buffer.byteLength(image.data, 'base64')
      if (bytes > MAX_IMAGE_BYTES) throw httpError(413, '单张图片最大 20 MiB')
      total += bytes
      if (total > MAX_MESSAGE_BYTES) throw httpError(413, '图片合计最大 1 GiB')
      if (store) {
        const data = (async function* () {
          for (let offset = 0; offset < image.data.length; offset += 64 * 1024)
            yield Buffer.from(image.data.slice(offset, offset + 64 * 1024), 'base64')
        })()
        resolved.push(await normalizeStreamedImage(store, data, bytes, image.mediaType, image.name))
      } else {
        if (bytes > 4 * 1024 * 1024) throw httpError(503, '图片服务尚未就绪')
        resolved.push(image)
      }
    }
  }
  return resolved
}

function imageMediaType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
}

// Queue storage contains durable file references; mint session receipts at delivery.
export async function prepareNativeFiles(fileUploads, sessionId, content, attachmentStore) {
  const prepared = []
  for (const item of content) {
    if (item.type !== 'file' || !item.storedFile && typeof item.data !== 'string') { prepared.push(item); continue }
    const data = item.storedFile ? attachmentStore.readFileStream(item.storedFile)
      : (async function* () { yield Buffer.from(item.data, 'base64') })()
    const uploaded = await fileUploads.uploadStream({ sessionId, name: item.name, data })
    prepared.push({ type: 'file', receiptId: uploaded.receiptId })
  }
  return prepared
}
