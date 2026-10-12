import { nativeCommandRun } from './native-command.js'
import { runPromptId } from './native-prompt.js'
import { presentRunEvent } from './run-failure.js'

const END_STATUS = {
  completed: 'completed', aborted: 'cancelled', error: 'failed',
  'max-tokens': 'failed', blocked: 'failed', interrupted: 'interrupted',
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

export function createAssistantStreamProjector(database, expectedOwnerId) {
  const attempts = new Map()
  return ({ agent, frame }) => {
    const sessionId = agent?.session?.id ?? agent?.id
    const chat = database.getChatBySession(sessionId)
    if (!chat || (expectedOwnerId && chat.ownerId !== expectedOwnerId)) return undefined
    if (frame.type === 'start') {
      attempts.set(String(frame.attemptId), { sessionId, turn: frame.turn, step: frame.step, tools: new Map() })
      return undefined
    }
    const attempt = attempts.get(String(frame.attemptId))
    if (!attempt || attempt.sessionId !== sessionId) return undefined
    if (frame.type === 'end') {
      database.flushStreamEvents()
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
    if (chunk?.type === 'tool-call-delta') {
      const run = database.runForTurn(sessionId, attempt.turn)
      if (!run) return undefined
      const data = fileToolPreparation(run, attempt.tools, chunk)
      if (!data) return undefined
      return database.appendStreamEvent(chat.ownerId, run.id, {
        event: 'workbench_activity', backend_run_id: run.id,
        data: { ...data, segment_id: `t${attempt.turn}s${attempt.step}a${String(frame.attemptId)}:b${chunk.index}` },
      }, attempt.turn, attempt.step)
    }
    if (chunk?.type !== 'text-delta' && chunk?.type !== 'reasoning-delta') return undefined
    if (!chunk.text) return undefined
    const run = database.runForTurn(sessionId, attempt.turn)
    if (!run) return undefined
    return database.appendStreamEvent(chat.ownerId, run.id, {
      event: 'workbench_activity', backend_run_id: run.id,
      data: {
        kind: chunk.type === 'text-delta' ? 'text' : 'reasoning', workbench_run_id: run.id,
        segment_id: `t${attempt.turn}s${attempt.step}a${String(frame.attemptId)}:b${chunk.index ?? 0}`, text: chunk.text,
      },
    }, attempt.turn, attempt.step)
  }
}

export function projectSessionEvent(database, sessionId, event, expectedOwnerId, context) {
  database.flushStreamEvents()
  if (database.hasProjectedEvent(sessionId, event.seq)) return undefined
  return database.transaction(() => {
    const result = projectEvent(database, sessionId, event, expectedOwnerId, context)
    database.markProjectedEvent(sessionId, event.seq)
    return result
  })()
}

function projectEvent(database, sessionId, event, expectedOwnerId, context) {
  const chat = database.getChatBySession(sessionId)
  if (!chat || (expectedOwnerId && chat.ownerId !== expectedOwnerId)) return undefined

  if (event.type === 'agent/inbox/spliced') {
    for (const message of event.data?.inserted ?? []) adoptMessage(database, sessionId, message, context)
    return undefined
  }
  if (event.type === 'user/message') {
    adoptMessage(database, sessionId, event.data, context)
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
      event: 'workbench_chat_title', chat_id: chat.id, title, title_source: event.data?.source?.kind,
    })
  }

  if (event.type === 'request/context' && context) {
    const run = database.activeRun(chat.ownerId, chat.id)
    if (!run) return undefined
    return database.appendEvent(chat.ownerId, run.id, {
      event: 'workbench_context', workbench_run_id: run.id, phase: 'request', ...context,
    })
  }

  if (['plan/mode', 'command/run', 'command/done'].includes(event.type)) {
    if (!context?.plan) return undefined
    // A display cache of DSH's PlanProjection; never fold another plan lifecycle.
    const state = database.updateControlBySession(sessionId, { plan: context.plan })
    const run = database.activeRun(chat.ownerId, chat.id)
    if (run) database.appendEvent(chat.ownerId, run.id, { event: 'workbench_control', state })
    return state
  }
  if (['todo/write', 'goal/change', 'compaction/start', 'compaction/summary', 'compaction/end'].includes(event.type)) {
    const result = projectControlEvent(database, chat, sessionId, event)
    if (event.type === 'goal/change' && context?.nativeIdle) settleNativeIdle(database, sessionId, event.data?.goal)
    return result
  }

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
      const goal = context?.goal ?? database.getControl(chat.ownerId, chat.id).goal
      if (kind === 'completed' && goal?.phase === 'active' && goal.activation !== 'disarmed'
        && database.goalRun(sessionId)?.id === run.id) {
        // DSH owns continuation; one business run spans its automatic rounds.
        return append({ event: 'workbench_status', status: 'running', turn, goal_round_complete: true })
      }
      database.transitionRun(chat.ownerId, run.id, status, error)
      return append(presentRunEvent({ event: 'workbench_end', status, error,
        ...(event.data?.reason?.error?.code ? { error_code: event.data.reason.error.code } : {}) }))
    }
    case 'deliverables/presented':
    case 'workspace/changes':
      return append(nativePresentation(run, event)[0])
    case 'tool/call':
      database.startToolCall(chat.ownerId, run.id, String(event.data?.callId ?? ''), String(event.data?.name ?? ''))
      return append(nativePresentation(run, event)[0])
    case 'tool/result': {
      const block = Array.isArray(event.data?.message?.content) ? event.data.message.content[0] : undefined
      const callId = String(event.data?.message?.source?.callId ?? block?.toolCallId ?? '')
      const toolName = database.finishToolCall(chat.ownerId, run.id, callId) ?? ''
      return append(nativePresentation(run, event, { toolName })[0])
    }
    case 'assistant/message': {
      for (const payload of nativePresentation(run, event, {
        streamed: database.isStreamedStep(chat.ownerId, run.id, event.data.turn, event.data.step),
      })) append(payload)
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

/** Shared, side-effect-free display projection for live events and native history pages. */
export function nativePresentation(run, event, { streamed = false, toolName = '', messageRun } = {}) {
  switch (event.type) {
    case 'user/message': {
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
          ...toolPresentation(run, { name: toolName }),
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

export function projectInboxClaim(database, { agent, message, turn }, expectedOwnerId, context) {
  const sessionId = agent?.session?.id ?? agent?.id
  if (!Number.isInteger(turn) || typeof message?.id !== 'string') return undefined
  const chat = database.getChatBySession(sessionId)
  if (!chat || (expectedOwnerId && chat.ownerId !== expectedOwnerId)) return undefined
  let run
  if (message.source?.kind === 'schedule') {
    const scheduled = adoptMessage(database, sessionId, message, context)
    const current = database.runForTurn(sessionId, turn)
    if (scheduled) {
      run = database.bindRunMessage(sessionId, scheduled.id, turn, message.id)
      if (current && current.id !== scheduled.id) {
        database.transitionRun(chat.ownerId, scheduled.id, 'steered')
        database.appendEvent(chat.ownerId, scheduled.id, { event: 'workbench_steered', steer_target_run_id: current.id })
        database.appendEvent(chat.ownerId, current.id, { event: 'workbench_steering', steering_id: scheduled.id,
          query: scheduled.query, attachments: [] })
        return run
      }
    }
  }
  if (runPromptId(message)) {
    const current = database.runForTurn(sessionId, turn)
    run = database.bindRunMessage(sessionId, message.source.rpcId, turn, message.id)
    if (run && current && current.id !== run.id) {
      if (run.status !== 'steered') {
        database.transitionRun(chat.ownerId, run.id, 'steered')
        database.appendEvent(chat.ownerId, run.id, { event: 'workbench_steered', steer_target_run_id: current.id })
        database.appendEvent(chat.ownerId, current.id, { event: 'workbench_steering', steering_id: run.id,
          query: run.query, attachments: run.attachments ?? [] })
      }
      return database.getRun(chat.ownerId, run.id)
    }
  }
  else if (message.source?.kind === 'goal' || (message.source?.kind === 'user' && !message.source.rpcId)) {
    const admitted = database.listRuns(chat.ownerId, chat.id).find(item => item.messageId === message.id) ?? nativeCommandRun(sessionId)
    if (admitted) {
      const current = database.runForTurn(sessionId, turn)
      run = database.bindRunMessage(sessionId, admitted.id, turn, message.id)
      if (current && current.id !== admitted.id) {
        database.transitionRun(chat.ownerId, admitted.id, 'steered')
        database.appendEvent(chat.ownerId, admitted.id, { event: 'workbench_steered', steer_target_run_id: current.id })
        database.appendEvent(chat.ownerId, current.id, { event: 'workbench_steering', steering_id: admitted.id,
          query: admitted.query, attachments: admitted.attachments ?? [] })
      }
      return run
    }
    // Native /goal attachment followups carry user source without an RPC id.
    // They belong to the existing goal run, never a second business submission.
    const active = database.goalRun(sessionId) ?? (message.source?.kind === 'goal' ? database.activeRunBySession(sessionId) : undefined)
    if (active) run = database.bindNativeTurn(active, turn)
  }
  if (run?.status === 'queued') {
    database.transitionRun(run.ownerId, run.id, 'running')
    database.appendEvent(run.ownerId, run.id, { event: 'workbench_status', status: 'running' })
  }
  return run
}

function adoptMessage(database, sessionId, message, context) {
  if (message?.source?.kind === 'schedule' && typeof message.id === 'string') {
    const chat = database.getChatBySession(sessionId)
    if (!chat) return
    // A display/admission receipt for a message DSH already delivered. Never enqueue it again.
    const { run } = database.createRun({ ownerId: chat.ownerId, chatId: chat.id, sessionId,
      id: message.id, requestKey: `schedule:${message.id}`, query: contentText(message.content),
      selection: { ...chat.selection, native_source: 'schedule' }, mcpTools: context?.mcpTools ?? [] })
    database.adoptInboxMessage(sessionId, run.id, message.id)
    return run
  }
  if (runPromptId(message) && typeof message?.id === 'string')
    database.adoptInboxMessage(sessionId, message.source.rpcId, message.id)
  else if (message?.source?.kind === 'user' && typeof message.id === 'string') {
    const run = nativeCommandRun(sessionId)
    if (run) database.adoptInboxMessage(sessionId, run.id, message.id)
  }
}

function projectControlEvent(database, chat, sessionId, event) {
  let update
  if (event.type === 'todo/write') update = { todos: event.data?.todos ?? [] }
  else if (event.type === 'goal/change') {
    const goal = event.data?.goal
    if (goal?.phase === 'active' && (!database.goalRun(sessionId) || ['completed', 'failed', 'interrupted', 'cancelled'].includes(database.goalRun(sessionId).status))) {
      const active = database.activeRunBySession(sessionId)
      if (active) database.setGoalRun(sessionId, active.id)
    }
    update = { goal: event.data?.operation === 'clear' || !goal ? null : {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      activation: goal.activation,
      reason: goal.blockedReason?.message ?? null,
      max_rounds: goal.maxGoalRounds ?? null,
      rounds_started: event.data?.roundsStarted ?? 0,
      last_run_id: null,
    } }
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

export function settleNativeIdle(database, sessionId, goal) {
  const run = database.goalRun(sessionId)
  if (!run || !['running', 'waiting_input', 'stopping'].includes(run.status)) return
  if (goal?.phase === 'active' && goal.activation !== 'disarmed') return
  const status = goal?.phase === 'active' ? 'interrupted' : 'completed'
  database.transitionRun(run.ownerId, run.id, status)
  database.appendEvent(run.ownerId, run.id, { event: 'workbench_end', status })
}

/** Replay native facts before declaring readiness; never wake a recovered agent. */
export async function reconcileNativeSessions(database, sessionQuery, ownerId) {
  const queued = []
  for (const chat of database.listChats(ownerId)) {
    let observed
    try { observed = await sessionQuery.observeSession(chat.sessionId) }
    catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') continue
      throw error
    }
    try {
      const events = observed.events ?? []
      const inbox = { 'next-turn': [], 'next-step': [] }
      let turn
      // Claims are transient notifications. Reconstruct the turn relation from
      // the durable user/message records before replaying their projected output.
      for (const event of events) {
        if (event.type === 'agent/inbox/spliced') {
          const data = event.data
          inbox[data.target].splice(data.start, data.removedCount ?? 0, ...(data.inserted ?? []))
        }
        if (event.type === 'turn/start') turn = event.data.turn
        if (event.type === 'user/message' && Number.isInteger(turn)) {
          const message = event.data
          const admitted = message.source?.kind === 'schedule' ? adoptMessage(database, chat.sessionId, message)
            : database.listRuns(chat.ownerId, chat.id).find(item => item.messageId === message.id)
          if (message.source?.kind === 'schedule' && admitted) database.bindRunMessage(chat.sessionId, admitted.id, turn, message.id)
          if (runPromptId(message) || (message.source?.kind === 'user' && admitted))
            database.bindRunMessage(chat.sessionId, message.source.rpcId ?? admitted.id, turn, message.id)
          else if (message.source?.kind === 'goal' || (message.source?.kind === 'user' && !message.source.rpcId)) {
            const run = database.goalRun(chat.sessionId)
            if (run) database.bindNativeTurn(run, turn)
          }
        }
      }
      for (const event of events) {
        if (event.type === 'assistant/message' && !database.hasProjectedEvent(chat.sessionId, event.seq)) {
          const run = database.runForTurn(chat.sessionId, event.data.turn)
          if (run && database.isStreamedStep(ownerId, run.id, event.data.turn, event.data.step)) {
            // A crash may leave acknowledged early deltas plus a durable native
            // final message whose last buffered deltas never had a cursor.
            // Replace that step through the existing reset protocol before
            // replaying the complete native answer; never append duplicate text.
            database.transaction(() => {
              database.clearStreamedStep(ownerId, run.id, event.data.turn, event.data.step)
              database.appendEvent(ownerId, run.id, { event: 'workbench_stream_reset', segment_prefix: `t${event.data.turn}s${event.data.step}a` })
              projectSessionEvent(database, chat.sessionId, event, ownerId)
            })()
            continue
          }
        }
        projectSessionEvent(database, chat.sessionId, event, ownerId)
      }
      for (const message of [...inbox['next-turn'], ...inbox['next-step']]) {
        const requestId = runPromptId(message)
        const run = requestId ? database.getRun(ownerId, requestId)
          : database.listRuns(chat.ownerId, chat.id).find(item => item.messageId === message.id)
        if (run && run.sessionId === chat.sessionId) {
          queued.push(run.id)
          database.adoptInboxMessage(chat.sessionId, run.id, message.id)
        }
      }
    } finally { observed[Symbol.dispose]?.() }
  }
  database.recoverInterrupted(Date.now(), queued)
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
