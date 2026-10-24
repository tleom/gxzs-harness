/** Register resource providers in the native DSH agent scope. */
export function resourceScopes(ctx) {
  const scopes = new Map()
  const dispose = agent => { scopes.get(agent)?.dispose(); scopes.delete(agent) }
  const sync = (agent, plugins) => {
    const registry = agent?.ctx?.get?.('mcpResources')
    const prompt = agent?.ctx?.get?.('systemPrompt')
    if (!registry && !prompt) return
    const runtime = ctx.workbenchRuntime
    const run = runtime.executionRun?.(agent.session?.id ?? agent.id)
    const frozen = run?.selection?.mcp_servers ?? []
    const current = new Map(plugins.map(server => [server.id, server]))
    const servers = runtime.mcpCatalogState?.ready && run?.ownerId === runtime.ownerId
      && !run.stopConfirmation?.fenced && ['queued', 'running', 'waiting_input'].includes(run.status)
      ? frozen.filter(server => current.get(server.id)?.available !== false
        && current.get(server.id)?.version === server.version
        && current.get(server.id)?.manifest_version === server.manifest_version) : []
    const stamp = JSON.stringify([run?.id, servers])
    if (scopes.get(agent)?.stamp === stamp) return
    dispose(agent)
    const disposers = []
    try {
      for (const server of servers) {
        // The platform identity is unique even when personal/global display names match.
        if (registry && server.capabilities?.resources) disposers.push(registry.register(server.id, { request: async (request, exec) => {
          exec.signal?.throwIfAborted()
          const authorization = await runtime.authorizeMcpCall(exec.agent?.session?.id ?? exec.agent?.id,
            server.id, server.version, exec.signal)
          if (!authorization || authorization.runId !== run.id
            || authorization.resource.manifest_version !== server.manifest_version)
            throw new Error('MCP 资源不属于当前任务，或插件已改变')
          const { method, ...params } = request
          const timeoutMs = Math.ceil((runtime.mcpPolicy?.max_call_seconds ?? 350) * 1000)
          const deadlineMs = Date.now() + timeoutMs
          const payload = await ctx.workbenchPlatformClient.json({ owner: { ownerId: authorization.ownerId },
            method: 'POST', route: 'mcp/request', contentType: 'application/json', signal: exec.signal,
            timeoutMs, deadlineMs,
            body: Buffer.from(JSON.stringify({ server_id: server.id, version: server.version,
              manifest_version: server.manifest_version, run_id: run.id, request_key: exec.callId,
              method, params, deadline_ms: deadlineMs })) })
          return payload.data ?? payload
        } }))
        if (prompt && typeof server.instructions === 'string' && server.instructions.trim()) {
          disposers.push(prompt.section({ name: `mcp:${server.id}`, order: prompt.getSectionOrder('MCP_SERVERS'),
            interpolate: false, text: () => `### MCP server: ${server.id}\n\n${server.instructions.trimEnd()}` }))
        }
      }
      scopes.set(agent, { stamp, dispose: () => { for (const stop of disposers) stop() } })
    } catch (error) { for (const stop of disposers) stop(); throw error }
  }
  return { sync, dispose, clear: () => { for (const agent of scopes.keys()) dispose(agent) } }
}
