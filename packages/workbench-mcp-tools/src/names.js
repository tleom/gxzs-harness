import { createHash } from 'node:crypto'

// Public names are presentation only. Calls keep the frozen resource/server/raw
// identity; never parse a model-facing name to choose an upstream tool.
export function publicToolName(serverName, rawName) {
  const normalized = rawName.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === rawName && normalized.length > 0 && normalized.length <= 64 && !['run_code', 'tool_search', 'mcp'].includes(normalized)) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

export function platformToolName(tool) {
  // Server IDs are stable; localized display labels must never rename tools.
  return publicToolName(`${tool.scope}_${tool.server_id}`, tool.tool_name)
}

export function platformToolNames(tools, reserved = () => false) {
  const counts = new Map()
  for (const tool of tools) {
    const name = platformToolName(tool)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const names = new Map()
  const used = new Set()
  // Allocate by immutable identity so collision resolution survives reordering.
  for (const tool of [...tools].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    let name = platformToolName(tool)
    if (counts.get(name) > 1 || reserved(name)) {
      const hash = createHash('sha256').update(`${tool.scope}\0${tool.server_id}\0${tool.tool_name}`).digest('hex').slice(0, 12)
      name = `${name.slice(0, 51)}_${hash}`
    }
    // Never replace a native tool, including one whose name already resembles
    // an alias. The identity, not catalog order, determines the fallback name.
    for (let attempt = 1; reserved(name) || used.has(name) || (name !== platformToolName(tool) && counts.has(name)); attempt++) {
      if (attempt > 64) throw new Error('MCP public tool namespace is unavailable')
      const hash = createHash('sha256').update(`${tool.scope}\0${tool.server_id}\0${tool.tool_name}\0${attempt}`).digest('hex').slice(0, 12)
      name = `${platformToolName(tool).slice(0, 51)}_${hash}`
    }
    if (used.has(name) || names.has(tool.id)) throw new Error('MCP public tool names must be unique')
    used.add(name)
    names.set(tool.id, name)
  }
  return new Map(tools.map(tool => [tool.id, names.get(tool.id)]))
}
