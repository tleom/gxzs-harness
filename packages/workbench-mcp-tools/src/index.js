import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { adaptInputSchema } from './schema.js'
import { platformToolName } from './names.js'

export const name = 'workbench-mcp-tools'
export const inject = ['tools', 'workbenchPlatformClient', 'workbenchRuntime']

export async function apply(ctx) {
  const registrations = new Map()
  let disposed = false
  let inFlight
  let pending = false
  let timer
  const lifetime = new AbortController()
  const state = (ready, error) => {
    ctx.workbenchRuntime.mcpCatalogState = { ready, status: ready ? 'ready' : 'unavailable', updatedAt: Date.now(),
      ...(error ? { errorCode: error.code ?? `HTTP_${error.status ?? 502}` } : {}) }
  }
  const clear = () => {
    for (const registration of registrations.values()) registration.dispose()
    registrations.clear()
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
      state(false, error)
      // Bootstrap can precede platform host registration. Keep the plugin alive
      // to recover after registration, but never retain tools on denied access.
      if ([401, 403].includes(error?.status)) clear()
      if ([401, 403, 502, 503, 504].includes(error?.status) || ['TypeError', 'TimeoutError'].includes(error?.name)) return
      throw error
    }
    if (disposed) return
    const catalog = normalizeCatalog(payload.data?.tools ?? payload.tools ?? [])
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
        name: platformToolName(tool),
        rawName: tool.tool_name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        call: (args, exec) => callProxy(ctx, tool, args, exec),
      })
      registrations.set(tool.runtime_name, { tool, dispose: ctx.tools.register(definition) })
    }
    state(true)
  }
  const synchronize = () => {
    if (disposed) return Promise.resolve()
    pending = true
    if (inFlight) return inFlight
    inFlight = (async () => {
      do { pending = false; await sync() } while (pending && !disposed)
    })().catch((error) => { state(false, error); throw error }).finally(() => { inFlight = undefined })
    return inFlight
  }
  const refresh = () => synchronize().catch((error) => ctx.logger.warn(`MCP catalog refresh failed (${error.code ?? error.status ?? 'invalid-catalog'})`))
  const schedule = () => {
    timer = setTimeout(async () => {
      await refresh()
      if (!disposed) schedule()
    }, ctx.workbenchRuntime.mcpCatalogState.ready ? 30_000 : 5_000)
    timer.unref?.()
  }
  ctx.on('workbench/resources-changed', refresh)
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
  if (!authorization) throw new Error('MCP tool is not authorized for the active run')
  if (typeof exec.callId !== 'string' || !exec.callId.trim()) throw new Error('MCP callId is required for idempotent execution')
  tool.validateArguments(args)
  const deadlineMs = Math.min(Number.isSafeInteger(exec.deadlineMs) ? exec.deadlineMs : Infinity, Date.now() + 350_000)
  const payload = await ctx.workbenchPlatformClient.json({
    owner: { ownerId: authorization.ownerId }, method: 'POST', route: 'mcp/call',
    contentType: 'application/json',
    signal: exec.signal, timeoutMs: 350_000, deadlineMs,
    body: Buffer.from(JSON.stringify({
      run_id: authorization.runId, resource_id: tool.id, version: tool.version,
      manifest_version: tool.manifest_version, server_id: tool.server_id,
      tool_name: tool.tool_name, request_key: exec.callId, arguments: args, deadline_ms: deadlineMs,
    })),
  })
  return payload.data?.result ?? payload.result ?? payload.data ?? payload
}

function normalizeCatalog(value) {
  if (!Array.isArray(value)) throw new Error('platform MCP catalog must be an array')
  const names = new Set()
  const runtimeNames = new Set()
  const ids = new Set()
  return value.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('invalid MCP tool')
    for (const key of ['id', 'runtime_name', 'version', 'scope', 'server_id', 'tool_name', 'description', 'inputSchema'])
      if (tool[key] === undefined) throw new Error(`MCP tool is missing ${key}`)
    if (typeof tool.id !== 'string' || !tool.id || ids.has(tool.id) || typeof tool.server_id !== 'string' || !tool.server_id || typeof tool.tool_name !== 'string' || !tool.tool_name || typeof tool.description !== 'string') throw new Error('invalid or duplicate MCP tool identity')
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(tool.runtime_name) || runtimeNames.has(tool.runtime_name) || names.has(platformToolName(tool))) throw new Error('MCP runtime names must be valid and unique')
    if (!['global', 'personal'].includes(tool.scope) || typeof tool.version !== 'string' || !tool.version) throw new Error('invalid MCP scope or version')
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw new Error('invalid MCP input schema')
    const adapted = adaptInputSchema(tool.inputSchema)
    names.add(platformToolName(tool))
    runtimeNames.add(tool.runtime_name)
    ids.add(tool.id)
    return { ...tool, definitionStamp: JSON.stringify(tool), inputSchema: adapted.schema, validateArguments: adapted.validate, manifest_version: tool.manifest_version ?? '' }
  })
}
