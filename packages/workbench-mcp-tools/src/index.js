import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { adaptInputSchema } from './schema.js'

export const name = 'workbench-mcp-tools'
export const inject = ['tools', 'workbenchPlatformClient', 'workbenchRuntime']

export async function apply(ctx) {
  const registrations = new Map()
  const sync = async () => {
    let payload
    try {
      payload = await ctx.workbenchPlatformClient.json({
        owner: { ownerId: ctx.workbenchRuntime.ownerId }, method: 'GET', route: 'mcp/catalog',
      })
    } catch (error) {
      if ([502, 503].includes(error?.status)) payload = { tools: [] }
      else throw error
    }
    const catalog = normalizeCatalog(payload.data?.tools ?? payload.tools ?? [])
    const desired = new Map(catalog.map((tool) => [tool.runtime_name, tool]))
    for (const [runtimeName, registration] of registrations) {
      const next = desired.get(runtimeName)
      if (!next || next.id !== registration.tool.id || next.version !== registration.tool.version) {
        registration.dispose()
        registrations.delete(runtimeName)
      }
    }
    for (const tool of catalog) {
      if (registrations.has(tool.runtime_name)) continue
      const definition = createMcpToolDefinition(ctx, {
        name: tool.runtime_name,
        rawName: tool.tool_name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        call: (args, exec) => callProxy(ctx, tool, args, exec),
      })
      registrations.set(tool.runtime_name, { tool, dispose: ctx.tools.register(definition) })
    }
  }
  await sync()
  const refresh = () => sync().catch((error) => ctx.logger.warn(`MCP catalog refresh failed: ${String(error)}`))
  ctx.on('workbench/resources-changed', refresh)
  ctx.effect(() => () => {
    for (const registration of registrations.values()) registration.dispose()
    registrations.clear()
  }, 'gxzs MCP proxy tools')
}

async function callProxy(ctx, tool, args, exec) {
  const sessionId = exec.agent?.session?.id ?? exec.agent?.id
  const authorization = ctx.workbenchRuntime.authorizeMcp(sessionId, tool.id, tool.version)
  if (!authorization) throw new Error('MCP tool is not authorized for the active run')
  tool.validateArguments(args)
  const payload = await ctx.workbenchPlatformClient.json({
    owner: { ownerId: authorization.ownerId }, method: 'POST', route: 'mcp/call',
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({
      run_id: authorization.runId, resource_id: tool.id, version: tool.version,
      manifest_version: tool.manifest_version, server_id: tool.server_id,
      tool_name: tool.tool_name, request_key: String(exec.callId), arguments: args,
    })),
  })
  return payload.data?.result ?? payload.result ?? payload.data ?? payload
}

function normalizeCatalog(value) {
  if (!Array.isArray(value)) throw new Error('platform MCP catalog must be an array')
  const names = new Set()
  return value.map((tool) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('invalid MCP tool')
    for (const key of ['id', 'runtime_name', 'version', 'scope', 'server_id', 'tool_name', 'description', 'inputSchema'])
      if (tool[key] === undefined) throw new Error(`MCP tool is missing ${key}`)
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(tool.runtime_name) || names.has(tool.runtime_name)) throw new Error('MCP runtime names must be valid and unique')
    if (!['global', 'personal'].includes(tool.scope) || typeof tool.version !== 'string' || !tool.version) throw new Error('invalid MCP scope or version')
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) throw new Error('invalid MCP input schema')
    const adapted = adaptInputSchema(tool.inputSchema)
    assertObjectJsonSchema(adapted.schema)
    names.add(tool.runtime_name)
    return { ...tool, inputSchema: adapted.schema, validateArguments: adapted.validate, manifest_version: tool.manifest_version ?? '' }
  })
}
