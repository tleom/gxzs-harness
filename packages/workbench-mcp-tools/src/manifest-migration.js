// A manifest hashing upgrade must not revoke an otherwise identical frozen
// authorization. Compare the complete published definitions and provider
// capabilities before changing only the hash in that authorization.
const stamp = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)

function definition(tool) {
  const { manifest_version, public_name, definitionStamp, discoveryStamp, sourceInputSchema, validateArguments, ...value } = tool
  return { ...value, inputSchema: sourceInputSchema ?? value.inputSchema, runtime_name: public_name ?? value.runtime_name }
}
const provider = tool => `${tool.scope}:mcp:${tool.server_id}`
const capability = ({ manifest_version, ...value }) => value

export function migrateEquivalentManifests(run, tools, plugins) {
  if (!run || run.stopConfirmation?.fenced || !['queued', 'running', 'waiting_input'].includes(run.status)) return run
  const candidates = (run.selection?.mcp_servers ?? []).flatMap(previous => {
    if (previous.scope !== 'global' || !previous.manifest_version) return []
    const current = plugins.find(item => item.id === previous.id)
    return current && current.available !== false && current.manifest_version && previous.manifest_version !== current.manifest_version
      && stamp(capability(previous)) === stamp(capability(current)) ? [{ previous, current }] : []
  })
  // Ordinary receipt reads retain lazy decoding of the frozen catalog.
  if (!candidates.length) return run
  const replacements = new Map()
  const frozenGroups = Map.groupBy(run.mcpTools ?? [], provider)
  const currentGroups = Map.groupBy(tools, provider)
  for (const { previous, current } of candidates) {
    const frozen = frozenGroups.get(previous.id) ?? [], latest = currentGroups.get(previous.id) ?? []
    if (!frozen.length || frozen.length !== latest.length) continue
    const currentById = new Map(latest.map(tool => [tool.id, tool]))
    if (new Set(frozen.map(tool => tool.id)).size !== frozen.length || currentById.size !== latest.length) continue
    if (!frozen.every(tool => {
      const next = currentById.get(tool.id)
      return tool.manifest_version === previous.manifest_version && next?.manifest_version === current.manifest_version
        && stamp(definition(tool)) === stamp(definition(next))
    })) continue
    replacements.set(previous.id, current.manifest_version)
  }
  if (!replacements.size) return run
  return { ...run,
    mcpTools: run.mcpTools.map(tool => replacements.has(provider(tool))
      ? { ...tool, manifest_version: replacements.get(provider(tool)) } : tool),
    selection: { ...run.selection, mcp_servers: run.selection.mcp_servers.map(plugin => replacements.has(plugin.id)
      ? { ...plugin, manifest_version: replacements.get(plugin.id) } : plugin) },
  }
}
