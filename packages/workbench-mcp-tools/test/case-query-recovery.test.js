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

  it.each(['memory', 'sqlite'])('retains alternating failed arguments across %s recovery', storage => {
    const database = storage === 'sqlite' ? new WorkbenchDatabase(':memory:') : undefined
    let owner = auth
    if (database) {
      cleanup.push(database)
      const chat = database.createChat({ ownerId: auth.ownerId, sessionId: 's1', selection: {} })
      const { run } = database.createRun({ ownerId: auth.ownerId, chatId: chat.id, sessionId: 's1', query: 'q', selection: {} })
      owner = { ...auth, runId: run.id }
    }
    let guard = new CaseQueryRecovery(database)
    for (const pageSize of [100, 50]) guard.record(owner, tool, { pageSize },
      { isError: true, structuredContent: { code: 'RESULT_TOO_LARGE', recoveryAction: 'reduce_result' } })
    if (database) guard = new CaseQueryRecovery(database)
    expect(guard.before(owner, tool, { pageSize: 10 })).toBeUndefined()
    for (const pageSize of [100, 50, 100]) expect(guard.before(owner, tool, { pageSize }))
      .toMatchObject({ isError: true, structuredContent: { code: 'INVALID_ARGUMENT' } })
    expect(guard.blocked(owner.ownerId, owner.runId)).toBe(true)
    expect(guard.before({ ...owner, runId: 'new-run' }, tool, { pageSize: 100 })).toBeUndefined()
  })

  it('retains the first invalid arguments after another set has failed', () => {
    const guard = new CaseQueryRecovery()
    for (const field of ['a', 'b']) guard.record(auth, tool, { field }, caseQueryFailure('INVALID_ARGUMENT', 'field', 'correct_arguments'))
    expect(guard.before(auth, tool, { field: 'a' })).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_ARGUMENT' } })
    expect(guard.blocked(auth.ownerId, auth.runId)).toBe(true)
  })

  it('persists across runtime reconstruction and is deleted with the owning run', () => {
    const database = new WorkbenchDatabase(':memory:')
    cleanup.push(database)
    const chat = database.createChat({ ownerId: 't:1', sessionId: 's1', selection: {} })
    const { run } = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's1', query: 'q', selection: {} })
    const owner = { ownerId: 't:1', runId: run.id }
    const initial = new CaseQueryRecovery(database)
    initial.record(owner, tool, {}, caseQueryFailure('INVALID_ARGUMENT', 'field', 'correct_arguments'))
    const [legacySignature] = JSON.parse(initial.state(owner.ownerId, owner.runId).failed_signature)
    database.db.prepare('UPDATE case_query_recovery SET failed_signature=? WHERE run_id=?').run(legacySignature, run.id)
    const restored = new CaseQueryRecovery(database)
    expect(restored.before(owner, tool, {})).toMatchObject({ isError: true, structuredContent: { code: 'INVALID_ARGUMENT' } })
    restored.record(owner, tool, { field: 'sj' }, caseQueryFailure('CASE_QUERY_TIMEOUT', 'timeout'))
    expect(restored.blocked(owner.ownerId, owner.runId)).toBe(true)
    expect(restored.blocked('t:2', owner.runId)).toBe(false)
    database.db.prepare('DELETE FROM runs WHERE id=?').run(run.id)
    expect(restored.state(owner.ownerId, owner.runId)).toBeUndefined()
  })
})
