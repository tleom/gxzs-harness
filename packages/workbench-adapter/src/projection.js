const END_STATUS = {
  completed: 'completed', aborted: 'cancelled', error: 'failed',
  'max-tokens': 'failed', blocked: 'failed', interrupted: 'interrupted',
}

export function createAssistantStreamProjector(database, expectedOwnerId) {
  const attempts = new Map()
  return ({ agent, frame }) => {
    const sessionId = agent?.session?.id ?? agent?.id
    const chat = database.getChatBySession(sessionId)
    if (!chat || (expectedOwnerId && chat.ownerId !== expectedOwnerId)) return undefined
    if (frame.type === 'start') {
      attempts.set(String(frame.attemptId), { sessionId, turn: frame.turn, step: frame.step })
      return undefined
    }
    const attempt = attempts.get(String(frame.attemptId))
    if (!attempt || attempt.sessionId !== sessionId) return undefined
    if (frame.type === 'end') {
      attempts.delete(String(frame.attemptId))
      if (frame.outcome?.kind !== 'abandoned') return undefined
      const run = database.runForTurn(sessionId, attempt.turn)
      if (!run) return undefined
      database.clearStreamedStep(chat.ownerId, run.id, attempt.turn, attempt.step)
      return database.appendEvent(chat.ownerId, run.id, {
        event: 'workbench_stream_reset',
        segment_prefix: `t${attempt.turn}s${attempt.step}a${String(frame.attemptId)}:`,
      })
    }
    const chunk = frame.chunk
    if (chunk?.type !== 'text-delta' && chunk?.type !== 'reasoning-delta') return undefined
    if (!chunk.text) return undefined
    const run = database.runForTurn(sessionId, attempt.turn)
    if (!run) return undefined
    database.markStreamedStep(chat.ownerId, run.id, attempt.turn, attempt.step)
    return database.appendEvent(chat.ownerId, run.id, {
      event: 'workbench_activity', backend_run_id: run.id,
      data: {
        kind: chunk.type === 'text-delta' ? 'text' : 'reasoning', workbench_run_id: run.id,
        segment_id: `t${attempt.turn}s${attempt.step}a${String(frame.attemptId)}:b${chunk.index ?? 0}`, text: chunk.text,
      },
    })
  }
}

export function projectSessionEvent(database, sessionId, event, expectedOwnerId, context) {
  const chat = database.getChatBySession(sessionId)
  if (!chat || (expectedOwnerId && chat.ownerId !== expectedOwnerId)) return undefined

  if (event.type === 'agent/inbox/spliced') {
    for (const message of event.data?.inserted ?? []) adoptMessage(database, sessionId, message)
    return undefined
  }
  if (event.type === 'user/message') {
    adoptMessage(database, sessionId, event.data)
    if (event.surfaceOp?.op === 'replace') {
      const run = database.activeRun(chat.ownerId, chat.id)
      if (run) return database.appendEvent(chat.ownerId, run.id, {
        event: 'workbench_surface_replace',
        start_seq: event.surfaceOp.startSeq,
        end_seq: event.surfaceOp.endSeq,
        source_event_seqs: event.sourceEventSeqs ?? [],
        replacement_seq: event.seq,
      })
    }
    return undefined
  }

  if (event.type === 'session/title') {
    const title = typeof event.data?.title === 'string' ? event.data.title : ''
    if (!title) return undefined
    database.updateChat(chat.ownerId, chat.id, { title })
    const run = database.activeRun(chat.ownerId, chat.id)
    if (!run) return undefined
    return database.appendEvent(chat.ownerId, run.id, {
      event: 'workbench_chat_title', chat_id: chat.id, title,
    })
  }

  if (event.type === 'request/context' && context) {
    const run = database.activeRun(chat.ownerId, chat.id)
    if (!run) return undefined
    return database.appendEvent(chat.ownerId, run.id, {
      event: 'workbench_context', workbench_run_id: run.id, phase: 'request', ...context,
    })
  }

  if (['todo/write', 'goal/change', 'plan/mode', 'compaction/start', 'compaction/summary', 'compaction/end'].includes(event.type))
    return projectControlEvent(database, chat, sessionId, event)

  const turn = event.data?.turn
  if (!Number.isInteger(turn)) return undefined
  if (event.type === 'turn/start' && Number.isInteger(event.seq)) database.observeTurnStart(sessionId, turn, event.seq)
  const run = database.runForTurn(sessionId, turn)
  if (!run) return undefined
  const append = (payload) => database.appendEvent(chat.ownerId, run.id, payload)

  switch (event.type) {
    case 'turn/start':
      if (Number.isInteger(event.seq)) database.setRunSourceSeq(chat.ownerId, run.id, 'source_start_seq', event.seq)
      if (run.status === 'queued') {
        database.transitionRun(chat.ownerId, run.id, 'running')
        return append({ event: 'workbench_status', status: 'running' })
      }
      return undefined
    case 'turn/end': {
      const kind = event.data?.reason?.kind ?? 'error'
      const status = END_STATUS[kind] ?? 'failed'
      const error = kind === 'completed' || kind === 'aborted'
        ? undefined
        : String(event.data?.reason?.error?.message ?? `任务结束：${kind}`)
      if (Number.isInteger(event.seq)) database.setRunSourceSeq(chat.ownerId, run.id, 'source_end_seq', event.seq)
      database.transitionRun(chat.ownerId, run.id, status, error)
      return append({ event: 'workbench_end', status, error })
    }
    case 'tool/call':
      database.startToolCall(chat.ownerId, run.id, String(event.data?.callId ?? ''), String(event.data?.name ?? ''))
      return append({
        event: 'workbench_activity', backend_run_id: run.id,
        data: {
          kind: 'tool', workbench_run_id: run.id, call_id: String(event.data?.callId ?? ''),
          tool_call_id: String(event.data?.callId ?? ''), tool_name: String(event.data?.name ?? ''),
          activity_id: String(event.data?.callId ?? ''), stage: 'started',
          input: typeof event.data?.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data?.arguments ?? {}),
        },
      })
    case 'tool/result': {
      const block = Array.isArray(event.data?.message?.content) ? event.data.message.content[0] : undefined
      const callId = String(event.data?.message?.source?.callId ?? block?.toolCallId ?? '')
      const toolName = database.finishToolCall(chat.ownerId, run.id, callId) ?? ''
      return append({
        event: 'workbench_activity', backend_run_id: run.id,
        data: {
          kind: 'tool', workbench_run_id: run.id, call_id: callId, tool_call_id: callId,
          tool_name: toolName, activity_id: callId,
          stage: event.data?.error || block?.isError ? 'error' : 'returned',
          output: contentText(block?.content ?? event.data?.message?.content),
        },
      })
    }
    case 'assistant/message': {
      if (!database.isStreamedStep(chat.ownerId, run.id, event.data.turn, event.data.step)) {
        for (const [index, block] of (event.data?.message?.content ?? []).entries()) {
          if ((block?.type === 'text' || block?.type === 'reasoning') && typeof block.text === 'string' && block.text)
            append({
              event: 'workbench_activity', backend_run_id: run.id,
              data: { kind: block.type, workbench_run_id: run.id, segment_id: `t${event.data.turn}s${event.data.step}b${index}`, text: block.text },
            })
        }
      }
      const usage = event.data?.usage
      if (context || usage) return append({
        event: 'workbench_context', workbench_run_id: run.id, phase: 'usage',
        ...(context ?? {
          used_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          window_tokens: null, estimated: false, model: '',
        }),
      })
      return undefined
    }
    default:
      return undefined
  }
}

export function projectInboxClaim(database, { agent, message, turn }, expectedOwnerId) {
  const sessionId = agent?.session?.id ?? agent?.id
  if (!Number.isInteger(turn) || message?.source?.kind !== 'user' || typeof message.source.rpcId !== 'string' || typeof message?.id !== 'string') return undefined
  const chat = database.getChatBySession(sessionId)
  if (!chat || (expectedOwnerId && chat.ownerId !== expectedOwnerId)) return undefined
  const run = database.bindRunMessage(sessionId, message.source.rpcId, turn, message.id)
  if (run?.status === 'queued') {
    database.transitionRun(run.ownerId, run.id, 'running')
    database.appendEvent(run.ownerId, run.id, { event: 'workbench_status', status: 'running' })
  }
  return run
}

function adoptMessage(database, sessionId, message) {
  if (message?.source?.kind === 'user' && typeof message.source.rpcId === 'string' && typeof message?.id === 'string')
    database.adoptInboxMessage(sessionId, message.source.rpcId, message.id)
}

function projectControlEvent(database, chat, sessionId, event) {
  let update
  if (event.type === 'todo/write') update = { todos: event.data?.todos ?? [] }
  else if (event.type === 'goal/change') {
    const goal = event.data?.goal
    update = { goal: event.data?.operation === 'clear' || !goal ? null : {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      reason: goal.blockedReason?.message ?? null,
      max_rounds: goal.maxGoalRounds ?? null,
      rounds_started: event.data?.roundsStarted ?? 0,
      last_run_id: null,
      started_at: Number.isFinite(event.data?.createdAt) ? Math.floor(event.data.createdAt / 1000) : null,
      active_since: Number.isFinite(event.data?.updatedAt) ? Math.floor(event.data.updatedAt / 1000) : null,
    } }
  } else if (event.type === 'plan/mode') {
    const current = database.getControl(chat.ownerId, chat.id)
    update = { plan: { ...current.plan, active: Boolean(event.data?.active) } }
  } else if (event.type === 'compaction/summary') {
    update = { compaction: {
      id: event.data?.compactionId ?? '', phase: 'compacting', message: contentText(event.data?.summary),
      before_tokens: event.data?.shadowedTokenCount ?? null, after_tokens: null,
    } }
  } else {
    const phase = event.type === 'compaction/start' ? 'compacting' : event.data?.error ? 'failed' : 'compacted'
    const current = database.getControl(chat.ownerId, chat.id).compaction
    update = { compaction: {
      id: event.data?.compactionId ?? current?.id ?? '', phase,
      message: event.data?.error?.message ?? current?.message ?? null,
      before_tokens: current?.before_tokens ?? null, after_tokens: current?.after_tokens ?? null,
    } }
  }
  const control = database.updateControlBySession(sessionId, update)
  const run = Number.isInteger(event.data?.turn) ? database.runForTurn(sessionId, event.data.turn) : undefined
  if (control && run) database.appendEvent(chat.ownerId, run.id, { event: 'workbench_control', state: control })
  return control
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (typeof block === 'string') return block
    if (typeof block?.text === 'string') return block.text
    if (typeof block?.content === 'string') return block.content
    return ''
  }).filter(Boolean).join('\n')
}
