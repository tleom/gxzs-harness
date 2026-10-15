import { setTimeout as delay } from 'node:timers/promises'
import { projectInboxClaim } from './projection.js'
import { isNativeNotice } from './display-events.js'

/** Bind delayed Schedule/Jobs claims before rebuilding the native prompt. */
export function registerScheduledClaims(ctx, { runtime, database, ownerId }) {
  const pending = new WeakMap()
  ctx.on('agent/inbox/claimed', payload => {
    if ((['schedule', 'tool-jobs'].includes(payload.message?.source?.kind) || isNativeNotice(payload.message)) && !runtime.mcpCatalogState?.ready) {
      const claims = pending.get(payload.agent) ?? []
      claims.push(payload)
      pending.set(payload.agent, claims)
      return
    }
    return projectInboxClaim(database, payload, ownerId, { mcpTools: runtime.mcpResources?.() ?? [] })
  }, { global: true, prepend: true })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const claims = context.scope && pending.get(context.scope)
    if (!claims) return next()
    pending.delete(context.scope)
    while (!runtime.mcpCatalogState?.ready) await delay(100, undefined, { signal: context.signal })
    context.signal?.throwIfAborted()
    for (const payload of claims) projectInboxClaim(database, payload, ownerId,
      { mcpTools: runtime.mcpResources?.() ?? [] })
    runtime.restrictMcpScope?.(context.scope)
    // Providers ran before this waterfall. Reassemble once after catalog and
    // scoped restrictions are ready; the consumed pending entry prevents recursion.
    // DSH still owns native/PTC schemas, ordering and complete prompts.
    return ctx.systemPrompt.assemble(context)
  }, { global: true, prepend: true })
}
