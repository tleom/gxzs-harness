import { nativePresentation, fileToolPreparation, isNativeNotice, contentText } from './display-events.js'
export { nativePresentation, fileToolPreparation } from './display-events.js'
import { nativeCommandRun } from './native-command.js'
import { runPromptId } from './native-prompt.js'
import { presentRunEvent } from './run-failure.js'
import { contextUsage } from './context-usage.js'
import { goalMentionResources } from './resource-mentions.js'
import { scheduleOccurrences } from './schedule-notifications.js'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

const END_STATUS = {
  completed: 'completed', aborted: 'cancelled', error: 'failed',
  'max-tokens': 'failed', blocked: 'failed', interrupted: 'interrupted',
}

// Live native facts are durable already, but must not overtake an older startup
// snapshot while replay yields to I/O. Keep the barrier across failed attempts
// so newer live facts cannot overtake the retry's unacknowledged history.
const nativeReplays = new WeakMap()
const eventIdentity = event => Number.isInteger(event.seq) ? event.seq : event
const streamStep = (sessionId, turn, step) => `${sessionId}:${turn}:${step}`

export function createAssistantStreamProjector(database, expectedOwnerId) {
  const attempts = new Map()
  const applyFrame = (sessionId, frame, snapshotSteps) => {
    if (frame.type === 'start') {
      attempts.set(String(frame.attemptId), { sessionId, turn: frame.turn, step: frame.step, tools: new Map() })
      return undefined
    }
    const attempt = attempts.get(String(frame.attemptId))
    if (!attempt || attempt.sessionId !== sessionId) return undefined
    if (frame.type === 'end') attempts.delete(String(frame.attemptId))
    // A durable final message in the snapshot already represents these deltas.
    if (snapshotSteps?.has(streamStep(sessionId, attempt.turn, attempt.step))) return undefined
    const run = database.streamRunForTurn(sessionId, attempt.turn)
    if (!run || (expectedOwnerId && run.ownerId !== expectedOwnerId)) return undefined
    if (frame.type === 'end') {
      database.flushStreamEvents()
      if (frame.outcome?.kind !== 'abandoned') return undefined
      database.clearStreamedStep(run.ownerId, run.id, attempt.turn, attempt.step)
      return database.appendEvent(run.ownerId, run.id, {
        event: 'workbench_stream_reset',
        segment_prefix: `t${attempt.turn}s${attempt.step}a${String(frame.attemptId)}:`,
      })
    }
    const chunk = frame.chunk
    if (chunk?.type === 'tool-call-delta') {
      const data = fileToolPreparation(run, attempt.tools, chunk, frame.time)
      if (!data) return undefined
      return database.appendStreamEvent(run.ownerId, run.id, {
        event: 'workbench_activity', backend_run_id: run.id,
        data: { ...data, segment_id: `t${attempt.turn}s${attempt.step}a${String(frame.attemptId)}:b${chunk.index}` },
      }, attempt.turn, attempt.step)
    }
    if (chunk?.type !== 'text-delta' && chunk?.type !== 'reasoning-delta') return undefined
    if (!chunk.text) return undefined
    return database.appendStreamEvent(run.ownerId, run.id, {
      event: 'workbench_activity', backend_run_id: run.id,
      data: {
        kind: chunk.type === 'text-delta' ? 'text' : 'reasoning', workbench_run_id: run.id,
        segment_id: `t${attempt.turn}s${attempt.step}a${String(frame.attemptId)}:b${chunk.index ?? 0}`, text: chunk.text,
      },
    }, attempt.turn, attempt.step)
  }
  return ({ agent, frame }) => {
    const sessionId = agent?.session?.id ?? agent?.id
    const replay = nativeReplays.get(database)
    if (replay?.sessions.has(sessionId)) {
      replay.queue.push({ apply: () => applyFrame(sessionId, frame, replay.snapshotSteps) })
      return undefined
    }
    return applyFrame(sessionId, frame)
  }
}

export function projectSessionEvent(database, sessionId, event, expectedOwnerId, context) {
  const replay = nativeReplays.get(database)
  if (replay?.sessions.has(sessionId)) {
    let events = replay.events.get(sessionId)
    if (!events) replay.events.set(sessionId, events = new Map())
    const key = eventIdentity(event)
    if (!events.has(key)) {
      const entry = { sessionId, event, expectedOwnerId, context }
      events.set(key, entry)
      replay.queue.push(entry)
    }
    return undefined
  }
  return applySessionEvent(database, sessionId, event, expectedOwnerId, context)
}

function applySessionEvent(database, sessionId, event, expectedOwnerId, context) {
  database.flushStreamEvents()
  const projected = database.hasProjectedEvent(sessionId, event.seq)
  // Settled history can contain thousands of events backed by megabyte-sized
  // frozen tool catalogs. Only turn/end needs its receipt before deduplication:
  // older adapters may have acknowledged the event before binding its end.
  if (projected && event.type !== 'turn/end') return undefined
  const turn = event.data?.turn
  const run = Number.isInteger(turn) ? database.runForTurn(sessionId, turn) : undefined
  // Earlier adapter versions could acknowledge a native completion before its
  // autonomous receipt existed. Recover that durable end once after binding.
  const unprojectedEnd = event.type === 'turn/end' && run && run.sourceEndSeq == null
  if (projected && !unprojectedEnd) return undefined
  return database.transaction(() => {
    const result = projectEvent(database, sessionId, event, expectedOwnerId, context)
    // Native events may precede verified autonomous admission at startup.
    // Leave per-turn facts replayable until their receipt can own the output.
    if (!Number.isInteger(turn) || run) database.markProjectedEvent(sessionId, event.seq)
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
    if (isNativeNotice(event.data)) {
      const run = database.runForMessage(sessionId, event.data.id) ?? database.activeRunBySession(sessionId)
      if (run) for (const item of nativePresentation(run, event)) database.appendEvent(chat.ownerId, run.id, item)
    }
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

  const reading = contextUsage(context)
  if (event.type === 'request/context' && reading) {
    const run = database.activeRun(chat.ownerId, chat.id)
    if (!run) return undefined
    return database.appendEvent(chat.ownerId, run.id, {
      event: 'workbench_context', workbench_run_id: run.id, phase: 'request', ...reading,
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
      return append(presentRunEvent({ event: 'workbench_end', status, error, occurred_at: event.time,
        ...(event.data?.reason?.error?.code ? { error_code: event.data.reason.error.code } : {}) }))
    }
    case 'deliverables/presented':
    case 'workspace/changes': {
      const payload = nativePresentation(run, event)[0]
      return payload && append(payload)
    }
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
      if (reading || usage) return append({
        event: 'workbench_context', workbench_run_id: run.id, phase: 'usage',
        ...(reading ?? {
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

/** Only a fresh autonomous receipt needs a new frozen MCP catalog. */
export function claimNeedsResources(database, { agent, message, turn }, ownerId) {
  const sessionId = agent?.session?.id ?? agent?.id
  const chat = database.getChatBySession(sessionId)
  if (!chat || chat.ownerId !== ownerId || database.getRun(ownerId, message?.id)) return false
  if (message?.source?.kind === 'schedule') return true
  if (isNativeNotice(message) && !noticeParent(database, chat, message)) return false
  return (message?.source?.kind === 'tool-jobs' || isNativeNotice(message))
    && !database.runForTurn(sessionId, turn)
}

/** Shared, side-effect-free display projection for live events and native history pages. */
export function projectInboxClaim(database, { agent, message, turn }, expectedOwnerId, context) {
  const run = applyInboxClaim(database, { agent, message, turn }, expectedOwnerId, context)
  const replay = nativeReplays.get(database)
  if (run && replay?.sessions.has(agent?.session?.id ?? agent?.id)) replay.claimedRuns.add(run.id)
  return run
}

function applyInboxClaim(database, { agent, message, turn }, expectedOwnerId, context) {
  const sessionId = agent?.session?.id ?? agent?.id
  if (!Number.isInteger(turn) || typeof message?.id !== 'string') return undefined
  const chat = database.getChatBySession(sessionId)
  if (!chat || (expectedOwnerId && chat.ownerId !== expectedOwnerId)) return undefined
  let run
  if (message.source?.kind === 'tool-jobs') {
    // The native job plugin targets the Agent currently registered for its
    // owner. A busy turn consumes the notice in-place; an idle owner starts a
    // fresh turn with current permissions, never a revoked earlier run.
    run = database.runForTurn(sessionId, turn) ?? adoptJobNotice(database, chat, message, context)
    if (run) run = database.bindNativeTurn(run, turn)
  }
  if (isNativeNotice(message)) {
    run = database.runForTurn(sessionId, turn) ?? adoptNativeNotice(database, chat, message, context)
    if (run) run = database.bindNativeTurn(run, turn)
  }
  if (message.source?.kind === 'schedule') {
    const scheduled = adoptMessage(database, sessionId, message, context)
    const current = database.runForTurn(sessionId, turn)
    if (scheduled) {
      run = database.bindRunMessage(sessionId, scheduled.id, turn, message.id)
      if (current && current.id !== scheduled.id) {
        if (run.status !== 'steered') {
          database.transitionRun(chat.ownerId, scheduled.id, 'steered')
          database.appendEvent(chat.ownerId, scheduled.id, { event: 'workbench_steered', steer_target_run_id: current.id })
          database.appendEvent(chat.ownerId, current.id, { event: 'workbench_steering', steering_id: scheduled.id,
            query: scheduled.query, attachments: [] })
        }
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
    const admitted = database.runForMessage(sessionId, message.id) ?? nativeCommandRun(sessionId)
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

function adoptJobNotice(database, chat, message, context) {
  if (chat.deletedAt || message?.source?.kind !== 'tool-jobs' || typeof message.id !== 'string') return
  const existing = database.getRun(chat.ownerId, message.id)
  if (existing) return existing.sessionId === chat.sessionId ? existing : undefined
  // Pre-step waits for the native MCP catalog before freezing a new receipt.
  // Replays of an existing receipt do not need another catalog read.
  if (context?.mcpCatalogReady === false) return
  const { run } = database.createRun({ ownerId: chat.ownerId, chatId: chat.id, sessionId: chat.sessionId,
    id: message.id, requestKey: `native-job-notice:${message.id}`, query: contentText(message.content),
    selection: { ...chat.selection, native_source: 'tool-jobs', native_notice: true,
      native_child: false, subagent_ids: [], is_continuation: true, silent_resume: true },
    mcpTools: context?.mcpTools ?? [] })
  database.adoptInboxMessage(chat.sessionId, run.id, message.id)
  return run
}
function noticeParent(database, chat, message) {
  return database.runForSubagent(chat.ownerId, chat.id, message.source.senderSessionId)
}
function adoptNativeNotice(database, chat, message, context) {
  if (chat.deletedAt || !isNativeNotice(message) || typeof message.id !== 'string') return
  const match = database.listRunReferences(chat.ownerId, chat.id).find(run => run.id === message.id)
  const existing = match && database.getRun(chat.ownerId, match.id)
  if (existing) return existing
  const parent = noticeParent(database, chat, message)
  // The native inbox starts a new turn after the old task has settled. Retain
  // child ownership but acquire fresh permissions; never reopen its old receipt.
  if (!parent || context?.mcpCatalogReady === false) return
  const { run } = database.createRun({ ownerId: chat.ownerId, chatId: chat.id, sessionId: chat.sessionId,
    id: message.id, requestKey: `native-notice:${message.id}`, query: contentText(message.content),
    parentRunId: parent.id, selection: { ...chat.selection, native_child: false, subagent_ids: [], native_notice: true,
      native_source: message.source.kind, native_sender_session_id: message.source.senderSessionId,
      subagent_names: parent.selection?.subagent_names ?? {}, silent_resume: true }, mcpTools: context?.mcpTools ?? [] })
  database.adoptInboxMessage(chat.sessionId, run.id, message.id)
  return run
}

function adoptMessage(database, sessionId, message, context) {
  if (message?.source?.kind === 'schedule' && typeof message.id === 'string') {
    const chat = database.getChatBySession(sessionId)
    if (!chat) return
    if (context?.mcpCatalogReady === false && !database.getRun(chat.ownerId, message.id)) return
    // A display/admission receipt for a message DSH already delivered. Never enqueue it again.
    const { run } = database.createRun({ ownerId: chat.ownerId, chatId: chat.id, sessionId,
      id: message.id, requestKey: `schedule:${message.id}`, query: contentText(message.content),
      selection: { ...chat.selection, native_source: 'schedule', schedule_notification_pending: true,
        schedule_occurrences: scheduleOccurrences(contentText(message.content)) }, mcpTools: context?.mcpTools ?? [] })
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
      mentioned_resources: goalMentionResources(database.goalRun(sessionId), goal.objective),
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
export async function reconcileNativeSessions(database, sessionQuery, ownerId, context, startupRunIds, archivedSessionIds = () => []) {
  const chats = database.listChats(ownerId)
  const replay = nativeReplays.get(database) ?? {
    ownerId, sessions: new Set(), events: new Map(), queue: [],
    snapshotSteps: new Set(), claimedRuns: new Set(), endedRuns: new Set(),
    initialRunIds: startupRunIds ?? chats.flatMap(chat => database.listRunReferences(ownerId, chat.id).map(run => run.id)),
  }
  if (replay.running || replay.ownerId !== ownerId) throw new Error('Native session recovery is already running')
  for (const chat of chats) replay.sessions.add(chat.sessionId)
  replay.running = true
  nativeReplays.set(database, replay)
  try {
    const queued = await reconcileNativeSessionSnapshots(database, sessionQuery, ownerId, context, archivedSessionIds, replay)
    let drained = 0
    for (const entry of replay.queue) {
      if (entry.applied) continue
      if (++drained % 32 === 0) await yieldToEventLoop()
      if (entry.apply) entry.apply()
      else applySessionEvent(database, entry.sessionId, entry.event, entry.expectedOwnerId, entry.context)
      acknowledgeReplayEntry(database, replay, entry)
    }
    // An observed inbox may predate a buffered completion. Do not revive that
    // completed receipt or classify it as interrupted from the stale snapshot.
    const pending = queued.filter(id => !replay.claimedRuns.has(id) && (!replay.endedRuns.has(id)
      || ['queued', 'running', 'waiting_input', 'stopping'].includes(database.getRun(ownerId, id)?.status)))
    database.recoverInterrupted(Date.now(), pending, replay.initialRunIds.filter(id => !replay.claimedRuns.has(id)))
    nativeReplays.delete(database)
    return pending
  } finally { replay.running = false }
}

function acknowledgeReplayEntry(database, replay, entry) {
  if (Number.isInteger(entry.event?.seq) && !database.hasProjectedEvent(entry.sessionId, entry.event.seq)) return
  if (entry.event?.type === 'turn/end') {
    const run = database.runForTurn(entry.sessionId, entry.event.data.turn)
    if (run) replay.endedRuns.add(run.id)
  }
  entry.applied = true
}

async function reconcileNativeSessionSnapshots(database, sessionQuery, ownerId, context, archivedSessionIds, replay) {
  const chats = database.listChats(ownerId)
  const queued = []
  let replayed = 0
  for (const chat of chats) {
    const resources = message => {
      if ((!['schedule', 'tool-jobs'].includes(message?.source?.kind) && !isNativeNotice(message)) || database.getRun(ownerId, message.id)) return undefined
      if (isNativeNotice(message) && !noticeParent(database, chat, message)) return undefined
      return typeof context === 'function' ? context() : context
    }
    let observed
    try { observed = await sessionQuery.observeSession(chat.sessionId) }
    catch (error) {
      if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') continue
      // Archival prevents native execution and retains the original history.
      // A damaged, settled archive must not deny this owner's healthy chats.
      // Read current archival state after the async query; never infer it from
      // a failed task or ignore unreadable history needed by unfinished work.
      if (error?.code === 'SESSION_QUERY_CORRUPT_SESSION'
        && archivedSessionIds().includes(chat.sessionId)
        && !database.activeRun(ownerId, chat.id)) continue
      throw error
    }
    try {
      const events = observed.events ?? []
      // Observe may yield while native timers bind new receipts. Capture the
      // message index after it returns, then reuse it during this synchronous
      // replay rather than decoding every run once for every user message.
      const byMessage = new Map(database.listRunReferences(chat.ownerId, chat.id)
        .filter(run => run.messageId).map(run => [run.messageId, run]))
      const inbox = { 'next-turn': [], 'next-step': [] }
      let turn
      // Claims are transient notifications. Reconstruct the turn relation from
      // the durable user/message records before replaying their projected output.
      for (const event of events) {
        // Large transcripts must leave time for native SSH lease heartbeats and
        // health requests. A microtask yield alone does not service that I/O.
        if (++replayed % 32 === 0) await yieldToEventLoop()
        if (event.type === 'agent/inbox/spliced') {
          const data = event.data
          inbox[data.target].splice(data.start, data.removedCount ?? 0, ...(data.inserted ?? []))
        }
        if (event.type === 'turn/start') turn = event.data.turn
        if (event.type === 'user/message' && Number.isInteger(turn)) {
          const message = event.data
          const admitted = message.source?.kind === 'schedule' ? adoptMessage(database, chat.sessionId, message, resources(message))
            : message.source?.kind === 'tool-jobs' ? (database.runForTurn(chat.sessionId, turn) ?? adoptJobNotice(database, chat, message, resources(message)))
            : isNativeNotice(message) ? (database.runForTurn(chat.sessionId, turn) ?? adoptNativeNotice(database, chat, message, resources(message)))
            : byMessage.get(message.id)
          if (isNativeNotice(message) && admitted) database.bindNativeTurn(admitted, turn)
          if (message.source?.kind === 'tool-jobs' && admitted) database.bindNativeTurn(admitted, turn)
          if (message.source?.kind === 'schedule' && admitted)
            applyInboxClaim(database, { agent: { id: chat.sessionId }, message, turn }, ownerId)
          if (runPromptId(message) || (message.source?.kind === 'user' && admitted))
            database.bindRunMessage(chat.sessionId, message.source.rpcId ?? admitted.id, turn, message.id)
          else if (message.source?.kind === 'goal' || (message.source?.kind === 'user' && !message.source.rpcId)) {
            const run = database.goalRun(chat.sessionId)
            if (run) database.bindNativeTurn(run, turn)
          }
        }
      }
      for (const event of events) {
        if (++replayed % 32 === 0) await yieldToEventLoop()
        // Observe can include a fact that also arrived through the live listener.
        // Preserve its captured plan/goal/context before acknowledging the seq.
        const buffered = replay.events.get(chat.sessionId)?.get(eventIdentity(event))
        if (buffered?.applied) continue
        const eventContext = buffered?.context
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
              applySessionEvent(database, chat.sessionId, event, ownerId, eventContext)
            })()
            replay.snapshotSteps.add(streamStep(chat.sessionId, event.data.turn, event.data.step))
            if (buffered) acknowledgeReplayEntry(database, replay, buffered)
            continue
          }
        }
        if (event.type === 'agent/inbox/spliced')
          for (const message of event.data?.inserted ?? [])
            if (message.source?.kind === 'schedule') adoptMessage(database, chat.sessionId, message, resources(message))
        applySessionEvent(database, chat.sessionId, event, ownerId, eventContext)
        if (event.type === 'assistant/message') replay.snapshotSteps.add(streamStep(chat.sessionId, event.data.turn, event.data.step))
        if (buffered) acknowledgeReplayEntry(database, replay, buffered)
      }
      for (const message of [...inbox['next-turn'], ...inbox['next-step']]) {
        if (++replayed % 32 === 0) await yieldToEventLoop()
        const requestId = runPromptId(message)
        const run = requestId ? database.getRun(ownerId, requestId)
          : message.source?.kind === 'schedule' ? adoptMessage(database, chat.sessionId, message, resources(message))
          : message.source?.kind === 'tool-jobs' ? adoptJobNotice(database, chat, message, resources(message))
          : isNativeNotice(message) ? adoptNativeNotice(database, chat, message, resources(message))
          : byMessage.get(message.id)
        if (run && run.sessionId === chat.sessionId) {
          queued.push(run.id)
          database.adoptInboxMessage(chat.sessionId, run.id, message.id)
        }
      }
    } finally { observed[Symbol.dispose]?.() }
  }
  return queued
}

/** Resolve all preserved roots before starting any; retries must not interrupt a partially resumed batch. */
export async function prepareRecoveredInboxes(database, sessions, ownerId, runIds, archivedSessionIds = () => []) {
  const agents = new Map()
  const pending = run => run?.status === 'queued' && run.messageId && !run.stopConfirmation?.fenced
    && !archivedSessionIds().includes(run.sessionId)
  for (const id of runIds) {
    const run = database.getRun(ownerId, id)
    if (!pending(run) || agents.has(run.sessionId)) continue
    const resolved = await sessions.resolveAgent(run.sessionId)
    if ('error' in resolved) throw resolved.error
    if (typeof resolved.agent.resumePending !== 'function') throw new Error('DSH inbox recovery preparation is missing')
    agents.set(run.sessionId, resolved.agent)
  }
  // No messages are inserted or replayed. Native claim and pre-step admission
  // still validate the durable receipt, cancellation, resources and capacity.
  return () => {
    const eligible = new Set(runIds.map(id => database.getRun(ownerId, id)).filter(pending).map(run => run.sessionId))
    for (const [sessionId, agent] of agents) if (eligible.has(sessionId)) agent.resumePending()
  }
}
