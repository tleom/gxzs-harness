import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { admitSandboxAttachments, prepareNativeFiles } from '../src/attachments.js'

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
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
  const attachmentStore = { saveImage: vi.fn(async input => {
    expect(input.data).toEqual(bytes)
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
