import { getEventListeners } from 'node:events'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { admitSandboxAttachments, resolveUploadedImages } from '../src/attachments.js'
import { serializeAttachmentAdmission } from '../src/image-normalizer.js'
import { WorkbenchSubagents } from '../src/subagents.js'

const temporary = vi.hoisted(() => [])
vi.mock('node:fs/promises', async original => {
  const fs = await original()
  return { ...fs, mkdtemp: async (...args) => {
    const directory = await fs.mkdtemp(...args)
    temporary.push(directory)
    return directory
  } }
})
const requireNative = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const sharp = createRequire(requireNative.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
const { prepareImageFile } = await import(pathToFileURL(requireNative.resolve('@deepseek-ai/dsh-attachment-local')).href)
const policy = { maxBytes: 4 * 1024 * 1024, maxPixels: 4 * 1024 * 1024, maxDimension: 8192 }
const limits = { maxImageBytes: 20 * 1024 * 1024, maxImagePixels: 64_000_000, maxImageDimension: 8192 }
const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#336699' } }).png().toBuffer()
const image = (bytes = png, mediaType = 'image/png') => ({ mediaType, upload: { bytes: bytes.length } })
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function storeFor(bytes = png) {
  return {
    normalizationPolicy: policy,
    readFileStream: vi.fn(async function* () { yield bytes }),
    saveImage: vi.fn(async input => prepareImageFile(input, limits, policy)),
    readImage: vi.fn(async value => ({ ref: value.ref, data: value.data })),
  }
}
function observe(promise) {
  return promise.then(value => ({ value }), error => ({ error }))
}
async function immediateResult(outcome) {
  return Promise.race([outcome, delay(250).then(() => 'still waiting')])
}

it('preserves a small lossless PNG byte-for-byte through native validation', async () => {
  const store = storeFor()
  const [result] = await resolveUploadedImages(store, [image()])
  expect(result.mediaType).toBe('image/png')
  expect(Buffer.from(result.data, 'base64')).toEqual(png)
  expect(store.saveImage.mock.calls[0][0].data).toEqual(png)
})

it('reports a decodable-header but corrupt raster as invalid input and releases the image lane', async () => {
  const corrupt = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  expect(await sharp(corrupt).metadata()).toMatchObject({ format: 'png', width: 1, height: 1 })
  const store = storeFor(corrupt)
  const firstDirectory = temporary.length
  await expect(resolveUploadedImages(store, [image(corrupt)]))
    .rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST', message: '图片内容无效，请重新选择' })
  expect(store.saveImage).toHaveBeenCalledOnce()
  expect(store.readImage).not.toHaveBeenCalled()
  for (const directory of temporary.slice(firstDirectory)) await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(resolveUploadedImages(storeFor(), [image()])).resolves.toHaveLength(1)
})

it('preserves native storage failures instead of reporting them as corrupt user images', async () => {
  const store = storeFor()
  const error = Object.assign(new Error('storage unavailable'), { code: 'EIO' })
  store.saveImage.mockRejectedValue(error)
  await expect(resolveUploadedImages(store, [image()])).rejects.toBe(error)
})

it('keeps native orientation and transparency handling for bounded images', async () => {
  const jpeg = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#336699' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer()
  const [rotated] = await resolveUploadedImages(storeFor(jpeg), [image(jpeg, 'image/jpeg')])
  const orientation = await sharp(Buffer.from(rotated.data, 'base64')).metadata()
  expect(orientation).toMatchObject({ width: 40, height: 80 })
  expect(orientation.orientation).toBeUndefined()
  const transparent = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } } }).png().toBuffer()
  const [alpha] = await resolveUploadedImages(storeFor(transparent), [image(transparent)])
  expect((await sharp(Buffer.from(alpha.data, 'base64')).metadata()).hasAlpha).toBe(true)
})

it('lets main-chat and subagent text-only admissions bypass a busy image lane', async () => {
  const gate = deferred(), entered = deferred()
  const active = serializeAttachmentAdmission(async () => { entered.resolve(); await gate.promise })
  await entered.promise
  try {
    expect(await immediateResult(observe(admitSandboxAttachments({ workspace: '/workspace', query: 'text', files: [] }))))
      .toMatchObject({ value: { content: [{ type: 'text', text: 'text' }] } })
    expect(await immediateResult(observe(resolveUploadedImages(undefined, [])))).toEqual({ value: [] })
  } finally { gate.resolve(); await active }
})

it('rejects a queued child cancellation immediately without releasing the preceding batch or reading its images', async () => {
  const gate = deferred(), entered = deferred()
  const active = serializeAttachmentAdmission(async () => { entered.resolve(); await gate.promise })
  await entered.promise
  const cancelledStore = storeFor(), nextStore = storeFor()
  const native = { prompt: vi.fn() }
  const subagents = new WorkbenchSubagents({ native, attachments: cancelledStore })
  subagents.requireChild = vi.fn(async () => ({ id: 'child', parentSessionId: 'parent', mode: 'continuable' }))
  const abort = new AbortController()
  const pending = subagents.prompt({}, 'chat', 'child', { text: 'cancel', requestId: 'r', images: Array.from({ length: 20 }, () => image()) }, abort.signal)
  const outcome = observe(pending)
  await delay(0)
  abort.abort()
  const next = resolveUploadedImages(nextStore, [image()])
  try {
    expect(await immediateResult(outcome)).toMatchObject({ error: { name: 'AbortError' } })
    expect(cancelledStore.readFileStream).not.toHaveBeenCalled()
    expect(nextStore.readFileStream).not.toHaveBeenCalled()
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
  } finally { gate.resolve(); await active; await next }
  expect(cancelledStore.saveImage).not.toHaveBeenCalled()
  expect(native.prompt).not.toHaveBeenCalled()
  expect(nextStore.readFileStream).toHaveBeenCalledOnce()
})

it('keeps the raster lane until an active native operation finishes, then skips the remaining cancelled images', async () => {
  const gate = deferred(), entered = deferred()
  const store = storeFor(), nextStore = storeFor()
  const save = store.saveImage.getMockImplementation()
  store.saveImage.mockImplementation(async input => { entered.resolve(); await gate.promise; return save(input) })
  const abort = new AbortController()
  const pending = resolveUploadedImages(store, [image(), image()], abort.signal)
  const outcome = observe(pending)
  await entered.promise
  abort.abort()
  const next = resolveUploadedImages(nextStore, [image()])
  try {
    expect(await immediateResult(outcome)).toMatchObject({ error: { name: 'AbortError' } })
    expect(nextStore.readFileStream).not.toHaveBeenCalled()
  } finally { gate.resolve(); await next }
  expect(store.readFileStream).toHaveBeenCalledOnce()
  expect(store.readImage).not.toHaveBeenCalled()
  expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
})

it('aborts a source read, closes its iterator, removes staging files and releases listeners', async () => {
  const entered = deferred(), abort = new AbortController(), firstDirectory = temporary.length
  const store = storeFor()
  let closed = false
  store.readFileStream.mockImplementation(async function* (_ref, signal) {
    expect(signal).toBe(abort.signal)
    try {
      yield png.subarray(0, 12)
      entered.resolve()
      await delay(30_000, undefined, { signal })
      yield png.subarray(12)
    } finally { closed = true }
  })
  const pending = resolveUploadedImages(store, [image()], abort.signal)
  const outcome = observe(pending)
  await entered.promise
  abort.abort()
  expect(await immediateResult(outcome)).toMatchObject({ error: { name: 'AbortError' } })
  // The public caller can already be rejected; this barrier waits for cleanup.
  await serializeAttachmentAdmission(async () => {})
  expect(closed).toBe(true)
  expect(store.saveImage).not.toHaveBeenCalled()
  for (const directory of temporary.slice(firstDirectory)) await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0)
})

it('does no work for an already cancelled batch and leaves the lane reusable', async () => {
  const abort = new AbortController(), store = storeFor()
  abort.abort()
  await expect(resolveUploadedImages(store, [image()], abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(store.readFileStream).not.toHaveBeenCalled()
  await expect(resolveUploadedImages(store, [image()])).resolves.toHaveLength(1)
})
