import { createHash } from 'node:crypto'

// DSH 0.1.6-alpha.2 exports createMcpToolDefinition, but not publicToolName.
// Keep this compatibility boundary identical to mcp-client/src/tools.ts;
// both catalog presentation and registration consume this one function.
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

export function platformToolName(tool) {
  // Server IDs are stable; localized display labels must never rename tools.
  return publicToolName(`${tool.scope}_${tool.server_id}`, tool.tool_name)
}
