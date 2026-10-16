/** Reject malformed provider tool identities before native execution/persistence. */
export function registerModelToolCallGuard(ctx) {
  ctx.on('llm/stream', (_options, next) => guardModelToolCalls(next()), { global: true })
}

export async function* guardModelToolCalls(stream) {
  const calls = new Map()
  const closed = new Set()
  const invalid = () => {
    const ids = new Set()
    for (const call of calls.values()) {
      if (typeof call.id !== 'string' || !call.id.trim() || typeof call.name !== 'string' || !call.name.trim() || ids.has(call.id)) return true
      ids.add(call.id)
    }
    return false
  }
  const failure = () => ({ type: 'finish', reason: { kind: 'error', failure: {
    // A malformed upstream response follows DSH's bounded provider SERVER
    // recovery policy. No tool from this response has been dispatched yet.
    code: 'SERVER', message: '模型返回了缺失或重复标识的工具调用，本次模型响应未执行',
  } } })
  for await (const chunk of stream) {
    if (chunk.type === 'block-start' && chunk.blockType === 'tool-call' && !calls.has(chunk.index) && !closed.has(chunk.index)) calls.set(chunk.index, {})
    if (chunk.type === 'tool-call-delta' && !closed.has(chunk.index)) {
      const call = calls.get(chunk.index) ?? {}
      call.id = chunk.id
      if (chunk.name) call.name = chunk.name
      calls.set(chunk.index, call)
    }
    if (chunk.type === 'block-end' && !closed.has(chunk.index)) {
      closed.add(chunk.index)
      if (chunk.block?.type === 'tool-call') calls.set(chunk.index, { id: chunk.block.id, name: chunk.block.name })
      else calls.delete(chunk.index)
    }
    // Native max-token handling already drops incomplete calls. Preserve
    // cancellation and provider errors without turning them into retries.
    if (chunk.type === 'finish') {
      yield !['error', 'aborted', 'max-tokens'].includes(chunk.reason?.kind) && invalid() ? failure() : chunk
      return
    }
    yield chunk
  }
  // DSH treats a stream without an explicit finish as a normal stop.
  if (invalid()) yield failure()
}
