import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { createAssistantStreamProjector, projectInboxClaim, projectSessionEvent } from '../src/projection.js'

const opened = []
afterEach(() => opened.splice(0).forEach((database) => database.close()))

function setup() {
  const database = new WorkbenchDatabase(':memory:')
  opened.push(database)
  const chat = database.createChat({ ownerId: 'tenant:user', sessionId: 'session-1', selection: {} })
  const { run } = database.createRun({ ownerId: chat.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'q', selection: {} })
  return { database, chat, run }
}

function bind(database, chat, run, turn = 1) {
  const message = { id: `message-${turn}`, source: { kind: 'user', rpcId: run.id } }
  projectSessionEvent(database, chat.sessionId, { type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [message] } })
  projectSessionEvent(database, chat.sessionId, { type: 'turn/start', seq: turn * 10, data: { turn } })
  projectInboxClaim(database, { agent: { id: chat.sessionId }, message, turn })
  projectSessionEvent(database, chat.sessionId, { type: 'user/message', data: message })
}

describe('DSH session event projection', () => {
  it('moves the exact bound run through start and completion', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    projectSessionEvent(database, chat.sessionId, { type: 'turn/start', data: { turn: 1 } })
    expect(database.getRun(chat.ownerId, run.id)).toMatchObject({ status: 'running', sourceStartSeq: 10 })
    expect(projectSessionEvent(database, chat.sessionId, { type: 'turn/end', seq: 19, data: { turn: 1, reason: { kind: 'completed' } } }))
      .toMatchObject({ event: 'workbench_end', status: 'completed', _id: expect.any(String) })
    expect(database.getRun(chat.ownerId, run.id)).toMatchObject({ status: 'completed', sourceEndSeq: 19 })
  })

  it('adopts queued message ids before any turn consumes them', () => {
    const { database, chat, run } = setup()
    projectSessionEvent(database, chat.sessionId, {
      type: 'agent/inbox/spliced', data: { target: 'next-turn', inserted: [{ id: 'pending-message', source: { kind: 'user', rpcId: run.id } }] },
    })
    expect(database.getRun(chat.ownerId, run.id)).toMatchObject({ messageId: 'pending-message', status: 'queued' })
    expect(database.getRun(chat.ownerId, run.id).turnNumber).toBeUndefined()
  })

  it('rejects non-user inbox sources and mismatched host owners', () => {
    const { database, chat, run } = setup()
    projectSessionEvent(database, chat.sessionId, {
      type: 'agent/inbox/spliced', data: { inserted: [{ id: 'bad', source: { kind: 'plugin', rpcId: run.id } }] },
    }, chat.ownerId)
    expect(database.getRun(chat.ownerId, run.id).messageId).toBeUndefined()
    projectSessionEvent(database, chat.sessionId, {
      type: 'agent/inbox/spliced', data: { inserted: [{ id: 'other-owner', source: { kind: 'user', rpcId: run.id } }] },
    }, 'other:owner')
    expect(database.getRun(chat.ownerId, run.id).messageId).toBeUndefined()
  })

  it('does not leak delayed events across two queued runs', () => {
    const { database, chat, run: first } = setup()
    const { run: second } = database.createRun({ ownerId: chat.ownerId, chatId: chat.id, sessionId: chat.sessionId, query: 'second', selection: {} })
    bind(database, chat, first, 1)
    bind(database, chat, second, 2)
    projectSessionEvent(database, chat.sessionId, { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'second' }] } } })
    projectSessionEvent(database, chat.sessionId, { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'late first' }] } } })
    expect(database.eventsAfter(chat.ownerId, first.id, 0).find((entry) => entry.data?.kind === 'text').data.text).toBe('late first')
    expect(database.eventsAfter(chat.ownerId, second.id, 0).find((entry) => entry.data?.kind === 'text').data.text).toBe('second')
  })

  it('treats max-token termination as a failure instead of a completed answer', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    projectSessionEvent(database, chat.sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
    expect(database.getRun(chat.ownerId, run.id)).toMatchObject({ status: 'failed', error: '任务结束：max-tokens' })
  })

  it('projects live text and reasoning deltas without committed-message duplication', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    const project = createAssistantStreamProjector(database, chat.ownerId)
    const agent = { id: chat.sessionId }
    project({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
    project({ agent, frame: { type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } } })
    project({ agent, frame: { type: 'chunk', attemptId: 'a1', revision: 3, index: 1, time: 2, chunk: { type: 'text-delta', index: 1, text: 'answer' } } })
    project({ agent, frame: { type: 'end', attemptId: 'a1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } } })
    projectSessionEvent(database, chat.sessionId, {
      type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] } },
    })
    const narrative = database.eventsAfter(chat.ownerId, run.id, 0).filter((entry) => ['text', 'reasoning'].includes(entry.data?.kind))
    expect(narrative.map((entry) => [entry.data.kind, entry.data.text])).toEqual([['reasoning', 'think'], ['text', 'answer']])
  })

  it('resets abandoned attempt fragments and permits committed retry backfill', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    const project = createAssistantStreamProjector(database, chat.ownerId)
    const agent = { id: chat.sessionId }
    project({ agent, frame: { type: 'start', attemptId: 'failed', revision: 1, turn: 1, step: 1 } })
    project({ agent, frame: { type: 'chunk', attemptId: 'failed', revision: 2, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } } })
    const reset = project({ agent, frame: { type: 'end', attemptId: 'failed', revision: 3, index: 1, outcome: { kind: 'abandoned' } } })
    expect(reset).toMatchObject({ event: 'workbench_stream_reset', segment_prefix: 't1s1afailed:' })
    projectSessionEvent(database, chat.sessionId, {
      type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'retry answer' }] } },
    })
    const events = database.eventsAfter(chat.ownerId, run.id, 0)
    expect(events.some((entry) => entry.data?.text === 'retry answer')).toBe(true)
  })

  it('persists tool names between call and result events', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    projectSessionEvent(database, chat.sessionId, { type: 'tool/call', data: { turn: 1, callId: 'call-1', name: 'bash', arguments: { command: 'pwd' } } })
    projectSessionEvent(database, chat.sessionId, {
      type: 'tool/result',
      data: { turn: 1, message: { source: { callId: 'call-1' }, content: [{ toolCallId: 'call-1', content: [{ type: 'text', text: '/workspace' }] }] } },
    })
    const events = database.eventsAfter(chat.ownerId, run.id, 0)
    const tools = events.filter((entry) => entry.data?.kind === 'tool')
    expect(tools[0].data).toMatchObject({ tool_name: 'bash', stage: 'started' })
    expect(tools[1].data).toMatchObject({ tool_name: 'bash', stage: 'returned', output: '/workspace' })
  })

  it('records surface replacement metadata without deleting transcript events', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    database.appendEvent(chat.ownerId, run.id, { event: 'workbench_activity', data: { kind: 'text', text: 'original' } })
    projectSessionEvent(database, chat.sessionId, {
      type: 'user/message', seq: 99, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 8 }, sourceEventSeqs: [2, 4, 8],
      data: { id: 'summary-message', role: 'user', source: { kind: 'compaction' }, content: [{ type: 'text', text: 'summary' }] },
    })
    const events = database.eventsAfter(chat.ownerId, run.id, 0)
    expect(events.some((entry) => entry.data?.text === 'original')).toBe(true)
    expect(events.at(-1)).toMatchObject({ event: 'workbench_surface_replace', start_seq: 2, end_seq: 8, replacement_seq: 99 })
  })

  it('projects DSH titles into chat history and the active run stream', () => {
    const { database, chat, run } = setup()
    const event = projectSessionEvent(database, chat.sessionId, {
      type: 'session/title', data: { title: '合同证据整理', messageSeqs: [0], source: { kind: 'fallback' } },
    })
    expect(database.getChat(chat.ownerId, chat.id).title).toBe('合同证据整理')
    expect(event).toMatchObject({
      event: 'workbench_chat_title', chat_id: chat.id, title: '合同证据整理',
    })
    expect(database.eventsAfter(chat.ownerId, run.id, 0)).toContainEqual(expect.objectContaining({
      event: 'workbench_chat_title', title: '合同证据整理',
    }))
  })

  it('folds session control events without requiring a turn', () => {
    const { database, chat } = setup()
    projectSessionEvent(database, chat.sessionId, { type: 'todo/write', data: { todos: [{ content: '调查', status: 'in_progress' }] } })
    projectSessionEvent(database, chat.sessionId, { type: 'goal/change', data: { operation: 'create', goal: { id: 'g1', objective: '完成迁移', phase: 'active' } } })
    projectSessionEvent(database, chat.sessionId, { type: 'plan/mode', data: { active: true } })
    projectSessionEvent(database, chat.sessionId, { type: 'compaction/start', data: { compactionId: 'c1', turn: null } })
    projectSessionEvent(database, chat.sessionId, { type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: 'summary' }], shadowedTokenCount: 200 } })
    projectSessionEvent(database, chat.sessionId, { type: 'compaction/end', data: { compactionId: 'c1', turn: null } })
    expect(database.getControl(chat.ownerId, chat.id)).toMatchObject({
      revision: 6,
      todos: [{ content: '调查', status: 'in_progress' }],
      goal: { id: 'g1', objective: '完成迁移', phase: 'active' },
      plan: { active: true },
      compaction: { id: 'c1', phase: 'compacted', message: 'summary', before_tokens: 200, after_tokens: null },
    })
  })

  it('ignores unbound turn events and unknown sessions', () => {
    const { database, chat } = setup()
    expect(projectSessionEvent(database, chat.sessionId, { type: 'turn/start', data: { turn: 9 } })).toBeUndefined()
    expect(projectSessionEvent(database, 'other', { type: 'turn/start', data: { turn: 1 } })).toBeUndefined()
  })
})
