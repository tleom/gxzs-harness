import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { createAssistantStreamProjector, projectInboxClaim, projectSessionEvent } from '../src/projection.js'
import { resourceTextHash } from '../src/resource-mentions.js'

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
  it.each([false, true])('replays file announcements without advertising unavailable fork comparisons (inherited=%s)', inherited => {
    const { database, chat, run } = setup()
    if (inherited) database.updateRunResources(run, { fork_source: { sessionId: 'original', endSeq: 19 } }, [])
    bind(database, chat, run)
    const change = { type: 'workspace/changes', seq: 15, data: { turn: 1 } }
    expect(() => projectSessionEvent(database, chat.sessionId, change)).not.toThrow()
    expect(database.allEvents(chat.ownerId, run.id).filter(event => event.event === 'workbench_changes')).toHaveLength(inherited ? 0 : 1)
    projectSessionEvent(database, chat.sessionId, { type: 'deliverables/presented', seq: 16, data: { turn: 1, files: [{ path: 'report.md' }] } })
    expect(database.allEvents(chat.ownerId, run.id)).toContainEqual(expect.objectContaining({ event: 'workbench_presented' }))
  })
  it('carries goal tag positions through native control events and drops stale positions after an objective edit', () => {
    const { database, chat, run } = setup()
    const mentions = [{ kind: 'skills', id: 'official-docx', name: '公文排版', offset: 2 }]
    database.updateRunResources(run, { command: 'goal', mentioned_resources: mentions, resource_position_hash: resourceTextHash('排版用这个') }, [])
    database.setGoalRun(chat.sessionId, run.id)
    const change = objective => projectSessionEvent(database, chat.sessionId, { type: 'goal/change', data: {
      operation: 'edit', goal: { id: 'goal', revision: 1, phase: 'paused', objective },
    } })
    change('排版用这个')
    expect(database.getControl(chat.ownerId, chat.id).goal.mentioned_resources).toEqual(mentions)
    change('新的目标内容')
    expect(database.getControl(chat.ownerId, chat.id).goal.mentioned_resources)
      .toEqual([{ kind: 'skills', id: 'official-docx', name: '公文排版' }])
  })
  it('persists only gauge fields instead of copying the frozen MCP catalog into every context reading', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    const reading = { used_tokens: 1200, window_tokens: 128000, estimated: true, model: 'p/m' }
    const context = { ...reading, mcpCatalogReady: true, mcpTools: [{ inputSchema: { description: 'x'.repeat(513420) } }] }
    projectSessionEvent(database, chat.sessionId, { type: 'request/context', seq: 11, data: {} }, chat.ownerId, context)
    projectSessionEvent(database, chat.sessionId, { type: 'assistant/message', seq: 12,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'reply' }] } } }, chat.ownerId, context)
    const events = database.allEvents(chat.ownerId, run.id).filter(event => event.event === 'workbench_context')
    expect(events).toHaveLength(2)
    for (const event of events) {
      expect(event).toMatchObject(reading)
      expect('mcpTools' in event).toBe(false)
      expect('mcpCatalogReady' in event).toBe(false)
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(512)
    }
    expect(context.mcpTools[0].inputSchema.description.length).toBe(513420)
  })
  it('replays a disarmed goal completion before interrupted-run recovery without live context', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    database.setGoalRun(chat.sessionId, run.id)
    projectSessionEvent(database, chat.sessionId, { type: 'goal/change', seq: 11,
      data: { operation: 'update', goal: { id: 'goal', revision: 2, objective: 'work', phase: 'active', activation: 'disarmed' } } })
    projectSessionEvent(database, chat.sessionId, { type: 'turn/end', seq: 12,
      data: { turn: 1, reason: { kind: 'completed' } } })
    database.recoverInterrupted()
    expect(database.getControl(chat.ownerId, chat.id).goal.activation).toBe('disarmed')
    expect(database.getRun(chat.ownerId, run.id).status).toBe('completed')
  })

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

  it('publishes a file preparation record before complete arguments or a tool call exist', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    const project = createAssistantStreamProjector(database, chat.ownerId)
    const agent = { id: chat.sessionId }
    project({ agent, frame: { type: 'start', attemptId: 'a', turn: 1, step: 1 } })
    project({ agent, frame: { type: 'chunk', attemptId: 'a', chunk: { type: 'tool-call-delta', index: 0, id: 'write', name: 'write', argumentsDelta: '{' } } })
    database.flushStreamEvents()
    expect(database.eventsAfter(chat.ownerId, run.id, 0).find(entry => entry.data?.kind === 'tool').data)
      .toMatchObject({ stage: 'preparing', call_id: 'write', argument_chars: 1, segment_id: 't1s1aa:b0' })
    expect(database.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE run_id=?').get(run.id).n).toBe(0)
    projectSessionEvent(database, chat.sessionId, { type: 'tool/call', data: { turn: 1, callId: 'write', name: 'write', arguments: '{"path":"data.js","content":"done"}' } })
    expect(database.eventsAfter(chat.ownerId, run.id, 0).filter(entry => entry.data?.kind === 'tool').map(entry => entry.data.stage)).toEqual(['preparing', 'started'])
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

  it.each([true, false])('preserves native ToolResultMessage isError=%s without error metadata', (isError) => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    projectSessionEvent(database, chat.sessionId, {
      type: 'tool/call', data: { turn: 1, callId: 'native-result', name: 'read', arguments: {} },
    })
    projectSessionEvent(database, chat.sessionId, { type: 'tool/result', data: {
      turn: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'native-result' },
        toolCallId: 'native-result', content: [{ type: 'text', text: 'tool response' }], isError },
    } })
    expect(database.eventsAfter(chat.ownerId, run.id, 0).at(-1).data).toMatchObject({
      tool_name: 'read', call_id: 'native-result', stage: isError ? 'error' : 'returned', output: 'tool response',
    })
    expect(database.getRun(chat.ownerId, run.id).status).toBe('running')
  })

  it('preserves DSH result metadata for typed frontend cards', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    const meta = { path: '/workspace/a.txt', lines: [{ number: 1, text: 'hello' }], totalLines: 1 }
    projectSessionEvent(database, chat.sessionId, { type: 'tool/call', data: { turn: 1, callId: 'read-1', name: 'read', arguments: { file_path: meta.path } } })
    projectSessionEvent(database, chat.sessionId, { type: 'tool/result', data: {
      turn: 1, meta, message: { source: { callId: 'read-1' }, content: [{ toolCallId: 'read-1', content: [{ type: 'text', text: '1: hello' }] }] },
    } })
    expect(database.eventsAfter(chat.ownerId, run.id, 0).at(-1).data).toMatchObject({ tool_name: 'read', output: '1: hello', result_meta: meta })
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
      type: 'session/title', data: { title: '合同证据整理', messageSeqs: [0], source: { kind: 'provider' } },
    })
    expect(database.getChat(chat.ownerId, chat.id).title).toBe('合同证据整理')
    expect(event).toMatchObject({
      event: 'workbench_chat_title', chat_id: chat.id, title: '合同证据整理',
    })
    expect(database.eventsAfter(chat.ownerId, run.id, 0)).toContainEqual(expect.objectContaining({
      event: 'workbench_chat_title', title: '合同证据整理',
    }))
  })

  it('projects the native fallback and persists a generated title after completion', () => {
    const { database, chat, run } = setup()
    database.updateChat(chat.ownerId, chat.id, { title: '检索资料，核对结论' })
    projectSessionEvent(database, chat.sessionId, {
      type: 'session/title', data: { title: '检索资料，核对结论 User selected', source: { kind: 'fallback' } },
    })
    expect(database.getChat(chat.ownerId, chat.id).title).toBe('检索资料，核对结论 User selected')
    database.transitionRun(chat.ownerId, run.id, 'completed')
    projectSessionEvent(database, chat.sessionId, {
      type: 'session/title', data: { title: '资料核对', source: { kind: 'provider' } },
    })
    expect(database.getChat(chat.ownerId, chat.id).title).toBe('资料核对')
  })

  it('projects complete token-meter readings for the context gauge', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    const requestContext = {
      used_tokens: 1200, window_tokens: 128000, estimated: true, model: 'bailian/qwen3.8-flash',
    }
    expect(projectSessionEvent(database, chat.sessionId, {
      type: 'request/context', data: { provider: 'bailian', model: 'qwen3.8-flash', contextWindow: 128000 },
    }, undefined, requestContext)).toMatchObject({
      event: 'workbench_context', phase: 'request', ...requestContext,
    })
    const settledContext = { ...requestContext, used_tokens: 1600, estimated: false }
    projectSessionEvent(database, chat.sessionId, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, usage: { inputTokens: 1500, outputTokens: 100 }, message: { content: [] } },
    }, undefined, settledContext)
    expect(database.eventsAfter(chat.ownerId, run.id, 0).at(-1)).toMatchObject({
      event: 'workbench_context', phase: 'usage', ...settledContext,
    })
  })

  it('folds session control events without requiring a turn', () => {
    const { database, chat } = setup()
    projectSessionEvent(database, chat.sessionId, { type: 'todo/write', data: { todos: [{ content: '调查', status: 'in_progress' }] } })
    projectSessionEvent(database, chat.sessionId, {
      type: 'goal/change',
      data: {
        kind: 'goal/change', version: 1, operation: 'create', roundsStarted: 2,
        createdAt: 10_000, updatedAt: 12_000,
        goal: { id: 'g1', revision: 3, objective: '完成迁移', phase: 'active', maxGoalRounds: 6 },
      },
    })
    projectSessionEvent(database, chat.sessionId, { type: 'plan/mode', data: { active: true } }, undefined, { plan: { active: true, pending: false } })
    projectSessionEvent(database, chat.sessionId, { type: 'compaction/start', data: { compactionId: 'c1', turn: null } })
    projectSessionEvent(database, chat.sessionId, { type: 'compaction/summary', data: { compactionId: 'c1', summary: [{ type: 'text', text: 'summary' }], shadowedTokenCount: 200 } })
    projectSessionEvent(database, chat.sessionId, { type: 'compaction/end', data: { compactionId: 'c1', turn: null } })
    expect(database.getControl(chat.ownerId, chat.id)).toMatchObject({
      revision: 6,
      todos: [{ content: '调查', status: 'in_progress' }],
      goal: {
        id: 'g1', revision: 3, objective: '完成迁移', phase: 'active',
        max_rounds: 6, rounds_started: 2, reason: null,
        last_run_id: null,
      },
      plan: { active: true, pending: false },
      compaction: { id: 'c1', phase: 'compacted', message: 'summary', before_tokens: 200, after_tokens: null },
    })
  })

  it('persists explicit DSH deliveries for replay', () => {
    const { database, chat, run } = setup()
    bind(database, chat, run)
    projectSessionEvent(database, chat.sessionId, { type: 'deliverables/presented', data: {turn: 1, callId: 'present', files: [{path: '/workspace/report.docx', description: '报告'}]} })
    expect(database.allEvents(chat.ownerId, run.id)).toContainEqual(expect.objectContaining({ event: 'workbench_presented', files: [{path:'/workspace/report.docx',description:'报告'}] }))
  })

  it('ignores unbound turn events and unknown sessions', () => {
    const { database, chat } = setup()
    expect(projectSessionEvent(database, chat.sessionId, { type: 'turn/start', data: { turn: 9 } })).toBeUndefined()
    expect(projectSessionEvent(database, 'other', { type: 'turn/start', data: { turn: 1 } })).toBeUndefined()
  })
})

it('projects native change coordinates once onto the owning run',()=>{
  const {database,chat,run}=setup()
  bind(database,chat,run)
  const event={type:'workspace/changes',seq:12,data:{turn:1}}
  expect(projectSessionEvent(database,chat.sessionId,event,chat.ownerId)).toMatchObject({event:'workbench_changes',turn:1,source_seq:12})
  expect(projectSessionEvent(database,chat.sessionId,event,chat.ownerId)).toBeUndefined()
})
