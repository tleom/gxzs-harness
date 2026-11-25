import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ResumableUploads, uploadPartBytes } from '../src/resumable-uploads.js'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

it('releases a fixed-path upload slot without discarding a pending publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gxzs-cancel-upload-'))
  roots.push(root)
  const store = new ResumableUploads(root)
  const bytes = Buffer.from('fixed destination')
  const metadata = { path: 'output.bin', version: null, size: bytes.length, digest: hash(bytes) }
  const [first, second, third, fourth] = ['a', 'b', 'c', 'd'].map(char => char.repeat(32))
  for (const id of [first, second, third]) await store.begin(id, metadata)
  await expect(store.begin(fourth, metadata)).rejects.toMatchObject({ status: 429 })
  await store.discard(first)
  await expect(store.status(first)).rejects.toMatchObject({ status: 404 })
  await store.begin(fourth, metadata)
  await store.part(fourth, 0, bytes, metadata.digest)
  await store.requestCommit(fourth)
  await store.discard(fourth)
  expect(await store.status(fourth)).toMatchObject({ publishing: true })
})

it('retains completed parts across restart and publishes validated bytes only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gxzs-part-test-'))
  roots.push(root)
  const id = 'a'.repeat(32)
  const data = Buffer.alloc(uploadPartBytes + 11, 0x6e)
  const first = data.subarray(0, uploadPartBytes), last = data.subarray(uploadPartBytes)
  const metadata = { path: 'conversations/report.bin', version: null, size: data.length, digest: hash(data) }
  let store = new ResumableUploads(root)
  await store.begin(id, metadata)
  await store.part(id, 0, first, hash(first))
  store = new ResumableUploads(root)
  expect((await store.begin(id, metadata)).parts).toEqual([0])
  await expect(store.part(id, 1, last, '0'.repeat(64))).rejects.toMatchObject({ status: 400 })
  await expect(store.commit(id, vi.fn(), async () => null)).rejects.toMatchObject({ status: 409 })
  await store.part(id, 0, first, hash(first))
  await store.part(id, 1, last, hash(last))
  const result = { path: metadata.path, version: metadata.digest }
  const publish = vi.fn(async upload => {
    expect(hash(await readFile(upload.path))).toBe(metadata.digest)
    return result
  })
  expect(await store.commit(id, publish, async () => null)).toEqual(result)
  expect(await new ResumableUploads(root).commit(id, publish, async () => null)).toEqual(result)
  expect((await store.status(id)).completed).toEqual(result)
  expect(publish).toHaveBeenCalledOnce()
  await expect(store.begin(id, { ...metadata, path: 'another' })).rejects.toMatchObject({ status: 409 })
})

it('stages bytes before choosing a final path and binds retries to the first published path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gxzs-attachments-'))
  roots.push(root)
  const id = 'b'.repeat(32)
  const bytes = Buffer.from('prepared attachment')
  const store = new ResumableUploads(root)
  await store.begin(id, { path: null, version: null, size: bytes.length, digest: hash(bytes) })
  await store.part(id, 0, bytes, hash(bytes))
  const target = { path: 'conversations/new/report.txt', version: null }
  const result = { path: target.path, version: hash(bytes) }
  const write = vi.fn(async () => result)
  const find = async () => null
  await expect(store.commit(id, write, find)).rejects.toMatchObject({ status: 400 })
  expect(await store.requestCommit(id, target)).toEqual({ publishing: true, target })
  expect(await new ResumableUploads(root).pendingCommits()).toEqual([{ id, target }])
  expect(await store.commit(id, write, find, undefined, target)).toEqual(result)
  expect(await new ResumableUploads(root).commit(id, write, find, undefined, target)).toEqual(result)
  await expect(store.commit(id, write, find, undefined, { ...target, path: 'other.txt' })).rejects.toMatchObject({ status: 409 })
  expect(write).toHaveBeenCalledOnce()
})
