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
    let snapshot
    try {
      snapshot = await this.manager.personalResources({ operation: 'list' })
    } catch (error) {
      this.checkAbort(options.signal)
      // A failed personal provider cannot certify any of its entries. Publish
      // an authoritative empty contribution so healthy global skills remain visible.
      return { candidates: [], complete: true }
    }
    this.checkAbort(options.signal)
    const candidates = []
    for (const item of snapshot.skills ?? []) {
      if (item.enabled !== true) continue
      try {
        const { content, ...summary } = await parseSkill(item)
        candidates.push({ ...summary, rank: 400, locator: { id: item.id, version: item.version } })
      } catch { /* Invalid personal skills never enter the model catalog. */ }
    }
    // Each load still revalidates the enabled state and revision in the manager.
    return { candidates, complete: true }
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
  ctx.effect(() => {
    let timer
    const dispose = ctx.skills.registerProvider((control) => {
      ctx.on('workbench/resources-changed', () => control.invalidate())
      // External sandbox writes bypass Host events; periodically re-observe them.
      timer = setInterval(() => control.invalidate(), 30_000)
      timer.unref?.()
      return new SandboxSkillProvider(ctx.workbenchFileManager, control)
    })
    return () => { clearInterval(timer); dispose() }
  }, 'gxzs remote personal skills')
}

async function parseSkill(item) {
  if (typeof item.version !== 'string' || !item.version) throw new Error('invalid skill revision')
  return readSkillDefinition(item.content, { id: item.id })
}
