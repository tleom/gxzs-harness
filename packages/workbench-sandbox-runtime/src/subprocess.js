import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import SshSubprocessRuntime from '@deepseek-ai/dsh-subprocess-ssh'
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'

/** Resolve the search tool's packaged executable in the user's SSH sandbox. */
export default class WorkbenchSubprocess extends SshSubprocessRuntime {
  static Config = z.object({ ripgrepExecutable: z.string().default('rg') })

  constructor(ctx, config) {
    super(ctx)
    this.config = config
  }

  async [Service.init]() {
    this.hostRipgrep = await resolveRgPath()
    this.sandboxRipgrep = await this.resolveExecutable(this.config.ripgrepExecutable)
  }

  spawn(spec) {
    return super.spawn(this.mapExecutable(spec))
  }

  spawnTerminal(spec) {
    return super.spawnTerminal(this.mapExecutable(spec))
  }

  mapExecutable(spec) {
    // Only the upstream search binary is remapped; preserve every argument,
    // working directory, stream option and cancellation signal verbatim.
    if (spec.argv[0] !== this.hostRipgrep) return spec
    return { ...spec, argv: [this.sandboxRipgrep, ...spec.argv.slice(1)] }
  }
}
