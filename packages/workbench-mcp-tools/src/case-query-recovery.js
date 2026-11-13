import { createHash } from 'node:crypto'

const CASE_TOOLS = new Set(['case_search', 'case_detail', 'case_guarantors', 'case_defendants',
  'case_repayments', 'case_relations', 'case_aggregate', 'case_export'])
const STOP_CODES = new Set(['CASE_QUERY_TIMEOUT', 'CASE_QUERY_FAILED', 'DEADLINE_EXCEEDED'])
const MAX_ARGUMENT_FAILURES = 3

export const isCaseQuery = tool => tool.scope === 'global' && tool.server_id === 'gxzs-case' && CASE_TOOLS.has(tool.tool_name)

const signature = (tool, args) => createHash('sha256').update(JSON.stringify([tool.tool_name, args], (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex')

export function caseQueryFailure(code, message, recoveryAction = 'stop') {
  const detail = { code, message, retryable: false, recoveryAction,
    recovery: recoveryAction === 'correct_arguments'
      ? '仅修正错误参数，保留用户日期、人员/部门及其他业务条件'
      : '停止本任务自动查询并报告失败；新的用户指令作为新任务处理，不得改条件后继续尝试' }
  return { isError: true, structuredContent: detail, content: [{ type: 'text', text: JSON.stringify(detail) }] }
}

/** Built-in case queries only. Recovery is scoped to the authorized owner/run,
 * survives Host restart, and shares the owning run's deletion lifecycle. */
export class CaseQueryRecovery {
  constructor(database) {
    this.db = database?.db
    this.memory = new Map()
    this.db?.exec(`CREATE TABLE IF NOT EXISTS case_query_recovery (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
      blocked_code TEXT, failed_signature TEXT)`)
  }

  state(ownerId, runId) {
    return this.db
      ? this.db.prepare('SELECT * FROM case_query_recovery WHERE run_id=? AND owner_id=?').get(runId, ownerId)
      : this.memory.get(`${ownerId}\0${runId}`)
  }

  blocked(ownerId, runId) {
    const state = this.state(ownerId, runId)
    return Boolean(state?.blocked_code || state?.failures >= MAX_ARGUMENT_FAILURES)
  }

  before(authorization, tool, args) {
    if (!isCaseQuery(tool)) return undefined
    const state = this.state(authorization.ownerId, authorization.runId)
    if (this.blocked(authorization.ownerId, authorization.runId))
      return caseQueryFailure('CASE_QUERY_HALTED', `本任务查询已停止（${state.blocked_code ?? '参数纠错次数已用完'}）；未执行新的数据库查询`)
    if (state?.failed_signature === signature(tool, args))
      return this.record(authorization, tool, args,
        caseQueryFailure('INVALID_ARGUMENT', '相同参数已经失败，未重复执行；请仅修正已指出的参数问题', 'correct_arguments'))
    return undefined
  }

  record(authorization, tool, args, result) {
    if (!isCaseQuery(tool) || result?.isError !== true) return result
    let failure = result.structuredContent
    if (!failure?.code) {
      for (const block of result.content ?? []) {
        if (block.type !== 'text') continue
        try { const parsed = JSON.parse(block.text); if (typeof parsed?.code === 'string') { failure = parsed; break } } catch {}
      }
    }
    if (!failure?.code) return result
    const { ownerId, runId } = authorization
    const previous = this.state(ownerId, runId)
    const failures = (previous?.failures ?? 0) + (failure.code === 'INVALID_ARGUMENT' ? 1 : 0)
    const blockedCode = previous?.blocked_code
      ?? (STOP_CODES.has(failure.code) || failure.recoveryAction === 'stop' ? failure.code : null)
    const state = { failures, blocked_code: blockedCode, failed_signature: signature(tool, args) }
    if (this.db) this.db.prepare(`INSERT INTO case_query_recovery(run_id,owner_id,failures,blocked_code,failed_signature)
      VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET failures=excluded.failures,
      blocked_code=excluded.blocked_code,failed_signature=excluded.failed_signature WHERE owner_id=excluded.owner_id`)
      .run(runId, ownerId, failures, blockedCode, state.failed_signature)
    else {
      this.memory.set(`${ownerId}\0${runId}`, state)
      if (this.memory.size > 256) this.memory.delete(this.memory.keys().next().value)
    }
    return result
  }
}
