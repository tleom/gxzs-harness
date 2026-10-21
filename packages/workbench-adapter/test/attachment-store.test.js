import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import WorkbenchAttachmentStore from '../src/attachment-store.js'
import { resolveUploadedImages } from '../src/attachments.js'
import { exceedsImageDecodeBudget } from '../src/image-policy.js'
import { serializeAttachmentAdmission } from '../src/image-normalizer.js'

const nativeRequire = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const { Context } = nativeRequire('@deepseek-ai/cordis')
const sharp = createRequire(nativeRequire.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
const contexts = [], directories = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function store(config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gxzs-image-policy-'))
  directories.push(directory)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WorkbenchAttachmentStore, { dshHome: directory, imageCompressionConcurrency: 1, ...config })
  return ctx.attachments
}
const jpeg = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#336699' } })
  .jpeg({ progressive: true }).toBuffer()
const oversizedJpeg = Buffer.from(jpeg)
const frame = oversizedJpeg.indexOf(Buffer.from([0xff, 0xc2]))
if (frame < 0) throw new Error('Missing progressive JPEG frame')
oversizedJpeg.writeUInt16BE(8000, frame + 5)
oversizedJpeg.writeUInt16BE(8000, frame + 7)
const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#33669980' } })
  .png({ progressive: true }).toBuffer()
const oversizedPng = Buffer.from(png)
oversizedPng.writeUInt32BE(8000, 16)
oversizedPng.writeUInt32BE(8000, 20)
oversizedPng.writeUInt32BE(crc32(oversizedPng.subarray(12, 29)), 29)

it.each([['image/jpeg', oversizedJpeg], ['image/png', oversizedPng]])(
  'rejects oversized progressive/interlaced images before raster work: %s', async (mediaType, data) => {
    const attachments = await store()
    expect(await sharp(data).metadata()).toMatchObject({ isProgressive: true, width: 8000, height: 8000 })
    for (const operation of ['saveImage', 'validateImage'])
      await expect(attachments[operation]({ data, mediaType })).rejects.toMatchObject({ code: 'IMAGE_DECODE_BUDGET_EXCEEDED', message: expect.stringContaining('1600') })
    await expect(attachments.saveImages([{ data: jpeg, mediaType: 'image/jpeg' }, { data, mediaType }]))
      .rejects.toMatchObject({ code: 'IMAGE_DECODE_BUDGET_EXCEEDED' })
    const upload = await attachments.saveFileStream({ name: 'source', data: (async function* () { yield data })() })
    await expect(resolveUploadedImages(attachments, [{ mediaType, upload }])).rejects.toMatchObject({ status: 413 })
  },
)

it('preserves small progressive images and native durable attachment storage', async () => {
  const attachments = await store()
  const ref = await attachments.saveImage({ data: jpeg, mediaType: 'image/jpeg' })
  expect(Buffer.from((await attachments.readImage(ref)).data)).toEqual(jpeg)
  const [batchRef] = await attachments.saveImages([{ data: jpeg, mediaType: 'image/jpeg' }])
  expect(batchRef).toEqual(ref)
  expect(attachments.imageCompressionConcurrency).toBe(1)
  expect(sharp.cache().items.max).toBe(0)
})

it('keeps ordinary images at 64 million pixels and a 16 million progressive boundary', () => {
  expect(exceedsImageDecodeBudget({ isProgressive: false, width: 8000, height: 8000 })).toBe(false)
  expect(exceedsImageDecodeBudget({ isProgressive: true, width: 4000, height: 4000 })).toBe(false)
  expect(exceedsImageDecodeBudget({ isProgressive: true, width: 4001, height: 4000 })).toBe(true)
})

it('enforces actual normalized bytes for validation and both native publication paths', async () => {
  const maxBytes = 64 * 1024
  const attachments = await store({ normalizedImageMaxBytes: maxBytes })
  const data = await sharp(randomBytes(512 * 512 * 4), { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer()
  const input = { data, mediaType: 'image/png', name: 'noise.png' }
  await attachments.validateImage(input)
  const ref = await attachments.saveImage(input)
  expect(ref.bytes).toBeLessThanOrEqual(maxBytes)
  expect(ref.originalDimensions).toEqual({ width: 512, height: 512 })
  expect((await attachments.readImage(ref)).data.byteLength).toBe(ref.bytes)
  const [batchRef] = await attachments.saveImages([input])
  expect(batchRef).toEqual(ref)
}, 30_000)

it('shares the upload raster lane with native tools and permits awaited nested publication', async () => {
  const attachments = await store()
  let release, enter
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { enter = resolve })
  const active = serializeAttachmentAdmission(async () => { enter(); await gate })
  await entered
  const check = vi.spyOn(attachments, 'checkDecodeBudget')
  const saving = attachments.saveImage({ data: jpeg, mediaType: 'image/jpeg' })
  await Promise.resolve()
  expect(check).not.toHaveBeenCalled()
  release()
  await active
  await saving
  expect(check).toHaveBeenCalledOnce()
  await serializeAttachmentAdmission(async () => {
    await attachments.validateImage({ data: jpeg, mediaType: 'image/jpeg' })
    await attachments.saveImages([{ data: jpeg, mediaType: 'image/jpeg' }])
  })
})
