import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { McpTaskJournal, executeMcpTask } from './tasks.js'
import { isTaskRecoveryName, taskRecoveryScopes } from './task-recovery.js'
import { resourceScopes } from './resources.js'
import { mcpDeadline } from './deadline.js'
import { adaptInputSchema } from './schema.js'
import { platformToolNames } from './names.js'
import { ToolDiscoveryCatalog } from './discovery-catalog.js'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'

export const name = 'workbench-mcp-tools'
export const inject = ['tools', 'workbenchPlatformClient', 'workbenchRuntime']
export const Config = z.object({ discovery: z.boolean().default(false) })

// Providers may serialize identical nested schema objects in a different order.
// Keep registration identity stable without discarding any definition fields.
const definitionStamp = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)

export async function apply(ctx, config = {}) {
  const registrations = new Map()
  const resources = resourceScopes(ctx)
  const journal = ctx.workbenchRuntime.database ? new McpTaskJournal(ctx.workbenchRuntime.database) : undefined
  const recovery = taskRecoveryScopes(ctx, journal, (record, exec) => {
    const tool = [...registrations.values()].find(item => item.tool.id === record.resourceId)?.tool
    if (!tool) throw new Error('MCP 任务工具已不可用')
    return callProxy(ctx, tool, record.args, exec, { task: true, recovery: record, journal })
  })
  let pluginMetadata = []
  let catalogIssues = []
  ctx.workbenchRuntime.mcpCatalogIssues = () => catalogIssues
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
    resources.clear()
    recovery.clear()
    pluginMetadata = []
    catalogIssues = []
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
    resources.sync(agent, pluginMetadata)
    recovery.sync(agent)
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
      const currentPolicy = ctx.workbenchPlatformClient.loadMcpPolicy
        ? await ctx.workbenchPlatformClient.loadMcpPolicy({ ownerId: ctx.workbenchRuntime.ownerId }, lifetime.signal)
        : undefined
      if (currentPolicy) {
        ctx.workbenchRuntime.mcpPolicy = currentPolicy
        ctx.get?.('workbenchFileManager')?.setMcpPolicy?.(currentPolicy)
      }
      const deadline = Date.now() + Math.ceil((ctx.workbenchRuntime.mcpPolicy?.catalog_timeout_seconds ?? 180) * 1000)
      payload = await ctx.workbenchPlatformClient.json({
        owner: { ownerId: ctx.workbenchRuntime.ownerId }, method: 'GET', route: 'mcp/catalog',
        signal: lifetime.signal, timeoutMs: Math.max(1, deadline - Date.now()), deadlineMs: deadline,
      })

    } catch (error) {
      const transient = [500, 502, 503, 504].includes(error?.status) || ['TypeError', 'TimeoutError'].includes(error?.name)
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
    const policy = payload.data?.policy ?? payload.policy
    if (policy && typeof policy === 'object' && ['request_bytes', 'response_bytes', 'max_call_seconds', 'catalog_timeout_seconds'].every(key => Number.isFinite(policy[key]) && policy[key] > 0)) {
      ctx.workbenchRuntime.mcpPolicy = Object.freeze({ ...policy })
      ctx.workbenchPlatformClient.mcpPolicy = ctx.workbenchRuntime.mcpPolicy
      ctx.get?.('workbenchFileManager')?.setMcpPolicy?.(policy)
    }
    const catalog = normalizeCatalog(payload.data?.tools ?? payload.tools ?? [], name => {
      if (isTaskRecoveryName(name) || ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(name)) return true
      const existing = ctx.tools.get?.(name)
      return Boolean(existing && ![...registrations.values()].some(item => item.definition === existing))
    }, registrations)
    catalogIssues = catalog.issues ?? []
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
        taskCall: (args, exec) => callProxy(ctx, tool, args, exec, { task: true, journal }),
      })
      registrations.set(tool.runtime_name, { tool, definition, dispose: ctx.tools.register(definition) })
    }
    // A refresh can move one provider without replacing the others. Rebuild the
    // iteration order from the published catalog while retaining registrations.
    const ordered = catalog.map(tool => [tool.runtime_name, registrations.get(tool.runtime_name)])
    registrations.clear()
    for (const [runtimeName, registration] of ordered) registrations.set(runtimeName, registration)
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
  const refreshForAdmission = async () => {
    // Concurrent admissions share the current refresh. Only a resource-change
    // event needs to request another pass while that refresh is in flight.
    await (inFlight ?? synchronize())
    if (disposed || ctx.workbenchRuntime.mcpCatalogState?.status !== 'ready')
      throw Object.assign(new Error('MCP 工具目录暂不可用，请稍后重试'), { status: 503, code: 'MCP_CATALOG_UNAVAILABLE' })
    const tools = [...registrations.values()].map(({ tool }) => {
      const { public_name, definitionStamp, discoveryStamp, sourceInputSchema, validateArguments, ...resource } = tool
      return { ...resource, runtime_name: public_name, inputSchema: sourceInputSchema }
    })
    return { tools, plugins: pluginMetadata.map(server => ({ ...server })) }
  }
  // Admission freezes the same verified definitions that native discovery uses,
  // rather than a separate platform read ahead of the periodic registration sync.
  ctx.workbenchRuntime.refreshMcpCatalog = refreshForAdmission
  const schedule = () => {
    timer = setTimeout(async () => {
      await refresh()
      if (!disposed) schedule()
    }, (ctx.workbenchRuntime.mcpCatalogState.status === 'ready'
      ? ctx.workbenchRuntime.mcpPolicy?.refresh_interval_seconds ?? 30
      : ctx.workbenchRuntime.mcpPolicy?.refresh_failure_seconds ?? 5) * 1000)
    timer.unref?.()
  }
  ctx.on('workbench/resources-changed', refresh)
  // Inbox claiming precedes native prompt assembly. Keep native and PTC views
  // scoped to the run's immutable selection, including owned child agents.
  ctx.on('agent/created', ({ agent }) => { restrictAgent(agent) }, { global: true })
  ctx.on('agent/inbox/claimed', ({ agent }) => { restrictAgent(agent) }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    resources.dispose(agent)
    recovery.dispose(agent)
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
    if (ctx.workbenchRuntime.refreshMcpCatalog === refreshForAdmission) ctx.workbenchRuntime.refreshMcpCatalog = undefined
    if (ctx.workbenchRuntime.restrictMcpScope === restrictAgent) ctx.workbenchRuntime.restrictMcpScope = undefined
    if (ctx.workbenchRuntime.mcpToolForName === toolForName) ctx.workbenchRuntime.mcpToolForName = undefined
    lifetime.abort()
    clearTimeout(timer)
    clear()
    state(false)
  }, 'gxzs MCP proxy tools')
  // An invalid first catalog must fail admission, while keeping the refresh
  // loop alive so a repaired provider can recover without restarting the Host.
  await refresh()
  schedule()
}

async function callProxy(ctx, tool, args, exec, { task = false, recovery, journal } = {}) {
  exec.signal?.throwIfAborted()
  const taskDeadlineMs = mcpDeadline(ctx.workbenchRuntime.mcpPolicy, exec)
  const controlTimeoutMs = Math.ceil((ctx.workbenchRuntime.mcpPolicy?.control_timeout_seconds ?? 15) * 1000)
  const cleanupMs = task ? Math.max(0, Math.min(controlTimeoutMs, 5_000, Math.floor((taskDeadlineMs - Date.now()) / 10))) : 0
  const deadlineMs = taskDeadlineMs - cleanupMs
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
  if (task) {
    const runtime = ctx.workbenchRuntime
    const server = runtime.mcpPlugins().find(server => server.id === `${tool.scope}:mcp:${tool.server_id}`)
    if (!server || server.version !== tool.version || server.manifest_version !== tool.manifest_version) throw new Error('MCP 任务能力已改变')
    // Tool waiting ends before the provider connection's deadline, leaving bounded time for cancellation.
    return executeMcpTask({ tool, server, args, exec: { ...exec, signal, deadlineMs }, authorization,
      journal, ...(recovery ? { exec: { ...exec, callId: recovery.callId, signal, deadlineMs },
        authorization: { ...authorization, runId: recovery.runId } } : {}), controlTimeoutMs,
      dispatch: async (request, options, ticket) => {
        const cleanup = request.method === 'tasks/cancel'
        const dispatchSignal = cleanup ? options?.signal : AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])])
        const response = await ctx.workbenchPlatformClient.json({ owner: { ownerId: authorization.ownerId },
          method: 'POST', route: 'mcp/task', contentType: 'application/json', signal: dispatchSignal,
          timeoutMs: Math.max(1, (cleanup ? taskDeadlineMs : deadlineMs) - Date.now()), deadlineMs: cleanup ? taskDeadlineMs : deadlineMs,
          body: Buffer.from(JSON.stringify({ run_id: recovery?.runId ?? authorization.runId, admission_run_id: authorization.runId, resource_id: tool.id, version: tool.version,
            manifest_version: tool.manifest_version, server_id: tool.server_id, tool_name: tool.tool_name,
            request_key: recovery?.callId ?? exec.callId, method: request.method, params: request.params,
            ...(ticket ? { task_ticket: ticket } : {}), deadline_ms: taskDeadlineMs })) })
        return response.data ?? response
      } })
  }
  const payload = await ctx.workbenchPlatformClient.json({
    owner: { ownerId: authorization.ownerId }, method: 'POST', route: 'mcp/call',
    contentType: 'application/json',
    signal, timeoutMs: Math.max(1, deadlineMs - Date.now()), deadlineMs,
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

function normalizeCatalog(value, reserved, registrations) {
  if (!Array.isArray(value)) throw new Error('platform MCP catalog must be an array')
  const runtimeNames = new Set()
  const ids = new Set()
  const issues = []
  const tools = value.flatMap((tool) => {
    try {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('invalid MCP tool')
    for (const key of ['id', 'runtime_name', 'version', 'scope', 'server_id', 'tool_name', 'description', 'inputSchema'])
      if (tool[key] === undefined) throw new Error(`MCP tool is missing ${key}`)
    if (typeof tool.id !== 'string' || !tool.id || ids.has(tool.id) || typeof tool.server_id !== 'string' || !tool.server_id || typeof tool.tool_name !== 'string' || !tool.tool_name || typeof tool.description !== 'string') throw new Error('invalid or duplicate MCP tool identity')
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(tool.runtime_name) || runtimeNames.has(tool.runtime_name)) throw new Error('MCP runtime names must be valid and unique')
    if (!['global', 'personal'].includes(tool.scope) || typeof tool.version !== 'string' || !tool.version) throw new Error('invalid MCP scope or version')
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw new Error('invalid MCP input schema')
    // Reuse the registered validator only for the identical source schema.
    // Still rebuild the current catalog, aliases and authorization on every read.
    const previous = registrations.get(tool.runtime_name)?.tool
    const adapted = previous?.id === tool.id
      && definitionStamp(previous.sourceInputSchema) === definitionStamp(tool.inputSchema)
      ? { schema: previous.inputSchema, validate: previous.validateArguments }
      : adaptInputSchema(tool.inputSchema)
    runtimeNames.add(tool.runtime_name)
    ids.add(tool.id)
    return [{ ...tool, definitionStamp: definitionStamp(tool), sourceInputSchema: tool.inputSchema, inputSchema: adapted.schema, validateArguments: adapted.validate, manifest_version: tool.manifest_version ?? '' }]
    } catch (error) {
      if (tool && typeof tool.id === 'string' && typeof tool.server_id === 'string' && typeof tool.tool_name === 'string')
        issues.push({ id: tool.id, server_id: tool.server_id, scope: tool.scope, tool_name: tool.tool_name,
          description: typeof tool.description === 'string' ? tool.description : '', version: tool.version,
          reason: error?.code === 'UNSUPPORTED_SCHEMA' ? 'unsupported_schema' : 'invalid_tool_definition' })
      return []
    }
  })
  const names = platformToolNames(tools, reserved)
  const normalized = tools.map(tool => {
    const definitionStamp = JSON.stringify([tool.definitionStamp, names.get(tool.id)])
    return { ...tool, public_name: names.get(tool.id), definitionStamp,
      discoveryStamp: createHash('sha256').update(definitionStamp).digest('hex') }
  })
  normalized.issues = issues
  return normalized
}
