// A manifest hashing upgrade must not revoke an otherwise identical frozen
// authorization. Compare the complete published definitions and provider
// capabilities before changing only the hash in that authorization.
const stamp = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)

function definition(tool, legacy = false) {
  const { manifest_version, version, public_name, definitionStamp, discoveryStamp, sourceInputSchema, validateArguments, ...value } = tool
  // Admission fills these presentation defaults before freezing authorization.
  // Compare the registration in that same form, retaining all definition fields.
  return { ...value, ...(!legacy ? { version } : {}),
    name: value.tool_name, display_name: value.tool_name,
    group: value.group ?? 'mcp', provider: value.provider ?? 'mcp',
    provider_name: value.provider_name ?? value.server_id,
    provider_call_name: value.provider_call_name ?? value.server_id,
    provider_description: value.provider_description ?? '',
    inputSchema: sourceInputSchema ?? value.inputSchema, runtime_name: public_name ?? value.runtime_name }
}
const provider = tool => `${tool.scope}:mcp:${tool.server_id}`
const capability = ({ manifest_version, legacy_version, version, ...value }, legacy = false) => ({ ...value, ...(!legacy ? { version } : {}) })

export function migrateEquivalentManifests(run, tools, plugins) {
  if (!run || run.stopConfirmation?.fenced || !['queued', 'running', 'waiting_input'].includes(run.status)) return run
  const candidates = (run.selection?.mcp_servers ?? []).flatMap(previous => {
    if (!previous.manifest_version) return []
    const current = plugins.find(item => item.id === previous.id)
    if (!current || current.available === false || !current.manifest_version) return []
    // Personal execution formerly used the raw file hash. Migrate only when
    // that exact configuration still exists and its full catalog is identical.
    const legacy = previous.scope === 'personal' && current.scope === 'personal'
      && /^[a-f0-9]{64}$/.test(previous.version) && /^[a-f0-9]{64}$/.test(current.version)
      && current.legacy_version === previous.version && current.version !== previous.version
    if (!legacy && !(previous.scope === 'global' && current.scope === 'global' && previous.manifest_version !== current.manifest_version)) return []
    return stamp(capability(previous, legacy)) === stamp(capability(current, legacy)) ? [{ previous, current, legacy }] : []
  })
  // Ordinary receipt reads retain lazy decoding of the frozen catalog.
  if (!candidates.length) return run
  const replacements = new Map()
  const frozenGroups = Map.groupBy(run.mcpTools ?? [], provider)
  const currentGroups = Map.groupBy(tools, provider)
  for (const { previous, current, legacy } of candidates) {
    const frozen = frozenGroups.get(previous.id) ?? [], latest = currentGroups.get(previous.id) ?? []
    if ((!frozen.length && !legacy) || frozen.length !== latest.length) continue
    const currentById = new Map(latest.map(tool => [tool.id, tool]))
    if (new Set(frozen.map(tool => tool.id)).size !== frozen.length || currentById.size !== latest.length) continue
    if (!frozen.every(tool => {
      const next = currentById.get(tool.id)
      return tool.manifest_version === previous.manifest_version && next?.manifest_version === current.manifest_version
        && (!legacy || (tool.version === previous.version && next.version === current.version))
        && stamp(definition(tool, legacy)) === stamp(definition(next, legacy))
    })) continue
    replacements.set(previous.id, { version: current.version, manifest_version: current.manifest_version })
  }
  if (!replacements.size) return run
  return { ...run,
    mcpTools: (run.mcpTools ?? []).map(tool => replacements.has(provider(tool))
      ? { ...tool, ...replacements.get(provider(tool)) } : tool),
    selection: { ...run.selection, mcp_servers: run.selection.mcp_servers.map(plugin => replacements.has(plugin.id)
      ? { ...plugin, ...replacements.get(plugin.id) } : plugin) },
  }
}
