import { Service } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'

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
    if (ready) {
      const providersWithTools = new Set([...this.registrations.values()].map(({ tool }) => `${tool.scope}:mcp:${tool.server_id}`))
      for (const plugin of runtime.mcpPlugins?.() ?? []) {
        // Installation metadata survives recovery even when this run's frozen
        // authorization excludes the recovered tools. This grants no capability.
        const requiresAuthorization = plugin.available !== false && providersWithTools.has(plugin.id)
        plugins.set(plugin.id, { ...plugin,
          ...(requiresAuthorization ? { available: false, unavailableReason: 'run_authorization_required' } : {}),
          preferred: preferred.has(plugin.id) || preferred.has(plugin.name) })
      }
    }
    for (const { tool } of this.registrations.values())
      if (selectedTools.has(tool.id)) preferred.add(`${tool.scope}:mcp:${tool.server_id}`)
    for (const { tool, definition } of this.registrations.values()) {
      if (!allowed.has(tool.public_name)) continue
      const pluginId = `${tool.scope}:mcp:${tool.server_id}`
      plugins.set(pluginId, {
        id: pluginId, name: tool.provider_call_name ?? tool.server_id,
        displayName: tool.provider_name ?? tool.server_id,
        scope: tool.scope, description: tool.provider_description ?? '',
        preferred: preferred.has(pluginId) || preferred.has(tool.provider_call_name ?? tool.server_id),
      })
      tools.push({ id: tool.id, name: tool.public_name, rawName: tool.tool_name, pluginId,
        pluginName: tool.provider_name ?? tool.server_id, pluginCallName: tool.provider_call_name ?? tool.server_id,
        pluginScope: tool.scope, description: tool.description,
        version: tool.version, manifestVersion: tool.manifest_version,
        parameters: definition.parameters, inputSchema: tool.sourceInputSchema,
        outputSchema: tool.outputSchema, annotations: tool.annotations, execution: tool.execution,
        ...(tool.execution?.taskSupport === 'required' ? { unavailableReason: 'task_execution_required' } : {}) })
      stamps.push([tool.id, tool.discoveryStamp])
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
