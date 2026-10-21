import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { admitSandboxAttachments, prepareNativeFiles, resolveUploadedImages } from '../src/attachments.js'

function snapshot(bytes, name = 'a.bin', digest) {
  const version = digest ?? createHash('sha256').update(bytes).digest('hex')
  const body = new ReadableStream({ start(controller) {
    // Exercise image signatures split across network frames.
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  return { fileManager: { download: async () => ({ name, kind: 'file', size: bytes.length, version, body }) },
    workspace: '/workspace', query: 'read', files: [{ path: name, version }] }
}

it('normalizes a fragmented image stream before admitting prompt content', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const attachmentStore = { saveImage: vi.fn(async input => {
    expect(input.data.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)
    return { mediaType: 'image/png' }
  }), readImage: async () => ({ ref: { mediaType: 'image/png' }, data: Buffer.from('normalized') }) }
  const result = await admitSandboxAttachments({ ...snapshot(bytes, 'a.png'), attachmentStore })
  expect(result.content[1]).toMatchObject({ type: 'image', data: Buffer.from('normalized').toString('base64') })
  expect(attachmentStore.saveImage).toHaveBeenCalledOnce()
})

it('persists a durable file reference then streams it into the native session receipt', async () => {
  const bytes = Buffer.from('binary evidence')
  const storedFile = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const attachmentStore = { saveFileStream: async ({ data }) => {
    const chunks = []; for await (const chunk of data) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(bytes)
    return storedFile
  }, readFileStream: async function* () { yield bytes } }
  const result = await admitSandboxAttachments({ ...snapshot(bytes), nativeFiles: true, attachmentStore })
  expect(result.content[1]).toEqual({ type: 'file', name: 'a.bin', storedFile })
  const uploads = { uploadStream: async ({ data, sessionId }) => {
    expect(sessionId).toBe('session')
    const chunks = []; for await (const chunk of data) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(bytes)
    return { receiptId: 'receipt' }
  } }
  expect((await prepareNativeFiles(uploads, 'session', result.content, attachmentStore))[1]).toEqual({ type: 'file', receiptId: 'receipt' })
})

it('rejects a changed stream digest even when metadata claims the expected version', async () => {
  await expect(admitSandboxAttachments(snapshot(Buffer.from('changed'), 'a.bin', 'a'.repeat(64)))).rejects.toMatchObject({ status: 409 })
})

it('rejects an oversized file before consuming its stream and cancels the body', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream({ cancel })
  await expect(admitSandboxAttachments({ workspace: '/workspace', query: 'read', files: [{ path: 'a', version: 'v' }],
    fileManager: { download: async () => ({ body, kind: 'file', version: 'v', size: 100 * 1024 * 1024 + 1 }) },
  })).rejects.toMatchObject({ status: 413 })
  expect(cancel).toHaveBeenCalledOnce()
})

it('rejects images above 20 MiB before opening a stored upload', async () => {
  const store = { readFileStream: vi.fn() }
  await expect(resolveUploadedImages(store, [{ mediaType: 'image/png', upload: { bytes: 20 * 1024 * 1024 + 1 } }])).rejects.toMatchObject({ status: 413 })
  expect(store.readFileStream).not.toHaveBeenCalled()
})

it('normalizes a full 20 MiB disk-backed image without passing its source buffer to the store', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const size = 20 * 1024 * 1024
  const store = {
    readFileStream: async function* () {
      yield png
      const chunk = Buffer.alloc(64 * 1024)
      for (let remaining = size - png.length; remaining; remaining -= Math.min(remaining, chunk.length)) yield chunk.subarray(0, Math.min(remaining, chunk.length))
    },
    saveImage: vi.fn(async input => {
      expect(input.data.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024)
      return { mediaType: input.mediaType, data: input.data }
    }),
    readImage: async ref => ({ ref, data: ref.data }),
  }
  const result = await resolveUploadedImages(store, [{ mediaType: 'image/png', name: 'large.png', upload: { bytes: size } }])
  expect(result).toHaveLength(1)
  expect(Buffer.byteLength(result[0].data, 'base64')).toBeLessThanOrEqual(4 * 1024 * 1024)
  expect(store.saveImage).toHaveBeenCalledOnce()
})

it('serializes concurrent image batches and keeps the lane usable after a decode error', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const reads = []
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const store = {
    readFileStream: async function* (ref) { reads.push(ref.id); yield ref.id === 'bad' ? Buffer.alloc(png.length) : png },
    saveImage: async input => {
      if (reads.length === 1) { started(); await gate }
      return { mediaType: input.mediaType, data: input.data }
    },
    readImage: async ref => ({ ref, data: ref.data }),
  }
  const image = id => [{ mediaType: 'image/png', upload: { id, bytes: png.length } }]
  const first = resolveUploadedImages(store, image('first'))
  await entered
  const second = resolveUploadedImages(store, image('second'))
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(reads).toEqual(['first'])
  release()
  await Promise.all([first, second])
  await expect(resolveUploadedImages(store, image('bad'))).rejects.toMatchObject({ status: 400 })
  await expect(resolveUploadedImages(store, image('after'))).resolves.toHaveLength(1)
  expect(reads).toEqual(['first', 'second', 'bad', 'after'])
})
