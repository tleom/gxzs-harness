import path from 'node:path'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'workbench-global-skills'
export const inject = ['skills', 'fs', 'workbenchPlatformClient']

/** Publication controls live in SQL; DSH parses the skill directory itself. */
export async function publishedGlobalSkills(platform, owner, signal) {
  const payload = await platform.json({ owner, method: 'GET', route: 'workbench/config', signal, timeoutMs: 5000 })
  const rows = payload?.data?.global_skills
  if (!Array.isArray(rows) || rows.some(row => !row || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id)
    || row.id.length > 64 || !Number.isInteger(row.order_num) || row.order_num < -2147483648 || row.order_num > 2147483647)
    || new Set(rows.map(row => row.id)).size !== rows.length)
    throw new Error('全局技能发布配置无效')
  return [...rows].sort((a, b) => a.order_num - b.order_num || compareId(a.id, b.id))
}

export function orderGlobalSkills(skills, published) {
  const orders = new Map(published.map(row => [row.id, row.order_num]))
  return skills.map(skill => skill.scope === 'global' ? { ...skill, order_num: orders.get(skill.id) ?? 0 } : skill)
    .sort((a, b) => Number(a.scope === 'personal') - Number(b.scope === 'personal')
      || (a.scope === 'global' ? a.order_num - b.order_num || compareId(a.id, b.id) : 0))
}

function compareId(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

export class GlobalSkillProvider {
  constructor(native, platform, owner, control) {
    this.name = 'gxzs-filesystem'
    this.native = native
    this.platform = platform
    this.owner = owner
    this.control = control
  }

  async list(options = {}) {
    const signal = this.lookupSignal(options.signal)
    signal?.throwIfAborted()
    const published = await publishedGlobalSkills(this.platform, this.owner, signal)
    const snapshot = await this.native.list({ ...options, signal })
    signal?.throwIfAborted()
    const candidates = Array.isArray(snapshot) ? snapshot : snapshot.candidates
    const byName = new Map()
    for (const candidate of candidates)
      if (path.basename(candidate.locator?.directory ?? '') === candidate.name && !byName.has(candidate.name))
        byName.set(candidate.name, candidate)
    return { candidates: published.flatMap(row => byName.has(row.id) ? [{ ...byName.get(row.id), order_num: row.order_num }] : []),
      complete: Array.isArray(snapshot) || snapshot.complete === true }
  }

  async get(candidate, options = {}) {
    const signal = this.lookupSignal(options.signal)
    signal?.throwIfAborted()
    const published = await publishedGlobalSkills(this.platform, this.owner, signal)
    signal?.throwIfAborted()
    const publication = published.find(row => row.id === candidate.name)
    if (!publication
      || path.basename(candidate.locator?.directory ?? '') !== candidate.name) {
      this.control.invalidate()
      return undefined
    }
    const skill = await this.native.get(candidate, { ...options, signal })
    signal?.throwIfAborted()
    if (skill?.name !== candidate.name) { this.control.invalidate(); return undefined }
    return { ...skill, order_num: publication.order_num }
  }

  dispose() { return this.native.dispose() }

  lookupSignal(signal) {
    return signal && this.control.signal ? AbortSignal.any([signal, this.control.signal]) : signal ?? this.control.signal
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.skills.registerProvider(control => {
      ctx.on('workbench/global-skills-changed', () => control.invalidate())
      const native = new FileSystemSkillProvider(ctx, control, {
        providerName: 'gxzs-filesystem', includeDefaultRoots: false, dshHome: process.env.DSH_HOME,
        customSkillDirs: process.env.GXZS_GLOBAL_SKILL_DIR?.split(',').filter(Boolean) ?? [], watch: true,
      })
      return new GlobalSkillProvider(native, ctx.workbenchPlatformClient,
        { ownerId: process.env.GXZS_HOST_OWNER_ID }, control)
    })
    const timer = setInterval(() => ctx.emit('workbench/global-skills-changed'), 30_000)
    timer.unref?.()
    return () => { clearInterval(timer); dispose() }
  }, 'gxzs published global skills')
}
