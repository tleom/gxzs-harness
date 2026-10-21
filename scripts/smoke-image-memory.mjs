import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.GXZS_SMOKE_SOURCE_ROOT ?? '/opt/workbench'
const requireNative = createRequire(join(root, 'profiles/workbench/package.json'))
const native = name => import(pathToFileURL(requireNative.resolve(name)).href)
const [{ Context }, { LocalAttachmentStore }, { resolveUploadedImages }] = await Promise.all([
  native('@deepseek-ai/cordis'), native('@deepseek-ai/dsh-attachment-local'),
  import(pathToFileURL(join(root, 'packages/workbench-adapter/src/attachments.js')).href),
])
const sharp = createRequire(requireNative.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
const directory = await mkdtemp(join(tmpdir(), 'gxzs-image-memory-'))
const ctx = new Context()
try {
  const source = join(directory, 'source.png')
  // Exercise the decoded-pixel ceiling as well as the encoded-byte ceiling.
  await sharp({ create: { width: 8000, height: 8000, channels: 4,
    background: { r: 20, g: 40, b: 60, alpha: 0.75 } } }).png().toFile(source)
  const bytes = 20 * 1024 * 1024
  assert.ok((await stat(source)).size < bytes)
  await ctx.plugin(LocalAttachmentStore, { dshHome: directory, maxImageBytes: bytes,
    maxImagesPerMessage: 20, maxMessageImageBytes: 1024 * 1024 * 1024 })
  const store = ctx.attachments
  const data = (async function* () {
    let count = 0
    for await (const chunk of createReadStream(source)) { count += chunk.length; yield chunk }
    const padding = Buffer.alloc(64 * 1024)
    while (count < bytes) { const next = padding.subarray(0, Math.min(padding.length, bytes - count)); count += next.length; yield next }
  })()
  const upload = await store.saveFileStream({ name: 'source.png', data })
  const images = Array.from({ length: 20 }, (_, index) => ({ name: `${index}.png`, mediaType: 'image/png', upload }))
  const resolved = await resolveUploadedImages(store, images)
  assert.equal(resolved.length, 20)
  for (const image of resolved) assert.ok(Buffer.byteLength(image.data, 'base64') <= 4 * 1024 * 1024)
  console.log(JSON.stringify({ check: 'image-memory', count: 20, sourceBytes: bytes * 20,
    pixelsPerImage: 64_000_000, maxRssKiB: process.resourceUsage().maxRSS }))
  console.log('PASS image admission: 20 x 20 MiB, 64 million pixels each, disk-backed serialized normalization')
} finally {
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
