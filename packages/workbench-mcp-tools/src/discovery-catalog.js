import { Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { taskCapabilities } from './tasks.js'

// This bridge exposes host-authorized metadata, never another Agent's scoped
// ToolRuntime. The discovery plugin only controls presentation and activation.
export class ToolDiscoveryCatalog extends Service {
  constructor(ctx, { registrations, authorizedNames, setReady }) {
    super(ctx, 'toolDiscoveryCatalog')
    this.registrations = registrations
    this.authorizedNames = authorizedNames
    this.setReady = setReady
    this.listeners = new Set()
  }

  managedNames() {
    return [...this.registrations.values()].map(({ tool }) => tool.public_name)
  }

  visibleNames(agent) {
    const visible = this.ctx.tools.view(agent).visible
    return new Set([...this.registrations.values()]
      .filter(({ tool, definition }) => visible.get(tool.public_name) === definition)
      .map(({ tool }) => tool.public_name))
  }

  snapshot(agent) {
    const runtime = this.ctx.workbenchRuntime
    const run = runtime.executionRun?.(agent?.session?.id ?? agent?.id)
    const validRun = run?.ownerId === runtime.ownerId && !run?.stopConfirmation?.fenced
      && ['queued', 'running', 'waiting_input'].includes(run?.status)
    const ready = Boolean(runtime.mcpCatalogState?.ready && validRun)
    const allowed = ready ? this.authorizedNames(agent, run) : new Set()
    const plugins = new Map()
    const tools = []
    const stamps = []
    const preferred = new Set(run?.selection?.resource_mentions?.plugins ?? [])
    const selectedTools = new Set(run?.selection?.resource_mentions?.tools ?? [])
    const servers = new Map((runtime.mcpPlugins?.() ?? []).map(server => [server.id, server]))
    const frozenServers = new Map((run?.selection?.mcp_servers ?? []).map(server => [server.id, server]))
    const providerId = tool => `${tool.scope}:mcp:${tool.server_id}`
    const currentByProvider = Map.groupBy([...this.registrations.values()].map(item => item.tool), providerId)
    const frozenByProvider = Map.groupBy(run?.mcpTools ?? [], providerId)
    if (ready) {
      for (const plugin of runtime.mcpPlugins?.() ?? []) {
        // Installation metadata survives recovery even when this run's frozen
        // authorization excludes the recovered tools. This grants no capability.
        const current = currentByProvider.get(plugin.id) ?? []
        const frozenServer = frozenServers.get(plugin.id)
        const previous = typeof frozenServer?.version === 'string' && typeof frozenServer?.manifest_version === 'string'
          ? [frozenServer] : frozenByProvider.get(plugin.id) ?? []
        const version = plugin.version ?? current[0]?.version
        const manifest = plugin.manifest_version ?? current[0]?.manifest_version ?? ''
        const unavailableReason = previous.some(binding => version !== undefined && version !== binding.version)
          ? 'configuration_changed'
          : previous.some(binding => manifest !== (binding.manifest_version ?? ''))
            ? 'tool_definitions_changed'
            : !previous.length && (current.length || plugin.capabilities?.resources)
              && !current.some(tool => allowed.has(tool.public_name)) ? 'run_authorization_required' : undefined
        plugins.set(plugin.id, { ...plugin,
          ...(plugin.available !== false && unavailableReason ? { available: false, unavailableReason } : {}),
          preferred: preferred.has(plugin.id) || preferred.has(plugin.name) })
      }
    }
    for (const { tool } of this.registrations.values())
      if (selectedTools.has(tool.id)) preferred.add(`${tool.scope}:mcp:${tool.server_id}`)
    for (const { tool, definition } of this.registrations.values()) {
      if (!allowed.has(tool.public_name)) continue
      const pluginId = `${tool.scope}:mcp:${tool.server_id}`
      if (plugins.get(pluginId)?.unavailableReason) continue
      const server = servers.get(pluginId)
      const taskUnavailable = tool.execution?.taskSupport === 'required' && (!runtime.database
        || server?.version !== tool.version || server?.manifest_version !== tool.manifest_version
        || server?.available === false || taskCapabilities(server).generation === 'none')
      const order = plugins.get(pluginId)?.order_num ?? tool.order_num
      plugins.set(pluginId, {
        id: pluginId, name: tool.provider_call_name ?? tool.server_id,
        displayName: tool.provider_name ?? tool.server_id,
        scope: tool.scope, description: tool.provider_description ?? '',
        ...(tool.scope === 'global' && order !== undefined ? { order_num: order } : {}),
        preferred: preferred.has(pluginId) || preferred.has(tool.provider_call_name ?? tool.server_id),
      })
      tools.push({ id: tool.id, name: tool.public_name, rawName: tool.tool_name, pluginId,
        pluginName: tool.provider_name ?? tool.server_id, pluginCallName: tool.provider_call_name ?? tool.server_id,
        pluginScope: tool.scope, description: tool.description,
        version: tool.version, manifestVersion: tool.manifest_version,
        parameters: definition.parameters, inputSchema: tool.sourceInputSchema,
        outputSchema: tool.outputSchema, annotations: tool.annotations, execution: tool.execution,
        ...(taskUnavailable ? { unavailableReason: 'task_capability_unavailable' } : {}) })
      stamps.push([tool.id, tool.discoveryStamp, taskUnavailable])
    }
    if (ready) for (const issue of runtime.mcpCatalogIssues?.() ?? []) {
      const pluginId = `${issue.scope}:mcp:${issue.server_id}`
      if (!plugins.has(pluginId)) continue
      tools.push({ id: issue.id, name: `unavailable_${createHash('sha256').update(issue.id).digest('hex').slice(0, 24)}`,
        rawName: issue.tool_name, pluginId, pluginCallName: plugins.get(pluginId).name,
        description: issue.description, version: issue.version ?? '',
        parameters: { type: 'object', properties: {} }, unavailableReason: issue.reason })
      stamps.push([issue.id, issue.reason])
    }
    tools.sort((a, b) => a.id.localeCompare(b.id))
    const authorityKey = validRun ? `${runtime.ownerId}\0${run.id}` : ''
    stamps.sort((a, b) => a[0].localeCompare(b[0]))
    // Personal card order is presentation only, not a capability change.
    const pluginStamps = [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id))
    const revision = createHash('sha256').update(JSON.stringify([authorityKey, ready, stamps, [...preferred].sort(), pluginStamps]))
      .digest('hex')
    return { authorityKey, revision, ready, tools, plugins: [...plugins.values()] }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify() {
    for (const listener of this.listeners) listener()
  }

  setDiscoveryReady(ready) { this.setReady(Boolean(ready)) }
}
