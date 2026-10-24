import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { SpillStore } from '@deepseek-ai/dsh-spill'
import { Config as ReadConfig } from '@deepseek-ai/dsh-tool-fs'

// A derived reading view only. The canonical spill remains byte-for-byte intact.
export function readableText(content, width) {
  const parts = []
  let start = 0, copied = 0
  while (start < content.length) {
    const newline = content.indexOf('\n', start)
    const end = newline < 0 ? content.length : newline
    while (end - start > width) {
      let cut = start + width
      const last = content.charCodeAt(cut - 1)
      if (last >= 0xd800 && last <= 0xdbff) cut--
      parts.push(content.slice(copied, cut), '\n')
      copied = start = cut
    }
    start = end + 1
  }
  if (!parts.length) return undefined
  parts.push(content.slice(copied))
  return parts.join('')
}

/** Store recoverable tool output in the same filesystem used by read/grep. */
export default class SandboxSpillStore extends SpillStore {
  static inject = ['fs', 'sandboxPolicy']
  static Config = z.object({
    workspace: z.string().default('/workspace'),
    readMaxLineLength: z.number().min(2).default(ReadConfig({}).readMaxLineLength),
    writeTimeoutMs: z.number().min(1).default(30_000),
  })

  constructor(ctx, config) {
    super(ctx)
    if (!posix.isAbsolute(config.workspace)) throw new Error('spill workspace must be an absolute sandbox path')
    this.workspace = config.workspace
    this.readMaxLineLength = config.readMaxLineLength ?? ReadConfig({}).readMaxLineLength
    this.writeTimeoutMs = config.writeTimeoutMs ?? 30_000
    if (!Number.isSafeInteger(this.readMaxLineLength) || this.readMaxLineLength < 2
      || !Number.isSafeInteger(this.writeTimeoutMs) || this.writeTimeoutMs < 1)
      throw new Error('spill reading width and write timeout must be positive integers')
  }

  async saveText(input) {
    const signal = AbortSignal.timeout(this.writeTimeoutMs)
    const session = createHash('sha256').update(input.owner.sessionId).digest('hex').slice(0, 32)
    const path = posix.join(this.workspace, '.agent-output', session, `${randomUUID()}.txt`)
    const workspace = await this.ctx.fs.resolve(this.workspace, { signal })
    const target = await this.ctx.fs.resolve(path, { signal })
    if (!this.ctx.fs.contains(workspace, target)) throw new Error('spill path must remain inside the user workspace')
    // The SSH filesystem creates parents and publishes a 0600 file atomically.
    // A failed remote write is reported to the caller; it never falls back locally.
    await this.ctx.fs.writeText(target, input.content, { kind: 'createIfAbsent' }, signal,
      this.ctx.sandboxPolicy.resolve())
    let retrievalHint = 'Use read with offset/limit, or grep this sandbox path to search within it.'
    const view = readableText(input.content, this.readMaxLineLength)
    if (view !== undefined) {
      try {
        const readable = await this.ctx.fs.resolve(path.replace(/\.txt$/, '.readable.txt'), { signal })
        if (!this.ctx.fs.contains(workspace, readable)) throw new Error('reading view must remain inside the user workspace')
        await this.ctx.fs.writeText(readable, view, { kind: 'createIfAbsent' }, signal,
          this.ctx.sandboxPolicy.resolve())
        retrievalHint = `Use read with offset/limit on ${this.ctx.fs.processPath(readable)}. This reading view wraps long lines; the original locator preserves the exact output.`
      } catch {
        retrievalHint = 'The exact output is saved, but its long-line reading view could not be created. Use exec with a text-processing script to extract character ranges from the original locator; read offsets select lines, not characters.'
      }
    }
    return {
      locator: this.ctx.fs.processPath(target),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint,
    }
  }
}
