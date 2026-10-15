import { setTimeout as delay } from 'node:timers/promises'
import { claimNeedsResources, projectInboxClaim } from './projection.js'

/** Bind delayed Schedule/Jobs claims before rebuilding the native prompt. */
export function registerScheduledClaims(ctx, { runtime, database, ownerId }) {
  const pending = new WeakMap()
  ctx.on('agent/inbox/claimed', payload => {
    const needsResources = claimNeedsResources(database, payload, ownerId)
    if (needsResources && !runtime.mcpCatalogState?.ready) {
      const claims = pending.get(payload.agent) ?? []
      claims.push(payload)
      pending.set(payload.agent, claims)
      return
    }
    return projectInboxClaim(database, payload, ownerId, needsResources ? { mcpTools: runtime.mcpResources?.() ?? [] } : undefined)
  }, { global: true, prepend: true })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const claims = context.scope && pending.get(context.scope)
    if (!claims) return next()
    pending.delete(context.scope)
    while (claims.some(payload => claimNeedsResources(database, payload, ownerId)) && !runtime.mcpCatalogState?.ready)
      await delay(100, undefined, { signal: context.signal })
    context.signal?.throwIfAborted()
    for (const payload of claims) projectInboxClaim(database, payload, ownerId,
      claimNeedsResources(database, payload, ownerId) ? { mcpTools: runtime.mcpResources?.() ?? [] } : undefined)
    runtime.restrictMcpScope?.(context.scope)
    // Providers ran before this waterfall. Reassemble once after catalog and
    // scoped restrictions are ready; the consumed pending entry prevents recursion.
    // DSH still owns native/PTC schemas, ordering and complete prompts.
    return ctx.systemPrompt.assemble(context)
  }, { global: true, prepend: true })
}
