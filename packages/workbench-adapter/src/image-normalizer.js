import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { httpError } from './http.js'

const nativeRequire = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
let previous = Promise.resolve()
let sharp

// Encoded sources stay on disk. Serialize full raster work across all chats so
// concurrent submissions cannot multiply the 64-million-pixel decode budget.
export function serializeAttachmentAdmission(run) {
  const result = previous.then(run, run)
  previous = result.then(() => {}, () => {})
  return result
}

export async function normalizeStreamedImage(store, data, size, mediaType, name) {
  const directory = await mkdtemp(join(tmpdir(), 'gxzs-image-'))
  try {
    const source = join(directory, 'source')
    let count = 0
    const bounded = new Transform({ transform(chunk, _encoding, callback) {
      count += chunk.length
      callback(count > size || count > 20 * 1024 * 1024 ? httpError(413, '单张图片最大 20 MiB') : null, chunk)
    } })
    await pipeline(Readable.from(data), bounded, createWriteStream(source, { flags: 'wx', mode: 0o600 }))
    if (count !== size) throw httpError(400, '图片大小无效')
    sharp ??= createRequire(nativeRequire.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
    const image = sharp(source, { failOn: 'error', limitInputPixels: 64_000_000 })
    const invalid = () => { throw httpError(400, '图片内容无效，请重新选择') }
    const metadata = await image.metadata().catch(invalid)
    const detected = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[metadata.format]
    if (detected !== mediaType) throw httpError(400, '图片内容与格式不匹配')
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > 64_000_000
      || Math.max(metadata.width, metadata.height) > 8192) throw httpError(413, '图片尺寸超过限制')
    const policy = store?.normalizationPolicy
    const maxBytes = Math.min(policy?.maxBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024)
    const pixels = Math.min(policy?.maxPixels ?? 4 * 1024 * 1024, 4 * 1024 * 1024)
    const dimension = Math.min(policy?.maxDimension ?? 8192, 8192)
    let edge = Math.max(1, Math.floor(Math.min(dimension, Math.max(metadata.width, metadata.height)
      * Math.min(1, Math.sqrt(pixels / (metadata.width * metadata.height))))))
    const outputType = metadata.hasAlpha ? 'image/webp' : 'image/jpeg'
    for (;;) {
      for (const quality of [85, 75, 60]) {
        const resized = image.clone().rotate().toColourspace('srgb').resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        const bytes = await (metadata.hasAlpha ? resized.webp({ quality, effort: 0 }) : resized.jpeg({ quality })).toBuffer().catch(invalid)
        if (bytes.length > maxBytes) continue
        if (!store) return { mediaType: outputType, data: bytes.toString('base64'), name }
        const ref = await store.saveImage({ data: bytes, mediaType: outputType, name })
        const saved = await store.readImage(ref)
        if (saved.data.byteLength > maxBytes) throw httpError(413, '图片规范化结果超过 4 MiB')
        return { mediaType: saved.ref?.mediaType ?? ref.mediaType, data: Buffer.from(saved.data).toString('base64'), name }
      }
      if (edge === 1) throw httpError(413, '图片规范化结果超过 4 MiB')
      edge = Math.max(1, Math.floor(edge * 0.75))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
