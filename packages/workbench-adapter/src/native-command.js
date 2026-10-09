import { AsyncLocalStorage } from 'node:async_hooks'

const admissions = new AsyncLocalStorage()

// Correlate native command-created inbox messages with the platform's display
// record. Message creation, steering and execution stay with the DSH handler.
export async function withNativeCommandRun(run, execute) {
  const admission = { run, open: true }
  try { return await admissions.run(admission, execute) }
  finally { admission.open = false }
}

export function nativeCommandRun(sessionId) {
  const admission = admissions.getStore()
  return admission?.open && admission.run.sessionId === sessionId ? admission.run : undefined
}

// Read presentation directly from DSH's durable command records. No separate
// command state is stored by Workbench, including during compaction failures.
export function nativeCommandRecords(events, runs) {
  const commands = new Map()
  const orderedRuns = runs.filter(run => Number.isInteger(run.sourceStartSeq)).sort((a, b) => a.sourceStartSeq - b.sourceStartSeq)
  for (const event of events) {
    if (event.type === 'command/run') commands.set(event.data.commandId, {
      id: event.data.commandId, name: event.data.name, args: event.data.args,
      before_run_id: orderedRuns.find(run => run.sourceStartSeq > event.seq)?.id ?? null,
      outcome: null,
    })
    if (event.type === 'command/done' && commands.has(event.data.commandId))
      commands.get(event.data.commandId).outcome = event.data
  }
  return [...commands.values()]
}
