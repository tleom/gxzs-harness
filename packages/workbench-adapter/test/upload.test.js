import { afterEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { spoolUpload, MAX_UPLOAD_BYTES } from '../src/upload.js'

const pending = []
afterEach(async () => { for (const upload of pending.splice(0)) await upload.dispose() })
function request(chunks, headers = {}) {
  return Object.assign(Readable.from(chunks), { headers: { 'content-type': 'application/octet-stream', ...headers } })
}
describe('signed streamed uploads', () => {
  it('applies the image route budget before consuming an oversized upload', async () => {
    let read = false
    const input = (async function* () { read = true; yield Buffer.alloc(1) })()
    await expect(spoolUpload(request(input, { 'content-length': String(20 * 1024 * 1024 + 128 * 1024 + 1) }), () => {}, undefined, 20 * 1024 * 1024)).rejects.toMatchObject({ status: 413 })
    expect(read).toBe(false)
  })
  it.each(['Application/Octet-Stream', 'application/octet-stream; charset=binary', 'APPLICATION/OCTET-STREAM ; name=upload.bin'])('accepts the binary media type %s', async contentType => {
    const upload = await spoolUpload(request([Buffer.from('{}\nx')], { 'content-type': contentType }), () => {})
    pending.push(upload)
    expect(upload.size - upload.offset).toBe(1)
  })
  it.each([undefined, '', 'application/*', 'application/octet-streamx', 'text/plain; application/octet-stream'])('rejects a different media type %s', async contentType => {
    await expect(spoolUpload(request([], { 'content-type': contentType }), () => {})).rejects.toMatchObject({ status: 415 })
  })
  it('spools split headers and binary bytes without changing the signed digest', async () => {
    const bytes = Buffer.from('文件\u0000body')
    const header = Buffer.from(JSON.stringify({ operation: 'upload', path: 'a.txt', version: null, size: bytes.length }) + '\n')
    const expected = createHash('sha256').update(header).update(bytes).digest('hex')
    const upload = await spoolUpload(request([header.subarray(0, 2), header.subarray(2), bytes]), digest => expect(digest).toBe(expected))
    pending.push(upload)
    expect(upload.metadata.path).toBe('a.txt')
    expect((await readFile(upload.path)).subarray(upload.offset)).toEqual(bytes)
    await upload.dispose()
    await expect(stat(upload.path)).rejects.toThrow()
  })
  it('accepts exactly 100 MiB using reusable bounded chunks', async () => {
    const header = Buffer.from(JSON.stringify({ operation: 'upload', size: 100 * 1024 * 1024 }) + '\n')
    const chunk = Buffer.alloc(64 * 1024, 65)
    const input = (async function* () { yield header; for (let n = 0; n < 1600; n++) yield chunk })()
    const upload = await spoolUpload(request(input), () => {})
    pending.push(upload)
    expect(upload.size - upload.offset).toBe(100 * 1024 * 1024)
  }, 30_000)
  it('rejects oversized declared input before reading any bytes', async () => {
    let read = false
    const input = (async function* () { read = true; yield Buffer.alloc(1) })()
    await expect(spoolUpload(request(input, { 'content-length': String(MAX_UPLOAD_BYTES + 1) }), () => {})).rejects.toMatchObject({ status: 413 })
    expect(read).toBe(false)
  })
  it('rejects mismatched digest, malformed metadata and incomplete uploads', async () => {
    await expect(spoolUpload(request([Buffer.from('{}\nx')]), () => { throw new Error('digest mismatch') })).rejects.toThrow('digest mismatch')
    await expect(spoolUpload(request([Buffer.from('bad\nx')]), () => {})).rejects.toMatchObject({ status: 400 })
    await expect(spoolUpload(request([Buffer.from('{}\nx')], { 'content-length': '9' }), () => {})).rejects.toMatchObject({ status: 400 })
  })
  it('does not accept an aborted upload', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(spoolUpload(request([Buffer.from('{}\n')]), () => {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
