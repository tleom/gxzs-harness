import { setTimeout as delay } from 'node:timers/promises'
import { claimNeedsResources, projectInboxClaim } from './projection.js'

/** Bind delayed Schedule/Jobs claims before native tool resolution. */
export function registerScheduledClaims(ctx, { runtime, database, ownerId }) {
  const pending = new WeakMap()
  // A cancelled/failed pre-step never committed its claimed messages. Native
  // idle ends that turn; its delayed claims must not be replayed by a later one.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') pending.delete(agent)
  }, { global: true })
  ctx.on('agent/inbox/claimed', payload => {
    const needsResources = claimNeedsResources(database, payload, ownerId)
    if (needsResources && !runtime.mcpCatalogState?.ready) {
      const claims = pending.get(payload.agent) ?? []
      claims.push(payload)
      pending.set(payload.agent, claims)
      return
    }
    return projectInboxClaim(database, payload, ownerId, needsResources
      ? { mcpTools: runtime.mcpResources?.() ?? [], mcpServers: runtime.mcpPlugins?.() ?? [] } : undefined)
  }, { global: true, prepend: true })
  ctx.on('agent/workbench-before-tools', async context => {
    const claims = pending.get(context.agent)
    if (!claims) return
    while (claims.some(payload => claimNeedsResources(database, payload, ownerId)) && !runtime.mcpCatalogState?.ready)
      await delay(100, undefined, { signal: context.signal })
    context.signal?.throwIfAborted()
    for (const payload of claims) projectInboxClaim(database, payload, ownerId,
      claimNeedsResources(database, payload, ownerId)
        ? { mcpTools: runtime.mcpResources?.() ?? [], mcpServers: runtime.mcpPlugins?.() ?? [] } : undefined)
    runtime.restrictMcpScope?.(context.agent)
    pending.delete(context.agent)
  }, { global: true, prepend: true })
}
