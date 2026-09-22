import { readSkillDefinition } from './definition.js'

export const name = 'workbench-sandbox-skills'
export const inject = ['skills', 'workbenchFileManager']

export class SandboxSkillProvider {
  constructor(manager, control) {
    this.manager = manager
    this.control = control
    this.name = 'gxzs-sandbox-personal'
  }

  async list(options = {}) {
    this.checkAbort(options.signal)
    const snapshot = await this.manager.personalResources({ operation: 'list' })
    this.checkAbort(options.signal)
    const candidates = []
    for (const item of snapshot.skills ?? []) {
      if (item.enabled !== true) continue
      try {
        const { content, ...summary } = await parseSkill(item)
        candidates.push({ ...summary, rank: 400, locator: { id: item.id, version: item.version } })
      } catch { /* Invalid personal skills never enter the model catalog. */ }
    }
    // The manager can be mutated outside this host, so every lookup must revalidate.
    return { candidates, complete: false }
  }

  async get(candidate, options = {}) {
    this.checkAbort(options.signal)
    const snapshot = await this.manager.personalResources({ operation: 'list' })
    this.checkAbort(options.signal)
    const item = (snapshot.skills ?? []).find((skill) => skill.id === candidate.locator?.id)
    if (!item || item.enabled !== true || item.version !== candidate.locator?.version) {
      this.control.invalidate()
      return undefined
    }
    try { return await parseSkill(item) }
    catch { this.control.invalidate(); return undefined }
  }

  checkAbort(signal) {
    this.control.signal?.throwIfAborted()
    signal?.throwIfAborted()
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider((control) => {
    ctx.on('workbench/resources-changed', () => control.invalidate())
    return new SandboxSkillProvider(ctx.workbenchFileManager, control)
  }), 'gxzs remote personal skills')
}

async function parseSkill(item) {
  if (typeof item.version !== 'string' || !item.version) throw new Error('invalid skill revision')
  return readSkillDefinition(item.content, { id: item.id })
}
