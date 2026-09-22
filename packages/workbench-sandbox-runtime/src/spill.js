import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { SpillStore } from '@deepseek-ai/dsh-spill'

/** Store recoverable tool output in the same filesystem used by read/grep. */
export default class SandboxSpillStore extends SpillStore {
  static inject = ['fs', 'sandboxPolicy']
  static Config = z.object({ workspace: z.string().default('/workspace') })

  constructor(ctx, config) {
    super(ctx)
    if (!posix.isAbsolute(config.workspace)) throw new Error('spill workspace must be an absolute sandbox path')
    this.workspace = config.workspace
  }

  async saveText(input) {
    const signal = AbortSignal.timeout(30_000)
    const session = createHash('sha256').update(input.owner.sessionId).digest('hex').slice(0, 32)
    const path = posix.join(this.workspace, '.agent-output', session, `${randomUUID()}.txt`)
    const workspace = await this.ctx.fs.resolve(this.workspace, { signal })
    const target = await this.ctx.fs.resolve(path, { signal })
    if (!this.ctx.fs.contains(workspace, target)) throw new Error('spill path must remain inside the user workspace')
    // The SSH filesystem creates parents and publishes a 0600 file atomically.
    // A failed remote write is reported to the caller; it never falls back locally.
    await this.ctx.fs.writeText(target, input.content, { kind: 'createIfAbsent' }, signal,
      this.ctx.sandboxPolicy.resolve())
    return {
      locator: this.ctx.fs.processPath(target),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use read with offset/limit, or grep this sandbox path to search within it.',
    }
  }
}
