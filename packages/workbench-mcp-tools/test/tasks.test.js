import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { executeMcpTask, McpTaskJournal } from '../src/tasks.js'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE runs(id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('run')")
  const journal = new McpTaskJournal({ db })
  let state = 'working', failObservation = false, observedStatus = 'completed', failResult = false
  const methods = []
  const snapshot = () => ({ taskId: 'task', status: state, createdAt: '2026-10-24T00:00:00Z', lastUpdatedAt: '2026-10-24T00:00:00Z', ttl: 60000, pollInterval: 1 })
  const server = { id: 'personal:mcp:test', version: '1', manifest_version: 'm', protocol_version: '2025-11-25',
    capabilities: { tasks: { requests: { tools: { call: {} } }, cancel: {} } } }
  const parameters = { server, tool: { id: 'personal:mcp:test:report', version: '1', manifest_version: 'm',
    tool_name: 'report', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
    args: {}, exec: { callId: 'call', signal: new AbortController().signal, deadlineMs: Date.now() + 60000 }, authorization: { ownerId: 'owner', runId: 'run' },
    journal, controlTimeoutMs: 1000,
    dispatch: async request => {
      methods.push(request.method)
      if (request.method === 'tools/call') return { task_ticket: 'ticket', result: { task: snapshot() } }
      if (request.method === 'tasks/get') {
        if (failObservation) throw new Error('connection lost')
        state = observedStatus; return { result: snapshot() }
      }
      if (request.method === 'tasks/result') {
        if (failResult) throw new Error('result connection lost')
        return { result: { content: [{ type: 'text', text: 'done' }] } }
      }
      if (request.method === 'tasks/cancel') { state = 'cancelled'; return { result: snapshot() } }
      throw Error('unexpected method')
    } }
  return { db, methods, parameters, observationFails: value => { failObservation = value },
    resultFails: value => { failResult = value }, observes: value => { observedStatus = value },
    saved: () => JSON.parse(db.prepare('SELECT state_json FROM mcp_task_executions').get().state_json) }
}

describe('official MCP task execution', () => {
  for (const state of ['failed', 'cancelled']) it(`persists confirmed ${state} and replays the outcome without remote calls`, async () => {
    const f = fixture()
    f.observes(state)
    try {
      await expect(executeMcpTask(f.parameters)).rejects.toThrow()
      expect(f.saved().state).toBe(state)
      expect(f.parameters.journal.pending('owner')).toEqual([])
      const count = f.methods.length
      f.parameters.journal = new McpTaskJournal({ db: f.db })
      await expect(executeMcpTask(f.parameters)).rejects.toThrow()
      expect(f.methods).toHaveLength(count)
      expect(f.methods).not.toContain('tasks/result')
    } finally { f.db.close() }
  })
  it('retains recovery after completed when the final result could not be retrieved', async () => {
    const f = fixture()
    f.resultFails(true)
    try {
      await expect(executeMcpTask(f.parameters)).rejects.toThrow('result connection lost')
      expect(f.saved().state).toBe('active')
      expect(f.parameters.journal.pending('owner')).toHaveLength(1)
      f.resultFails(false)
      expect((await executeMcpTask(f.parameters)).content[0].text).toBe('done')
      expect(f.methods.filter(method => method === 'tools/call')).toHaveLength(1)
      expect(f.parameters.journal.pending('owner')).toEqual([])
    } finally { f.db.close() }
  })
  it('reports unsupported interaction and uses the existing cancellation path', async () => {
    const f = fixture()
    f.observes('input_required')
    try {
      await expect(executeMcpTask(f.parameters)).rejects.toThrow('当前仅支持无需交互')
      expect(f.methods).toContain('tasks/cancel')
      expect(f.saved().state).toBe('cancelled')
      expect(f.parameters.journal.pending('owner')).toEqual([])
    } finally { f.db.close() }
  })
  it('uses the current extension generation and its embedded final result', async () => {
    const f = fixture()
    f.parameters.server.protocol_version = '2026-07-28'
    f.parameters.server.capabilities = { extensions: { 'io.modelcontextprotocol/tasks': {} } }
    const task = { taskId: 'modern', createdAt: '2026-10-24T00:00:00Z', lastUpdatedAt: '2026-10-24T00:00:00Z', ttlMs: 60000, pollIntervalMs: 1 }
    f.parameters.dispatch = async request => {
      f.methods.push(request.method)
      if (request.method === 'tools/call') return { result: { ...task, status: 'working', resultType: 'task' }, task_ticket: 'ticket' }
      if (request.method === 'tasks/get') return { result: { ...task, status: 'completed', resultType: 'complete',
        result: { resultType: 'complete', content: [{ type: 'text', text: 'modern done' }] } } }
      throw new Error('unexpected lifecycle request')
    }
    try {
      expect((await executeMcpTask(f.parameters)).content[0].text).toBe('modern done')
      expect(f.methods).toEqual(['tools/call', 'tasks/get'])
    } finally { f.db.close() }
  })
  it('creates a required task, polls the reference and retains the final result without a second creation', async () => {
    const f = fixture()
    try {
      expect((await executeMcpTask(f.parameters)).content[0].text).toBe('done')
      expect((await executeMcpTask(f.parameters)).content[0].text).toBe('done')
      expect(f.methods.filter(method => method === 'tools/call')).toHaveLength(1)
    } finally { f.db.close() }
  })
  it('resumes an observed task after interruption without replaying tools/call', async () => {
    const f = fixture()
    try {
      f.observationFails(true)
      await expect(executeMcpTask(f.parameters)).rejects.toThrow('connection lost')
      expect(f.saved().state).toBe('active')
      expect(f.parameters.journal.pending('owner')).toHaveLength(1)
      f.observationFails(false)
      expect((await executeMcpTask(f.parameters)).content[0].text).toBe('done')
      expect(f.methods.filter(method => method === 'tools/call')).toHaveLength(1)
    } finally { f.db.close() }
  })
  it('does not replay a creation whose response was lost, or allow another owner to reuse its call', async () => {
    const f = fixture()
    try {
      f.parameters.dispatch = async () => { throw new Error('lost creation response') }
      await expect(executeMcpTask(f.parameters)).rejects.toThrow('lost creation response')
      await expect(executeMcpTask(f.parameters)).rejects.toThrow('创建结果未知')
      await expect(executeMcpTask({ ...f.parameters, authorization: { ownerId: 'other', runId: 'run' } })).rejects.toThrow('恢复参数不匹配')
    } finally { f.db.close() }
  })
  it('sends task cancellation when the native execution is aborted', async () => {
    const f = fixture(), stop = new AbortController()
    f.parameters.exec.signal = stop.signal
    const original = f.parameters.dispatch
    f.parameters.dispatch = async (request, options) => {
      if (request.method === 'tasks/get') { stop.abort(); throw stop.signal.reason }
      return original(request, options)
    }
    try {
      await expect(executeMcpTask(f.parameters)).rejects.toThrow()
      expect(f.methods).toContain('tasks/cancel')
      expect(f.saved().state).toBe('cancelled')
      expect(f.parameters.journal.pending('owner')).toEqual([])
    } finally { f.db.close() }
  })
  it('does not treat a modern cooperative cancel acknowledgement as remote termination', async () => {
    const f = fixture(), stop = new AbortController()
    f.parameters.exec.signal = stop.signal
    f.parameters.server.protocol_version = '2026-07-28'
    f.parameters.server.capabilities = { extensions: { 'io.modelcontextprotocol/tasks': {} } }
    f.parameters.dispatch = async request => {
      f.methods.push(request.method)
      if (request.method === 'tools/call') return { task_ticket: 'ticket', result: { resultType: 'task', taskId: 'modern', status: 'working',
        createdAt: '2026-10-24T00:00:00Z', lastUpdatedAt: '2026-10-24T00:00:00Z', ttlMs: 60000, pollIntervalMs: 1 } }
      if (request.method === 'tasks/get') { stop.abort(); throw stop.signal.reason }
      if (request.method === 'tasks/cancel') return { result: { resultType: 'complete' } }
      throw new Error('unexpected request')
    }
    try {
      await expect(executeMcpTask(f.parameters)).rejects.toThrow()
      expect(f.saved().state).toBe('cancel_requested')
      expect(f.parameters.journal.pending('owner')).toHaveLength(1)
    } finally { f.db.close() }
  })
})
