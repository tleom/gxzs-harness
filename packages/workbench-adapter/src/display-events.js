export const isNativeNotice = message => ['agent-message', 'subagent-settled'].includes(message?.source?.kind)

export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (typeof block === 'string') return block
    if (typeof block?.text === 'string') return block.text
    if (typeof block?.content === 'string') return block.content
    return ''
  }).filter(Boolean).join('\n')
}

/** DSH FileMutationRow's preparation counter; raw arguments stay in the native stream. */
export function fileToolPreparation(run, calls, chunk) {
  if (chunk?.type !== 'tool-call-delta') return undefined
  const previous = calls.get(chunk.index) ?? { id: '', name: '', characters: 0 }
  previous.id ||= String(chunk.id ?? '')
  previous.name = chunk.name ?? previous.name
  previous.characters += chunk.argumentsDelta?.length ?? 0
  calls.set(chunk.index, previous)
  if (!previous.id || !['write', 'edit'].includes(previous.name)) return undefined
  const kilobytes = Math.ceil(previous.characters / 1024)
  if (previous.publishedKilobytes === kilobytes) return undefined
  previous.publishedKilobytes = kilobytes
  return { kind: 'tool', workbench_run_id: run.id, call_id: previous.id,
    tool_call_id: previous.id, tool_name: previous.name, activity_id: previous.id,
    stage: 'preparing', argument_chars: previous.characters }
}


export function nativePresentation(run, event, { streamed = false, toolName = '', messageRun } = {}) {
  switch (event.type) {
    case 'user/message': {
      const source = event.data?.source
      if (isNativeNotice(event.data)) {
        const blocks = event.data.content ?? []
        const prefix = `Agent ${source.senderSessionId} sent a message: `
        const content = source.kind === 'agent-message' && blocks[0]?.text === prefix ? blocks.slice(1)
          : source.kind === 'subagent-settled' && blocks[0]?.text === source.summary &&
            ['Its closing message:', 'It left no closing message.'].includes(blocks[1]?.text)
            ? blocks.slice(blocks[1].text === 'Its closing message:' ? 2 : 1) : blocks
        return [{ event: 'workbench_agent_message', message_id: event.data.id, created_at: event.time / 1000,
          sender_session_id: source.senderSessionId, sender_name: run.selection?.subagent_names?.[source.senderSessionId] ?? source.senderSessionId,
          sender_type: source.senderSessionId === run.selection?.parent_session_id ? 'parent' : 'child',
          query: contentText(content), native: event }]
      }
      const id = messageRun?.id ?? event.data?.source?.rpcId
      if (typeof id !== 'string' || id === run.id || (run.messageId && run.messageId === event.data?.id)) return []
      return [{ event: 'workbench_steering', steering_id: id,
        created_at: messageRun?.createdAt != null ? messageRun.createdAt / 1000 : undefined,
        query: messageRun?.query ?? contentText(event.data?.content?.slice(0, 1)), native: event }]
    }
    case 'deliverables/presented':
      return [{ event: 'workbench_presented', native: event, files: event.data?.files ?? [] }]
    case 'workspace/changes':
      return [{ event: 'workbench_changes', turn: event.data?.turn, source_seq: event.seq }]
    case 'tool/call':
      return [{ event: 'workbench_activity', native: event, backend_run_id: run.id,
        data: { kind: 'tool', workbench_run_id: run.id, call_id: String(event.data?.callId ?? ''),
          tool_call_id: String(event.data?.callId ?? ''), tool_name: String(event.data?.name ?? ''),
          activity_id: String(event.data?.callId ?? ''), stage: 'started',
          ...toolPresentation(run, event.data),
          input: typeof event.data?.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data?.arguments ?? {}),
        } }]
    case 'tool/result': {
      const block = Array.isArray(event.data?.message?.content) ? event.data.message.content[0] : undefined
      const callId = String(event.data?.message?.source?.callId ?? block?.toolCallId ?? '')
      return [{ event: 'workbench_activity', native: event, backend_run_id: run.id,
        data: { kind: 'tool', workbench_run_id: run.id, call_id: callId, tool_call_id: callId,
          tool_name: toolName, activity_id: callId,
          ...toolPresentation(run, { name: toolName, callId }),
          stage: event.data?.error || event.data?.message?.isError || block?.isError ? 'error' : 'returned',
          output: contentText(block?.content ?? event.data?.message?.content),
          ...(event.data?.meta === undefined ? {} : { result_meta: event.data.meta }),
        } }]
    }
    case 'assistant/message': {
      const result = [], content = event.data?.message?.content ?? []
      if (event.surfaceOp == null || event.surfaceOp === 'append') result.push({
        event: 'workbench_assistant_final', turn: event.data.turn, step: event.data.step,
        has_reply: content.some(block => block.type === 'text' && block.text?.trim()),
        has_tool_calls: content.some(block => block.type === 'tool-call'),
      })
      if (!streamed) for (const [index, block] of content.entries()) {
        if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string' && block.text)
          result.push({ event: 'workbench_activity', native: event, backend_run_id: run.id,
            data: { kind: block.type, workbench_run_id: run.id, segment_id: `t${event.data.turn}s${event.data.step}b${index}`, text: block.text } })
      }
      return result
    }
    default: return []
  }
}

function toolPresentation(run, call) {
  const receipt = run.selection?.tool_presentations?.[run.sessionId]?.[call.callId]
  if (receipt) return { provider_name: receipt.provider_name, display_name: receipt.display_name }
  if (call.name === 'tool_search') return { display_name: '查找工具' }
  const title = run.selection?.tool_titles?.[call.callId]
  if (call.name === 'schedule_delete' && typeof title === 'string') return { display_name: title }

  if (call?.name === 'skill') {
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
      const name = args?.name
      if (typeof name === 'string') return { display_name: run.selection?.skill_names?.[name] ?? name }
    } catch { /* Partial input has no reliable skill identity. */ }
  }
  const tool = run.mcpTools?.find(item => item.runtime_name === call?.name || item.public_name === call?.name)
  return tool ? { provider_name: tool.provider_name ?? tool.server_id, display_name: tool.tool_name } : {}
}


export function compactionSummary(data) {
  return {
    summary: Array.isArray(data?.summary) ? data.summary.filter(block => block.type === 'text').map(block => block.text).join('') || null : null,
    items: Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs.length : null,
    tokens: Number.isSafeInteger(data?.shadowedTokenCount) ? data.shadowedTokenCount : null,
  }
}
