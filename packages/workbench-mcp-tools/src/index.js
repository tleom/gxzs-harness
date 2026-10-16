import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { adaptInputSchema } from './schema.js'
import { platformToolNames } from './names.js'
import { ToolDiscoveryCatalog } from './discovery-catalog.js'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'

export const name = 'workbench-mcp-tools'
export const inject = ['tools', 'workbenchPlatformClient', 'workbenchRuntime']
export const Config = z.object({ discovery: z.boolean().default(false) })

// Java and the manager reject absolute deadlines more than 350 seconds ahead
// of their own clocks. Reserve clock skew inside that limit, not above it.
const MCP_CALL_TIMEOUT_MS = 350_000 - 5_000
// Providers may serialize identical nested schema objects in a different order.
// Keep registration identity stable without discarding any definition fields.
const definitionStamp = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)

export async function apply(ctx, config = {}) {
  const registrations = new Map()
  let pluginMetadata = []
  ctx.workbenchRuntime.mcpResources = () => [...registrations.values()].map(({ tool }) => ({ ...tool }))
  ctx.workbenchRuntime.mcpPlugins = () => pluginMetadata.map(plugin => ({ ...plugin }))
  const restrictions = new Map()
  let catalogLoaded = false
  let disposed = false
  let inFlight
  let pending = false
  let timer
  let discoveryReady = false
  let discoveryCatalog
  const lifetime = new AbortController()
  const state = (ready, error) => {
    ctx.workbenchRuntime.mcpCatalogState = { ready, status: error && ready ? 'degraded' : ready ? 'ready' : 'unavailable', updatedAt: Date.now(),
      ...(error ? { errorCode: error.code ?? `HTTP_${error.status ?? 502}` } : {}) }
    discoveryCatalog?.notify()
  }
  const clear = () => {
    pluginMetadata = []
    for (const restriction of restrictions.values()) restriction.dispose()
    restrictions.clear()
    for (const registration of registrations.values()) registration.dispose()
    registrations.clear()
  }
  const allowedNames = (agent, currentRun) => {
    const allowed = new Set()
    if (!ctx.workbenchRuntime.mcpCatalogState?.ready) return allowed
    const run = currentRun ?? ctx.workbenchRuntime.executionRun?.(agent?.session?.id ?? agent?.id)
    if (!run || run.ownerId !== ctx.workbenchRuntime.ownerId || run.stopConfirmation?.fenced
      || !['queued', 'running', 'waiting_input'].includes(run.status)) return allowed
    const resources = new Map((run.mcpTools ?? []).map(resource => [resource.id, resource]))
    for (const { tool } of registrations.values()) {
      const resource = resources.get(tool.id)
      if (resource?.version === tool.version && (resource.manifest_version ?? '') === tool.manifest_version)
        allowed.add(tool.public_name)
    }
    return allowed
  }
  const restrictAgent = (agent) => {
    if (!agent?.ctx?.tools?.restrict) return
    const allowed = config.discovery && !discoveryReady ? new Set() : allowedNames(agent)
    const deny = [...registrations.values()].map(({ tool }) => tool.public_name).filter(name => !allowed.has(name)).sort()
    const stamp = JSON.stringify(deny)
    const previous = restrictions.get(agent)
    if (previous?.stamp === stamp) return
    const replacement = deny.length ? { stamp, dispose: agent.ctx.tools.restrict({ deny }) } : undefined
    previous?.dispose()
    restrictions.delete(agent)
    if (replacement) restrictions.set(agent, replacement)
  }
  discoveryCatalog = new ToolDiscoveryCatalog(ctx, { registrations, authorizedNames: allowedNames,
    setReady: ready => {
      if (discoveryReady === ready) return
      discoveryReady = ready
      for (const agent of ctx.workbenchRuntime.agents?.list?.() ?? []) restrictAgent(agent)
      discoveryCatalog.notify()
    } })
  ctx.workbenchRuntime.restrictMcpScope = restrictAgent
  const toolForName = name => [...registrations.values()].find(item => item.tool.public_name === name)?.tool
  ctx.workbenchRuntime.mcpToolForName = toolForName
  state(false)
  const sync = async () => {
    let payload
    try {
      payload = await ctx.workbenchPlatformClient.json({
        owner: { ownerId: ctx.workbenchRuntime.ownerId }, method: 'GET', route: 'mcp/catalog',
        signal: lifetime.signal, timeoutMs: 15_000,
      })
    } catch (error) {
      const transient = [502, 503, 504].includes(error?.status) || ['TypeError', 'TimeoutError'].includes(error?.name)
      state(transient && catalogLoaded, error)
      // Bootstrap can precede platform host registration. Keep the plugin alive
      // to recover after registration, but never retain tools on denied access.
      if ([401, 403].includes(error?.status)) { catalogLoaded = false; clear() }
      for (const agent of ctx.workbenchRuntime.agents?.list?.() ?? []) restrictAgent(agent)
      discoveryCatalog.notify()
      if ([401, 403].includes(error?.status) || transient) return
      throw error
    }
    if (disposed) return
    const catalog = normalizeCatalog(payload.data?.tools ?? payload.tools ?? [])
    const plugins = payload.data?.plugins ?? payload.plugins ?? []
    if (!Array.isArray(plugins) || plugins.some(plugin => !plugin || typeof plugin.id !== 'string' || typeof plugin.name !== 'string'
      || !['global', 'personal'].includes(plugin.scope))) throw new Error('invalid MCP plugin inventory')
    // A provider may not replace an existing native capability with its raw name.
    for (const tool of catalog) {
      const existing = ctx.tools.get?.(tool.public_name)
      if (existing && ![...registrations.values()].some(item => item.definition === existing))
        throw new Error('MCP public tool name conflicts with an existing tool')
    }
    const desired = new Map(catalog.map((tool) => [tool.runtime_name, tool]))
    for (const [runtimeName, registration] of registrations) {
      const next = desired.get(runtimeName)
      if (!next || next.id !== registration.tool.id || next.version !== registration.tool.version
        || next.manifest_version !== registration.tool.manifest_version
        || next.definitionStamp !== registration.tool.definitionStamp) {
        registration.dispose()
        registrations.delete(runtimeName)
      }
    }
    for (const tool of catalog) {
      if (registrations.has(tool.runtime_name)) continue
      const definition = createMcpToolDefinition(ctx, {
        name: tool.public_name,
        rawName: tool.tool_name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        taskRequired: tool.execution?.taskSupport === 'required',
        call: (args, exec) => callProxy(ctx, tool, args, exec),
      })
      registrations.set(tool.runtime_name, { tool, definition, dispose: ctx.tools.register(definition) })
    }
    pluginMetadata = plugins
    catalogLoaded = true
    state(true)
    for (const agent of ctx.workbenchRuntime.agents?.list?.() ?? []) restrictAgent(agent)
    discoveryCatalog.notify()
  }
  const synchronize = () => {
    if (disposed) return Promise.resolve()
    pending = true
    if (inFlight) return inFlight
    inFlight = (async () => {
      do { pending = false; await sync() } while (pending && !disposed)
    })().catch((error) => { catalogLoaded = false; state(false, error); throw error }).finally(() => { inFlight = undefined })
    return inFlight
  }
  const refresh = () => synchronize().catch((error) => ctx.logger.warn(`MCP catalog refresh failed (${error.code ?? error.status ?? 'invalid-catalog'})`))
  const schedule = () => {
    timer = setTimeout(async () => {
      await refresh()
      if (!disposed) schedule()
    }, ctx.workbenchRuntime.mcpCatalogState.status === 'ready' ? 30_000 : 5_000)
    timer.unref?.()
  }
  ctx.on('workbench/resources-changed', refresh)
  // Inbox claiming precedes native prompt assembly. Keep native and PTC views
  // scoped to the run's immutable selection, including owned child agents.
  ctx.on('agent/created', ({ agent }) => { restrictAgent(agent) }, { global: true })
  ctx.on('agent/inbox/claimed', ({ agent }) => { restrictAgent(agent) }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    restrictions.get(agent)?.dispose()
    restrictions.delete(agent)
  }, { global: true })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    restrictAgent(context.scope)
    const assembly = await next()
    const allowed = allowedNames(context.scope)
    const mcpNames = new Set([...registrations.values()].map(({ tool }) => tool.public_name))
    const providers = new Map()
    for (const { tool } of registrations.values()) {
      if (config.discovery) break
      if (!allowed.has(tool.public_name)) continue
      const key = `${tool.scope}:${tool.server_id}`
      if (!providers.has(key)) providers.set(key, {
        name: tool.provider_call_name ?? tool.server_id,
        displayName: tool.provider_name ?? tool.server_id,
        description: tool.provider_description ?? '',
        tools: [],
      })
      providers.get(key).tools.push(tool.public_name)
    }
    return {
      ...assembly,
      tools: assembly.tools.filter(tool => !mcpNames.has(tool.name) || allowed.has(tool.name)),
      sections: providers.size ? [...assembly.sections, {
        name: 'gxzs:mcp-provider-catalog',
        text: `当前可用 MCP 插件（调用名、展示名、用途和已注册子工具）：\n${JSON.stringify([...providers.values()])}\n按任务选择真实子工具；用户说出插件调用名或展示名时，可据此找到对应子工具。`,
        interpolate: false,
      }] : assembly.sections,
    }
  }, { global: true })
  ctx.effect(() => () => {
    disposed = true
    if (ctx.workbenchRuntime.restrictMcpScope === restrictAgent) ctx.workbenchRuntime.restrictMcpScope = undefined
    if (ctx.workbenchRuntime.mcpToolForName === toolForName) ctx.workbenchRuntime.mcpToolForName = undefined
    lifetime.abort()
    clearTimeout(timer)
    clear()
    state(false)
  }, 'gxzs MCP proxy tools')
  await synchronize()
  schedule()
}

async function callProxy(ctx, tool, args, exec) {
  exec.signal?.throwIfAborted()
  const deadlineMs = Math.min(Number.isSafeInteger(exec.deadlineMs) ? exec.deadlineMs : Infinity, Date.now() + MCP_CALL_TIMEOUT_MS)
  if (deadlineMs <= Date.now()) throw new DOMException('MCP call deadline exceeded', 'TimeoutError')
  const signal = AbortSignal.any([...(exec.signal ? [exec.signal] : []), AbortSignal.timeout(Math.max(0, deadlineMs - Date.now()))])
  if (!ctx.workbenchRuntime.mcpCatalogState?.ready)
    throw Object.assign(new Error('MCP 工具目录暂不可用，请稍后重试'), { status: 503, code: 'MCP_CATALOG_UNAVAILABLE' })
  const sessionId = exec.agent?.session?.id ?? exec.agent?.id
  const authorization = await ctx.workbenchRuntime.authorizeMcpCall(sessionId, tool.id, tool.version, signal)
  signal.throwIfAborted()
  if (deadlineMs <= Date.now()) throw new DOMException('MCP call deadline exceeded', 'TimeoutError')
  if (!ctx.workbenchRuntime.mcpCatalogState?.ready)
    throw Object.assign(new Error('MCP 工具目录暂不可用，请稍后重试'), { status: 503, code: 'MCP_CATALOG_UNAVAILABLE' })
  if (!authorization) throw new Error('MCP tool is not authorized for the active run; select this tool before submitting a new task')
  if ((authorization.resource?.manifest_version ?? '') !== tool.manifest_version)
    throw new Error('MCP tool definition has changed; submit a new task to use the current definition')
  if (typeof exec.callId !== 'string' || !exec.callId.trim()) throw new Error('MCP callId is required to correlate this call')
  tool.validateArguments(args)
  const payload = await ctx.workbenchPlatformClient.json({
    owner: { ownerId: authorization.ownerId }, method: 'POST', route: 'mcp/call',
    contentType: 'application/json',
    signal, timeoutMs: MCP_CALL_TIMEOUT_MS, deadlineMs,
    body: Buffer.from(JSON.stringify({
      run_id: authorization.runId, resource_id: tool.id, version: tool.version,
      manifest_version: tool.manifest_version, server_id: tool.server_id,
      tool_name: tool.tool_name, request_key: exec.callId, arguments: args, deadline_ms: deadlineMs,
    })),
  })
  const response = payload?.data?.result ?? payload?.result ?? payload?.data ?? payload
  // Personal MCP responses have an extra manager envelope; global MCP responses do not.
  const result = Array.isArray(response?.content) ? response : response?.result
  if (Array.isArray(result?.content)) return result
  if (typeof response?.error === 'string') throw new Error(response.error)
  throw new Error('Platform MCP response is missing CallToolResult.content')
}

function normalizeCatalog(value) {
  if (!Array.isArray(value)) throw new Error('platform MCP catalog must be an array')
  const runtimeNames = new Set()
  const ids = new Set()
  const tools = value.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('invalid MCP tool')
    for (const key of ['id', 'runtime_name', 'version', 'scope', 'server_id', 'tool_name', 'description', 'inputSchema'])
      if (tool[key] === undefined) throw new Error(`MCP tool is missing ${key}`)
    if (typeof tool.id !== 'string' || !tool.id || ids.has(tool.id) || typeof tool.server_id !== 'string' || !tool.server_id || typeof tool.tool_name !== 'string' || !tool.tool_name || typeof tool.description !== 'string') throw new Error('invalid or duplicate MCP tool identity')
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(tool.runtime_name) || runtimeNames.has(tool.runtime_name)) throw new Error('MCP runtime names must be valid and unique')
    if (!['global', 'personal'].includes(tool.scope) || typeof tool.version !== 'string' || !tool.version) throw new Error('invalid MCP scope or version')
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw new Error('invalid MCP input schema')
    const adapted = adaptInputSchema(tool.inputSchema)
    runtimeNames.add(tool.runtime_name)
    ids.add(tool.id)
    return { ...tool, definitionStamp: definitionStamp(tool), sourceInputSchema: tool.inputSchema, inputSchema: adapted.schema, validateArguments: adapted.validate, manifest_version: tool.manifest_version ?? '' }
  })
  const names = platformToolNames(tools)
  return tools.map(tool => {
    const definitionStamp = JSON.stringify([tool.definitionStamp, names.get(tool.id)])
    return { ...tool, public_name: names.get(tool.id), definitionStamp,
      discoveryStamp: createHash('sha256').update(definitionStamp).digest('hex') }
  })
}
