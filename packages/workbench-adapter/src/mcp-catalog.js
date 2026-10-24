/** Non-executable provider metadata used only to resolve user plugin mentions. */
export function mentionProviders(tools, servers = []) {
  return [...tools, ...servers.filter(server => server.available !== false).map(server => ({
    ...server, server_id: server.server_id ?? server.id.split(':').slice(2).join(':'),
    provider_call_name: server.name, provider_name: server.displayName ?? server.name,
  }))]
}
export const runMcpResources = run => [...(run?.mcpTools ?? []), ...(run?.selection?.mcp_servers ?? [])]
