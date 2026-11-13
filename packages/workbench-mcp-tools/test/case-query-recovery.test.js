import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../../workbench-adapter/src/persistence.js'
import { CaseQueryRecovery, caseQueryFailure } from '../src/case-query-recovery.js'

const tool = { scope: 'global', server_id: 'gxzs-case', tool_name: 'case_aggregate' }
const auth = { ownerId: 't:1', runId: 'run-1' }
const cleanup = []
afterEach(() => { for (const database of cleanup.splice(0)) database.close() })

describe('Case query recovery', () => {
  it('stops changed conditions and alternate case tools after timeout, but scopes the stop to its owner/run', () => {
    const guard = new CaseQueryRecovery()
    const args = { where: { field: 'sj', op: 'gte', value: '2026-10-01' } }
    guard.record(auth, tool, args, caseQueryFailure('CASE_QUERY_TIMEOUT', 'timeout'))
    expect(guard.before(auth, { ...tool, tool_name: 'case_export' }, {})).toMatchObject({ isError: true, structuredContent: { code: 'CASE_QUERY_HALTED' } })
    expect(guard.before({ ...auth, runId: 'run-2' }, tool, args)).toBeUndefined()
    expect(guard.before({ ...auth, ownerId: 't:2' }, tool, args)).toBeUndefined()
    expect(guard.before(auth, { ...tool, scope: 'personal' }, args)).toBeUndefined()
    expect(guard.before(auth, { ...tool, server_id: 'web-search' }, args)).toBeUndefined()
  })

  it('allows bounded corrections, refuses reordered repeats and never unlocks after a late success', () => {
    const guard = new CaseQueryRecovery()
    guard.record(auth, tool, { entity: 'hkjl', path: ['zqxx', 'hkjl'] }, caseQueryFailure('INVALID_ARGUMENT', 'path', 'correct_arguments'))
    expect(guard.before(auth, tool, { entity: 'zqxx', path: ['hkjl'] })).toBeUndefined()
    expect(guard.before(auth, tool, { path: ['zqxx', 'hkjl'], entity: 'hkjl' }).isError).toBe(true)
    guard.record(auth, tool, { bad: true }, caseQueryFailure('INVALID_ARGUMENT', 'field', 'correct_arguments'))
    guard.record(auth, tool, {}, { content: [{ type: 'text', text: 'late success' }] })
    expect(guard.blocked(auth.ownerId, auth.runId)).toBe(true)
  })

  it('preserves older backend timeout responses and permits smaller result requests', () => {
    const guard = new CaseQueryRecovery()
    guard.record(auth, tool, { pageSize: 100 }, { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'RESULT_TOO_LARGE' }) }] })
    expect(guard.before(auth, tool, { pageSize: 10 })).toBeUndefined()
    guard.record(auth, tool, {}, { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'CASE_QUERY_TIMEOUT', retryable: false }) }] })
    expect(guard.blocked(auth.ownerId, auth.runId)).toBe(true)
  })

  it('persists across runtime reconstruction and is deleted with the owning run', () => {
    const database = new WorkbenchDatabase(':memory:')
    cleanup.push(database)
    const chat = database.createChat({ ownerId: 't:1', sessionId: 's1', selection: {} })
    const { run } = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's1', query: 'q', selection: {} })
    const owner = { ownerId: 't:1', runId: run.id }
    new CaseQueryRecovery(database).record(owner, tool, {}, caseQueryFailure('CASE_QUERY_TIMEOUT', 'timeout'))
    const restored = new CaseQueryRecovery(database)
    expect(restored.blocked(owner.ownerId, owner.runId)).toBe(true)
    expect(restored.blocked('t:2', owner.runId)).toBe(false)
    database.db.prepare('DELETE FROM runs WHERE id=?').run(run.id)
    expect(restored.state(owner.ownerId, owner.runId)).toBeUndefined()
  })
})
