/** Exercise one call through the published rc.1 admission and batch executor. */
export async function executeNativeTool(tools, { name, arguments: args, callId, agent, signal }) {
  const toolSet = await tools.resolve({ agent, signal, modelSelection: agent?.model?.current?.() })
  try {
    const batch = await tools.execute({ agent, signal, toolSet,
      calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] })
    return batch.results[0].result
  } finally { toolSet.dispose() }
}
