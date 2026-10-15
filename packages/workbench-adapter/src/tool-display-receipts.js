/** Freeze the name before native deletion removes it from the catalog. */
export function registerToolDisplayReceipts(ctx, { database, runtime, ownerId }) {
  ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'allow' && !execution.signal?.aborted) {
        const sessionId = execution.agent?.session?.id ?? execution.agent?.id
        const run = runtime.executionRun(sessionId)
        const tool = runtime.mcpToolForName?.(execution.name)
        const frozen = run?.mcpTools?.find(item => item.id === tool?.id)
        const alreadyFrozen = frozen && (frozen.runtime_name === execution.name || frozen.public_name === execution.name)
          && frozen.tool_name === tool.tool_name
          && (frozen.provider_name ?? frozen.server_id) === (tool.provider_name ?? tool.server_id)
        if (tool && !alreadyFrozen && run?.ownerId === ownerId && typeof execution.callId === 'string' && typeof sessionId === 'string') {
          const current = database.getRun(ownerId, run.id)
          database.updateRunResources(current, { ...current.selection,
            tool_presentations: { ...current.selection.tool_presentations, [sessionId]: {
              ...current.selection.tool_presentations?.[sessionId], [execution.callId]: {
              resource_id: tool.id, provider_name: tool.provider_name ?? tool.server_id,
              display_name: tool.tool_name,
            } } } }, current.mcpTools)
        }
      }
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
