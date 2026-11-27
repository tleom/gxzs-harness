import { ClientAssistantStream } from './dsh/client-assistant-stream.js'
import { fileToolPreparation, nativePresentation } from './projection.js'
import { compactionSummary } from './native-command.js'
import { historyDisplayEvent } from './history-transport.js'

/** Map native publication decisions to existing Workbench display records. */
export class HistoryPresentation {
  constructor(sessionId, resolveRun, resolveToolName = () => undefined, resolveMessage = () => undefined, resolveStreamRun = resolveRun) {
    this.sessionId = sessionId
    this.resolveRun = resolveRun
    this.resolveToolName = resolveToolName
    this.resolveMessage = resolveMessage
    this.resolveStreamRun = resolveStreamRun
    this.stream = new ClientAssistantStream()
    this.attempt = undefined
    this.lastAssistantSeq = -1
    this.tools = new Map()
    this.preparations = new Map()
    this.compactions = new Map()
    this.revision = 0
  }

  accept(frame) {
    const display = { replace: frame.type === 'snapshot', events: [], retire_attempts: [] }
    const retire = attemptId => {
      if (this.attempt?.attemptId !== attemptId) return
      this.attempt = undefined
      this.preparations.delete(attemptId)
      display.retire_attempts.push(attemptId)
    }
    // A reconnect snapshot can replay thousands of chunks from the same turn.
    // Resolve its immutable view once per frame, not once per chunk. Keeping the
    // map local also re-observes changed bindings/presentation on the next frame.
    const runs = new Map(), streamRuns = new Map()
    const project = entry => {
      const event = entry.event
      const message = event.type === 'assistant/message'
      if (message && event.seq <= this.lastAssistantSeq) return
      if (event.type === 'compaction/summary') this.compactions.set(event.data.compactionId, event.data)
      if (Number.isInteger(event.data?.turn)) this.turn = event.data.turn
      const turn = event.data?.turn ?? this.turn
      // A live chunk uses only run.id. Decoding its frozen MCP catalog on every
      // token makes generation compete with health/catalog requests on the Host.
      const live = event.type === 'assistant/live-chunk'
      if (live && event.data.attemptId !== this.attempt?.attemptId) return
      const cache = live ? streamRuns : runs
      if (!cache.has(turn)) cache.set(turn, live ? this.resolveStreamRun(turn) : this.resolveRun(turn))
      const run = cache.get(turn)
      if (!run) return
      const checkpoint = event.type === 'user/message' && event.surfaceOp?.op === 'replace' ? event.data.source : undefined
      if (checkpoint?.kind === 'compact-checkpoint' && !checkpoint.sourceCommandId) {
        display.events.push({ run_id: run.id, event: { event: 'workbench_compaction',
          _id: `history:${this.sessionId}:${event.seq}:compact`, compaction_id: checkpoint.compactionId,
          ...compactionSummary(this.compactions.get(checkpoint.compactionId)) } })
        return
      }
      if (event.type === 'assistant/live-chunk') {
        const { chunk, attemptId, turn, step } = event.data
        if (chunk.type === 'tool-call-delta') {
          let calls = this.preparations.get(attemptId)
          if (!calls) this.preparations.set(attemptId, calls = new Map())
          const data = fileToolPreparation(run, calls, chunk, event.time)
          if (data) display.events.push({ run_id: run.id, event: {
            event: 'workbench_activity', _id: `stream:${this.sessionId}:${attemptId}:${event.seq}`,
            data: { ...data, native_attempt: attemptId, segment_id: `t${turn}s${step}a${attemptId}:b${chunk.index}` },
          } })
          return
        }
        if (!['text-delta', 'reasoning-delta'].includes(chunk.type) || !chunk.text) return
        display.events.push({ run_id: run.id, event: {
          event: 'workbench_activity', _id: `stream:${this.sessionId}:${attemptId}:${event.seq}`,
          data: { kind: chunk.type === 'text-delta' ? 'text' : 'reasoning',
            workbench_run_id: run.id, native_attempt: attemptId,
            segment_id: `t${turn}s${step}a${attemptId}:b${chunk.index}`, text: chunk.text },
        } })
        return
      }
      if (message) {
        this.lastAssistantSeq = event.seq
        const attempt = this.attempt
        if (attempt && (event.surfaceOp == null || event.surfaceOp === 'append')
          && attempt.turn === event.data.turn && attempt.step === event.data.step && event.seq > attempt.startedAfterSeq)
          retire(attempt.attemptId)
      }
      if (event.type === 'tool/call') this.tools.set(`${run.id}:${event.data.callId}`, event.data.name)
      const callId = event.data?.message?.source?.callId ?? event.data?.message?.content?.[0]?.toolCallId
      for (const [index, value] of nativePresentation(run, event, { toolName: this.tools.get(`${run.id}:${callId}`) ?? this.resolveToolName(run, callId) ?? '',
        messageRun: event.type === 'user/message' ? this.resolveMessage(event.data?.id) : undefined }).entries())
        display.events.push({ run_id: run.id, event: { ...historyDisplayEvent(value), _id: `history:${this.sessionId}:${event.seq}:${index}` } })
    }
    if (frame.type === 'snapshot') {
      this.turn = undefined
      this.lastAssistantSeq = -1
      this.tools.clear()
      this.preparations.clear()
      this.compactions.clear()
      this.revision = frame.assistantStream?.revision ?? 0
      this.attempt = frame.assistantStream?.activeAttempt
      for (const entry of this.stream.replace(frame.records, frame.assistantStream)) project(entry)
      return display
    }
    let result
    if (frame.type === 'event') {
      result = this.stream.acceptDurable(frame)
      // The committed message contains the complete reply. Keep validating the
      // transient stream, and publish the durable text as soon as it arrives.
      if (frame.event.type === 'assistant/message' && !result) project(frame)
    } else if (frame.type === 'assistant-stream') {
      const value = frame.frame
      if (value.revision !== this.revision + 1) throw new Error('Native assistant stream requires a fresh baseline')
      this.revision = value.revision
      if (value.type === 'start') this.attempt = value
      result = this.stream.acceptFrame(value)
    }
    if (result?.type === 'rebaseline') throw new Error('Native assistant stream requires a fresh baseline')
    if (result?.entry) project(result.entry)
    if (result?.type === 'abandonment' || result?.type === 'settlement') retire(result.attemptId)
    if (result?.retireAttemptId) retire(result.retireAttemptId)
    return display
  }
}
