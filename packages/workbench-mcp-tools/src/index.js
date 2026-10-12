import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { adaptInputSchema } from './schema.js'
import { platformToolNames } from './names.js'

export const name = 'workbench-mcp-tools'
export const inject = ['tools', 'workbenchPlatformClient', 'workbenchRuntime']

// Java and the manager reject absolute deadlines more than 350 seconds ahead
// of their own clocks. Reserve clock skew inside that limit, not above it.
const MCP_CALL_TIMEOUT_MS = 350_000 - 5_000

export async function apply(ctx) {
  const registrations = new Map()
  ctx.workbenchRuntime.mcpResources = () => [...registrations.values()].map(({ tool }) => ({ ...tool }))
  const restrictions = new Map()
  let catalogLoaded = false
  let disposed = false
  let inFlight
  let pending = false
  let timer
  const lifetime = new AbortController()
  const state = (ready, error) => {
    ctx.workbenchRuntime.mcpCatalogState = { ready, status: error && ready ? 'degraded' : ready ? 'ready' : 'unavailable', updatedAt: Date.now(),
      ...(error ? { errorCode: error.code ?? `HTTP_${error.status ?? 502}` } : {}) }
  }
  const clear = () => {
    for (const restriction of restrictions.values()) restriction.dispose()
    restrictions.clear()
    for (const registration of registrations.values()) registration.dispose()
    registrations.clear()
  }
  const allowedNames = (agent) => {
    const allowed = new Set()
    if (!ctx.workbenchRuntime.mcpCatalogState?.ready) return allowed
    const run = ctx.workbenchRuntime.executionRun?.(agent?.session?.id ?? agent?.id)
    if (!run || run.ownerId !== ctx.workbenchRuntime.ownerId || !['queued', 'running', 'waiting_input'].includes(run.status)) return allowed
    for (const { tool } of registrations.values()) {
      if ((run.mcpTools ?? []).some(resource => resource.id === tool.id && resource.version === tool.version
        && (resource.manifest_version ?? '') === tool.manifest_version)) allowed.add(tool.public_name)
    }
    return allowed
  }
  const restrictAgent = (agent) => {
    if (!agent?.ctx?.tools?.restrict) return
    const allowed = allowedNames(agent)
    const deny = [...registrations.values()].map(({ tool }) => tool.public_name).filter(name => !allowed.has(name)).sort()
    const stamp = JSON.stringify(deny)
    const previous = restrictions.get(agent)
    if (previous?.stamp === stamp) return
    previous?.dispose()
    restrictions.delete(agent)
    if (deny.length) restrictions.set(agent, { stamp, dispose: agent.ctx.tools.restrict({ deny }) })
  }
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
      if ([401, 403].includes(error?.status) || transient) return
      throw error
    }
    if (disposed) return
    const catalog = normalizeCatalog(payload.data?.tools ?? payload.tools ?? [])
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
        call: (args, exec) => callProxy(ctx, tool, args, exec),
      })
      registrations.set(tool.runtime_name, { tool, definition, dispose: ctx.tools.register(definition) })
    }
    catalogLoaded = true
    state(true)
    for (const agent of ctx.workbenchRuntime.agents?.list?.() ?? []) restrictAgent(agent)
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
  if (!ctx.workbenchRuntime.mcpCatalogState?.ready)
    throw Object.assign(new Error('MCP 工具目录暂不可用，请稍后重试'), { status: 503, code: 'MCP_CATALOG_UNAVAILABLE' })
  const sessionId = exec.agent?.session?.id ?? exec.agent?.id
  const authorization = ctx.workbenchRuntime.authorizeMcp(sessionId, tool.id, tool.version)
  if (!authorization) throw new Error('MCP tool is not authorized for the active run; select this tool before submitting a new task')
  if ((authorization.resource?.manifest_version ?? '') !== tool.manifest_version)
    throw new Error('MCP tool definition has changed; submit a new task to use the current definition')
  if (typeof exec.callId !== 'string' || !exec.callId.trim()) throw new Error('MCP callId is required to correlate this call')
  tool.validateArguments(args)
  const deadlineMs = Math.min(Number.isSafeInteger(exec.deadlineMs) ? exec.deadlineMs : Infinity, Date.now() + MCP_CALL_TIMEOUT_MS)
  const payload = await ctx.workbenchPlatformClient.json({
    owner: { ownerId: authorization.ownerId }, method: 'POST', route: 'mcp/call',
    contentType: 'application/json',
    signal: exec.signal, timeoutMs: MCP_CALL_TIMEOUT_MS, deadlineMs,
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
    return { ...tool, definitionStamp: JSON.stringify(tool), inputSchema: adapted.schema, validateArguments: adapted.validate, manifest_version: tool.manifest_version ?? '' }
  })
  const names = platformToolNames(tools)
  return tools.map(tool => ({ ...tool, public_name: names.get(tool.id),
    definitionStamp: JSON.stringify([tool.definitionStamp, names.get(tool.id)]) }))
}
