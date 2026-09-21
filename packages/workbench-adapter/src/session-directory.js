import { randomUUID } from 'node:crypto'

/** Preserve history while changing the immutable DSH session directory. */
export async function copySessionDirectory({ agents, sessionQuery, agentPresets, agentDefaultModel }, sessionId, cwd, atSeq) {
  const source = await sessionQuery.observeSession(sessionId)
  try {
    const events = atSeq === undefined ? source.events : source.events.filter((event) => event.seq <= atSeq)
    const preset = await agentPresets.resolve(source.projections?.values?.agentPreset ?? source.header.agentPreset)
    const childId = `session-${randomUUID()}`
    await agents.create({
      sessionId: childId, seed: events, inheritedEventCount: events.length,
      meta: { cwd, parentSession: sessionId, isSeeded: true, agentPreset: preset.id },
      agentOptions: agentDefaultModel.currentSelection(),
      setup: (agentCtx) => agentPresets.mount(agentCtx, preset.id),
    })
    return { sessionId: childId }
  } finally { source[Symbol.dispose]?.() }
}
