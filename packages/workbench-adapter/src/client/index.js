import { compactionSummary, contentText, fileToolPreparation, nativePresentation } from '../display-events.js'

export const inject = []
export function apply() {}

/** One mounted native detail owns this cache. Immutable append-only prefixes
 * reuse their decoded file arguments; paging, retirement and replacement reset
 * them. No session data is retained by the presenter module after unmount. */
export function createSessionWindowPresenter() {
  let previous = [], prepared = []
  const attempts = new Map()
  return (entries, context) => {
    if (previous.length > entries.length || previous.some((entry, index) => entry !== entries[index])) {
      previous = []; prepared = []; attempts.clear()
    }
    for (let index = previous.length; index < entries.length; index++) {
      const event = entries[index].event
      const { chunk, attemptId, turn, step } = event.data ?? {}
      let data
      if (event.type === 'assistant/live-chunk' && chunk.type === 'tool-call-delta') {
        let attempt = attempts.get(attemptId)
        if (!attempt) attempts.set(attemptId, attempt = { turn, step, calls: new Map() })
        data = fileToolPreparation({ id: '' }, attempt.calls, chunk, event.time)
      } else if (event.type === 'assistant/message' || event.type === 'turn/end') {
        for (const [id, attempt] of attempts) {
          if (attempt.turn === turn && (event.type === 'turn/end' || attempt.step === step)) attempts.delete(id)
        }
      }
      prepared.push(data)
    }
    previous = [...entries]
    return presentSessionWindow(entries, context, prepared)
  }
}

/** Pure Vue display projection of the original Session event window.
 * Window ownership, surface folding, transient retirement and pagination stay in DSH.
 */
export function presentSessionWindow(entries, { sessionId, chatId, parentSessionId, running, selection = {}, mcpTools = [] }, prepared) {
  const runs = new Map(), tools = new Map(), preparations = new Map(), compactions = new Map()
  const streamedSteps = new Set(entries.filter(({ event }) => event.type === 'assistant/live-chunk').map(({ event }) => `${event.data.turn}:${event.data.step}`))
  let turn
  const runFor = event => {
    if (Number.isInteger(event.data?.turn)) turn = event.data.turn
    if (!Number.isInteger(turn)) return
    let run = runs.get(turn)
    if (!run) {
      run = { id: `${sessionId}:turn:${turn}`, chat_id: chatId, revision_id: '', version: 1, query: '',
        status: running ? 'running' : 'completed', activity_protocol: 1, events: [], created_at: event.time / 1000,
        selection: { ...selection, parent_session_id: parentSessionId }, mcpTools }
      runs.set(turn, run)
    }
    return run
  }
  for (const [entryIndex, { event }] of entries.entries()) {
    if (event.type === 'compaction/summary') compactions.set(event.data.compactionId, event.data)
    const run = runFor(event)
    if (!run) continue
    const checkpoint = event.type === 'user/message' && event.surfaceOp?.op === 'replace' ? event.data.source : undefined
    if (checkpoint?.kind === 'compact-checkpoint' && !checkpoint.sourceCommandId) {
      run.events.push({ event: 'workbench_compaction', _id: `history:${sessionId}:${event.seq}:compact`,
        compaction_id: checkpoint.compactionId, ...compactionSummary(compactions.get(checkpoint.compactionId)) })
      continue
    }
    if (event.type === 'turn/start') run.started_at = event.time / 1000
    if (event.type === 'user/message' && !run.messageId && ['user', 'agent-message', 'subagent-settled'].includes(event.data?.source?.kind)) {
      run.messageId = event.data.id; run.message_id = event.data.id
      run.query = event.data.source.kind === 'user' ? contentText(event.data.content) : ''
      run.is_continuation = event.data.source.kind !== 'user'
      run.attachments = (event.data.content ?? []).filter(block => block.type === 'image' && block.attachment).map(block => ({
        name: block.attachment.name || `图片.${block.attachment.mediaType.split('/').at(-1)}`, size: block.attachment.bytes,
        path: `native-image:${block.attachment.attachmentId}`, native_image: { parentChatId: chatId, childId: sessionId, ref: block.attachment },
      }))
    }
    if (event.type === 'turn/end') {
      run.status = ({ completed: 'completed', aborted: 'cancelled', interrupted: 'interrupted' })[event.data.reason?.kind] ?? 'failed'
      run.completed_at = event.time / 1000
    }
    if (event.type === 'assistant/live-chunk') {
      const { chunk, attemptId, step } = event.data
      let data
      if (chunk.type === 'tool-call-delta') {
        if (prepared) {
          const value = prepared[entryIndex]
          if (value) data = { ...value, workbench_run_id: run.id }
        } else {
          let calls = preparations.get(attemptId)
          if (!calls) preparations.set(attemptId, calls = new Map())
          data = fileToolPreparation(run, calls, chunk, event.time)
        }
      } else if (['text-delta', 'reasoning-delta'].includes(chunk.type) && chunk.text) {
        data = { kind: chunk.type === 'text-delta' ? 'text' : 'reasoning', workbench_run_id: run.id, text: chunk.text }
      }
      if (data) run.events.push({ event: 'workbench_activity', _id: `stream:${sessionId}:${attemptId}:${event.seq}`, data: {
        ...data, native_attempt: attemptId, segment_id: `t${turn}s${step}a${attemptId}:b${chunk.index}`,
      } })
      continue
    }
    if (event.type === 'tool/call') tools.set(event.data.callId, event.data.name)
    const callId = event.data?.message?.source?.callId ?? event.data?.message?.content?.[0]?.toolCallId
    for (const [index, value] of nativePresentation(run, event, { toolName: tools.get(callId) ?? '', streamed: streamedSteps.has(`${event.data?.turn}:${event.data?.step}`) }).entries()) {
      run.events.push({ ...value, _id: `history:${sessionId}:${event.seq}:${index}` })
    }
  }
  return [...runs.values()]
}
