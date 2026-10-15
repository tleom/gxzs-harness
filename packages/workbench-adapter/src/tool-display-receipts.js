/** Freeze the name before native deletion removes it from the catalog. */
export function registerToolDisplayReceipts(ctx, { database, runtime, ownerId }) {
  ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'allow' && !execution.signal?.aborted && execution.name === 'schedule_delete') {
        const sessionId = execution.agent?.session?.id ?? execution.agent?.id
        const run = runtime.executionRun(sessionId)
        if (run?.ownerId === ownerId && typeof execution.arguments?.id === 'string') {
          const task = (await ctx.schedule.catalog(execution.signal)).find(task => task.id === execution.arguments.id && task.sessionId === sessionId)
          if (task) {
            const current = database.getRun(ownerId, run.id)
            database.updateRunResources(current, { ...current.selection,
              tool_titles: { ...current.selection.tool_titles, [execution.callId]: task.title } }, current.mcpTools)
          }
        }
      }
    } catch { /* Display metadata must not change native tool execution. */ }
    return decision
  }, { global: true })
}
