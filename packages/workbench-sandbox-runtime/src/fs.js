import path, { posix } from 'node:path'
import z from '@deepseek-ai/schemastery'
import SshFileSystem from '@deepseek-ai/dsh-fs-ssh'

/** Native SSH filesystem with the owner's explicitly shared attachment mount. */
export default class WorkbenchFileSystem extends SshFileSystem {
  static Config = z.object({
    attachmentHostRoot: z.string().default(''),
    attachmentSandboxRoot: z.string().default('/srv/dsh/attachments'),
  })

  constructor(ctx, config = {}) {
    super(ctx)
    const hostRoot = config.attachmentHostRoot ?? ''
    const sandboxRoot = config.attachmentSandboxRoot ?? '/srv/dsh/attachments'
    if (hostRoot && (!path.isAbsolute(hostRoot) || path.resolve(hostRoot) === path.parse(path.resolve(hostRoot)).root
      || /[\r\n\0]/u.test(hostRoot))) throw new Error('Attachment host root must be an absolute directory')
    if (!posix.isAbsolute(sandboxRoot) || posix.normalize(sandboxRoot) !== sandboxRoot
      || sandboxRoot === '/' || /[\r\n\0]/u.test(sandboxRoot))
      throw new Error('Attachment sandbox root must be an absolute directory')
    this.attachmentHostRoot = hostRoot ? path.resolve(hostRoot) : undefined
    this.attachmentSandboxRoot = sandboxRoot
  }

  processPathFromHostPath(hostPath) {
    if (!this.attachmentHostRoot || typeof hostPath !== 'string' || !path.isAbsolute(hostPath)
      || /[\r\n\0]/u.test(hostPath) || path.normalize(hostPath) !== hostPath) return undefined
    const relative = path.relative(this.attachmentHostRoot, hostPath)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return undefined
    return posix.join(this.attachmentSandboxRoot, ...relative.split(path.sep))
  }
}
