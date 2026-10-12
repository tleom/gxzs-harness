import { ClientAssistantStream } from './dsh/client-assistant-stream.js'
import { fileToolPreparation, nativePresentation } from './projection.js'
import { compactionSummary } from './native-command.js'

/** Map native publication decisions to existing Workbench display records. */
export class HistoryPresentation {
  constructor(sessionId, resolveRun, resolveToolName = () => undefined, resolveMessage = () => undefined) {
    this.sessionId = sessionId
    this.resolveRun = resolveRun
    this.resolveToolName = resolveToolName
    this.resolveMessage = resolveMessage
    this.stream = new ClientAssistantStream()
    this.attempts = new Map()
    this.tools = new Map()
    this.preparations = new Map()
    this.compactions = new Map()
    this.revision = 0
  }

  accept(frame) {
    const display = { replace: frame.type === 'snapshot', events: [], retire_attempts: [] }
    const project = entry => {
      const event = entry.event
      if (event.type === 'compaction/summary') this.compactions.set(event.data.compactionId, event.data)
      if (Number.isInteger(event.data?.turn)) this.turn = event.data.turn
      const run = this.resolveRun(event.data?.turn ?? this.turn)
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
          const data = fileToolPreparation(run, calls, chunk)
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
      if (event.type === 'assistant/message') {
        const attempt = this.attempts.get(`${event.data.turn}:${event.data.step}`)
        if (attempt) display.retire_attempts.push(attempt)
      }
      if (event.type === 'tool/call') this.tools.set(`${run.id}:${event.data.callId}`, event.data.name)
      const callId = event.data?.message?.source?.callId ?? event.data?.message?.content?.[0]?.toolCallId
      for (const [index, value] of nativePresentation(run, event, { toolName: this.tools.get(`${run.id}:${callId}`) ?? this.resolveToolName(run, callId) ?? '',
        messageRun: event.type === 'user/message' ? this.resolveMessage(event.data?.id) : undefined }).entries())
        display.events.push({ run_id: run.id, event: { ...value, _id: `history:${this.sessionId}:${event.seq}:${index}` } })
    }
    if (frame.type === 'snapshot') {
      this.turn = undefined
      this.attempts.clear(); this.tools.clear()
      this.preparations.clear()
      this.compactions.clear()
      this.revision = frame.assistantStream?.revision ?? 0
      const opening = frame.assistantStream?.activeAttempt
      if (opening) this.attempts.set(`${opening.turn}:${opening.step}`, opening.attemptId)
      for (const entry of this.stream.replace(frame.records, frame.assistantStream)) project(entry)
      return display
    }
    let result
    if (frame.type === 'event') result = this.stream.acceptDurable(frame)
    else if (frame.type === 'assistant-stream') {
      const value = frame.frame
      if (value.revision !== this.revision + 1) throw new Error('Native assistant stream requires a fresh baseline')
      this.revision = value.revision
      if (value.type === 'start') this.attempts.set(`${value.turn}:${value.step}`, value.attemptId)
      result = this.stream.acceptFrame(value)
    }
    if (result?.type === 'rebaseline') throw new Error('Native assistant stream requires a fresh baseline')
    if (result?.entry) project(result.entry)
    if (result?.type === 'abandonment' || result?.type === 'settlement') display.retire_attempts.push(result.attemptId)
    if (result?.retireAttemptId) display.retire_attempts.push(result.retireAttemptId)
    for (const attemptId of display.retire_attempts) this.preparations.delete(attemptId)
    return display
  }
}
