import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { httpError } from './http.js'

export const uploadPartBytes = 4 * 1024 * 1024
const maxFileBytes = 1024 * 1024 * 1024
const maxPending = 3
const retention = 24 * 60 * 60_000
const uploadId = /^[a-f0-9]{32}$/
const sha = /^[a-f0-9]{64}$/
const notFound = error => error?.code === 'ENOENT'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (!notFound(error)) throw error }
}

async function recoverableWrite(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600, flush: true })
    if (!exclusive) await rename(temporary, path)
    else await link(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export class ResumableUploads {
  constructor(root) {
    this.root = root
    this.active = new Map()
  }

  directory(id) {
    if (!uploadId.test(id) || !this.root) throw httpError(404, '上传任务不存在')
    return join(this.root, id)
  }

  async manifest(id) {
    const directory = this.directory(id)
    const value = await readJson(join(directory, 'upload.json'))
    if (!value) throw httpError(404, '上传任务不存在或已过期')
    return { directory, manifest: value }
  }

  async begin(id, metadata) {
    const directory = this.directory(id)
    const { path, version, size, digest } = metadata
    if ((path !== null && typeof path !== 'string') || !Number.isSafeInteger(size) || size < 0 || size > maxFileBytes
      || typeof digest !== 'string' || !sha.test(digest)
      || (version !== null && (typeof version !== 'string' || !sha.test(version)))) throw httpError(400, '上传参数无效')
    const value = { path, version, size, digest }
    return this.serial('open', async () => {
      const existing = await readJson(join(directory, 'upload.json'))
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(value)) throw httpError(409, '上传标识已绑定其他文件')
        return this.status(id)
      }
      await this.sweep()
      let pending = 0
      for (const name of await readdir(this.root)) {
        if (!uploadId.test(name)) continue
        if (!await readJson(join(this.root, name, 'result.json'))) pending++
      }
      if (pending >= maxPending) throw httpError(429, '有其他文件正在上传，请稍后重试')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await recoverableWrite(join(directory, 'upload.json'), JSON.stringify(value), true)
      return this.status(id)
    })
  }

  async status(id) {
    const { directory, manifest } = await this.manifest(id)
    const completed = await readJson(join(directory, 'result.json'))
    const failure = completed ? undefined : await readJson(join(directory, 'failure.json'))
    const publishing = !completed && !failure && Boolean(await readJson(join(directory, 'publish.json')))
    const parts = completed ? [] : (await readdir(directory))
      .filter(name => /^\d{1,3}\.part$/.test(name))
      .map(name => Number.parseInt(name, 10)).sort((a, b) => a - b)
    return { partBytes: uploadPartBytes, totalBytes: manifest.size, parts, completed, failure, publishing }
  }

  async part(id, index, bytes, expectedSha) {
    return this.serial(id, async () => {
      const { directory, manifest } = await this.manifest(id)
      const offset = index * uploadPartBytes
      if (!Number.isSafeInteger(index) || index < 0 || offset >= manifest.size
        || bytes.length !== Math.min(uploadPartBytes, manifest.size - offset)
        || typeof expectedSha !== 'string' || !sha.test(expectedSha) || hash(bytes) !== expectedSha) {
        throw httpError(400, '文件分片校验失败')
      }
      if (await readJson(join(directory, 'result.json'))) return
      const path = join(directory, `${index}.part`)
      try { await recoverableWrite(path, bytes, true) }
      catch (error) {
        if (error?.code !== 'EEXIST' || hash(await readFile(path)) !== expectedSha) throw error
      }
    })
  }

  async discard(id) {
    return this.serial(id, async () => {
      const directory = this.directory(id)
      const manifest = await readJson(join(directory, 'upload.json'))
      if (manifest?.path === null && !await readJson(join(directory, 'commit.json'))
        && !await readJson(join(directory, 'publish.json')))
        await rm(directory, { recursive: true, force: true })
    })
  }

  async requestCommit(id, destination) {
    const first = await this.manifest(id)
    const requested = this.publishTarget(first.manifest, destination)
    const queued = await readJson(join(first.directory, 'publish.json'))
    if (queued && !await readJson(join(first.directory, 'failure.json'))
      && !await readJson(join(first.directory, 'result.json'))) {
      if (queued.path !== requested.path || queued.version !== requested.version)
        throw httpError(409, '上传任务已绑定其他目标')
      return { publishing: true, target: requested }
    }
    return this.serial(id, async () => {
      const { directory, manifest } = await this.manifest(id)
      const target = this.publishTarget(manifest, destination)
      const previous = await readJson(join(directory, 'result.json'))
      if (previous) {
        if (previous.path !== target.path) throw httpError(409, '上传任务已绑定其他目标')
        return { completed: previous }
      }
      const intentPath = join(directory, 'publish.json')
      const existing = await readJson(intentPath)
      if (existing && (existing.path !== target.path || existing.version !== target.version))
        throw httpError(409, '上传任务已绑定其他目标')
      const names = new Set(await readdir(directory))
      for (let index = 0; index * uploadPartBytes < manifest.size; index++) {
        if (!names.has(`${index}.part`)) throw httpError(409, '文件分片尚未上传完整')
      }
      await rm(join(directory, 'failure.json'), { force: true })
      if (!existing) await recoverableWrite(intentPath, JSON.stringify(target))
      return { publishing: true, target }
    })
  }

  async pendingCommits() {
    if (!this.root) return []
    const dirs = await readdir(this.root).catch(error => { if (notFound(error)) return []; throw error })
    const pending = []
    for (const id of dirs) {
      if (!uploadId.test(id)) continue
      const directory = this.directory(id)
      if (await readJson(join(directory, 'result.json')) || await readJson(join(directory, 'failure.json'))) continue
      const target = await readJson(join(directory, 'publish.json'))
      if (target) pending.push({ id, target })
    }
    return pending
  }

  async failedCommit(id, error) {
    const { directory } = await this.manifest(id)
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 503
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'UPLOAD_PUBLISH_FAILED'
    await recoverableWrite(join(directory, 'failure.json'), JSON.stringify({ status, code }))
    if (status === 409 && ['FILE_VERSION_CONFLICT', 'RESOURCE_CONFLICT'].includes(code))
      await rm(join(directory, 'publish.json'), { force: true })
  }

  publishTarget(manifest, destination) {
    const target = manifest.path === null ? destination : manifest
    if (!target || typeof target.path !== 'string'
      || (target.version !== null && (typeof target.version !== 'string' || !sha.test(target.version))))
      throw httpError(400, '上传目标无效')
    return { path: target.path, version: target.version }
  }

  async commit(id, publish, find, signal, destination) {
    return this.serial(id, async () => {
      const { directory, manifest } = await this.manifest(id)
      const resultPath = join(directory, 'result.json')
      const bindingPath = join(directory, 'commit.json')
      const target = this.publishTarget(manifest, destination)
      let binding = await readJson(bindingPath)
      if (binding && (binding.path !== target.path || binding.version !== target.version))
        throw httpError(409, '上传任务已绑定其他目标')
      const previous = await readJson(resultPath)
      if (previous) return previous
      const bind = async () => {
        if (binding) return
        binding = { path: target.path, version: target.version }
        await recoverableWrite(bindingPath, JSON.stringify(binding))
      }
      const count = Math.ceil(manifest.size / uploadPartBytes)
      const files = Array.from({ length: count }, (_, index) => join(directory, `${index}.part`))
      let current
      try { current = await find(target.path) }
      catch (error) { if (error?.status !== 404) throw error }
      let result
      if (current?.version === manifest.digest && current?.size === manifest.size) {
        result = { path: target.path, version: manifest.digest }
      } else {
        for (const [index, file] of files.entries()) {
          const info = await stat(file).catch(error => { if (!notFound(error)) throw error })
          if (info?.size !== Math.min(uploadPartBytes, manifest.size - index * uploadPartBytes))
            throw httpError(409, '文件分片尚未上传完整')
        }
        const temporary = join(directory, `assembly.${randomUUID()}.tmp`)
        const digest = createHash('sha256')
        try {
          const read = async function * () {
            for (const file of files) {
              for await (const bytes of createReadStream(file, { signal })) {
                digest.update(bytes)
                yield bytes
              }
            }
          }
          await pipeline(Readable.from(read()), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal })
          if (digest.digest('hex') !== manifest.digest) throw httpError(409, '文件内容校验失败，请重新选择文件')
          await bind()
          result = await publish({
            path: temporary, offset: 0, size: manifest.size,
            metadata: { operation: 'upload', path: target.path, version: target.version, size: manifest.size },
          })
        } catch (error) {
          if (error?.status === 409 && ['FILE_VERSION_CONFLICT', 'RESOURCE_CONFLICT'].includes(error.code))
            await rm(bindingPath, { force: true })
          throw error
        } finally { await rm(temporary, { force: true }) }
      }
      await bind()
      await recoverableWrite(resultPath, JSON.stringify(result))
      for (const file of files) await rm(file, { force: true })
      return result
    })
  }

  async sweep() {
    if (!this.root) return
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.root)) {
      if (!uploadId.test(name) || this.active.has(name)) continue
      const directory = join(this.root, name)
      const info = await stat(directory).catch(error => { if (!notFound(error)) throw error })
      if (info && Date.now() - info.mtimeMs > retention) await rm(directory, { recursive: true, force: true })
    }
  }

  async serial(key, operation) {
    const prior = this.active.get(key) ?? Promise.resolve()
    const next = prior.catch(() => undefined).then(operation)
    this.active.set(key, next)
    try { return await next }
    finally { if (this.active.get(key) === next) this.active.delete(key) }
  }
}
