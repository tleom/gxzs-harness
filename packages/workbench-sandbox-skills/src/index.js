import yaml from 'js-yaml'

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
        const { content, ...summary } = parseSkill(item)
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
    try { return parseSkill(item) }
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

function parseSkill(item) {
  if (typeof item.id !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(item.id)) throw new Error('invalid skill id')
  if (typeof item.version !== 'string' || !item.version) throw new Error('invalid skill revision')
  if (typeof item.content !== 'string' || Buffer.byteLength(item.content) > 65_536) throw new Error('invalid skill content')
  const lines = item.content.replace(/^\uFEFF/, '').split(/\r?\n/)
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (lines[0]?.trim() !== '---' || end < 0) throw new Error('missing frontmatter')
  const metadata = yaml.load(lines.slice(1, end).join('\n'), { schema: yaml.JSON_SCHEMA })
  if (metadata?.name !== item.id || typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 2000)
    throw new Error('invalid skill metadata')
  return {
    name: item.id, description: metadata.description.trim(), provider: 'gxzs-sandbox-personal', source: 'user-dsh',
    path: `/workspace/skills/${item.id}/SKILL.md`, resourceBase: { kind: 'directory', path: `/workspace/skills/${item.id}` },
    invocation: { modelInvocable: true, userInvocable: true }, content: lines.slice(end + 1).join('\n'), metadata,
  }
}
