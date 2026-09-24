import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

/** Parse a sandbox-validated snapshot through DSH, never through Host files. */
export async function readSkillDefinition(content, { id, signal } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 65_536)
    throw new Error('SKILL.md 无效或超过 64 KiB')
  const path = `/workspace/skills/${id || '.inspect'}/SKILL.md`
  const fs = {
    resolve: async () => ({ displayPath: path }),
    stat: async () => ({ type: 'file' }),
    processPath: () => path,
    readText: async () => content.replace(/^\uFEFF/, ''),
  }
  let warning = ''
  const lifecycle = new AbortController()
  const provider = new FileSystemSkillProvider({
    get: (name) => name === 'fs' ? fs : undefined,
    logger: { warn: (message) => { warning = message } },
  }, { signal: lifecycle.signal, invalidate() {} }, {
    providerName: 'gxzs-sandbox-personal', includeDefaultRoots: false, watch: false,
  })
  try {
    const definition = await provider.get({
      source: 'user-dsh', locator: { path, directory: path.slice(0, -9) },
    }, { signal })
    if (!definition) throw new Error(warning || 'SKILL.md 文件头无效')
    if (id !== undefined && definition.name !== id) throw new Error('技能目录名与 name 不一致')
    return { ...definition, displayName: skillDisplayName(definition) }
  } finally {
    await provider.dispose()
  }
}

export function skillDisplayName(skill) {
  const value = skill.metadata?.['display-name'] ?? skill.metadata?.displayName
  return typeof value === 'string' && value.trim() ? value.trim() : skill.name
}
