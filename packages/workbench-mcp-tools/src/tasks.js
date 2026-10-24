import { createHash } from 'node:crypto'
import { withTasks, toolDeclaration, resultFromTaskOutcome, TaskFailedError } from '@modelcontextprotocol/ext-tasks/client'
import { hasTaskToolCallCapabilityV1 } from '@modelcontextprotocol/ext-tasks/core/v1'
import { hasTaskServerCapabilityV2 } from '@modelcontextprotocol/ext-tasks/core/v2'

export function taskCapabilities(server) {
  if (server?.protocol_version >= '2026-07-28') {
    const capabilities = server.capabilities?.extensions?.['io.modelcontextprotocol/tasks']
    return hasTaskServerCapabilityV2(server.capabilities) ? { generation: 'v2', capabilities } : { generation: 'none' }
  }
  const capabilities = server?.capabilities?.tasks ?? {}
  return hasTaskToolCallCapabilityV1(capabilities) ? { generation: 'v1', capabilities } : { generation: 'none' }
}

const terminal = state => ['completed', 'failed', 'cancelled'].includes(state)

/** Recovery receipts live with the owning run and never replay a dispatched creation. */
export class McpTaskJournal {
  constructor(database) {
    this.db = database.db
    this.activeCalls = new Set()
    this.db.exec(`CREATE TABLE IF NOT EXISTS mcp_task_executions (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL, owner_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state_json TEXT NOT NULL, PRIMARY KEY(run_id, call_id))`)
  }
  claim(owner, run, call, fingerprint) {
    const inserted = this.db.prepare('INSERT OR IGNORE INTO mcp_task_executions VALUES (?, ?, ?, ?, ?)')
      .run(run, call, owner, fingerprint, JSON.stringify({ state: 'dispatched' })).changes === 1
    const row = this.db.prepare('SELECT owner_id, fingerprint, state_json FROM mcp_task_executions WHERE run_id=? AND call_id=?').get(run, call)
    if (row.owner_id !== owner || row.fingerprint !== fingerprint) throw new Error('MCP 任务恢复参数不匹配')
    return { ...JSON.parse(row.state_json), inserted }
  }
  save(owner, run, call, value) {
    const changed = this.db.prepare('UPDATE mcp_task_executions SET state_json=? WHERE owner_id=? AND run_id=? AND call_id=?')
      .run(JSON.stringify(value), owner, run, call).changes
    if (changed !== 1) throw new Error('MCP 任务恢复记录已失效')
  }
  pending(owner) {
    return this.db.prepare(`SELECT run_id, call_id, state_json FROM mcp_task_executions
      WHERE owner_id=? AND json_extract(state_json, '$.reference') IS NOT NULL
      AND json_extract(state_json, '$.result') IS NULL
      AND COALESCE(json_extract(state_json, '$.state'), '') NOT IN ('completed', 'failed', 'cancelled')
      AND json_extract(state_json, '$.definition.expiresAt') > ?`).all(owner, Date.now())
      .flatMap(row => {
        const state = JSON.parse(row.state_json)
        return state.reference && !state.result && state.definition
          ? [{ runId: row.run_id, callId: row.call_id, ref: `${row.run_id}:${row.call_id}`, ...state.definition }] : []
      })
  }
}

export async function executeMcpTask(options) {
  const { journal, exec, authorization } = options
  if (!journal || !exec.callId) throw new Error('MCP 任务恢复服务不可用')
  const key = JSON.stringify([authorization.ownerId, authorization.runId, exec.callId])
  const active = journal.activeCalls
  if (active.has(key)) throw new Error('MCP 任务正在执行')
  active.add(key)
  try { return await execute(options) }
  finally { active.delete(key) }
}

async function execute({ tool, server, args, exec, authorization, journal, dispatch, controlTimeoutMs }) {
  if (!journal || !exec.callId) throw new Error('MCP 任务恢复服务不可用')
  const endpointId = JSON.stringify([authorization.ownerId, server.id, server.version, server.manifest_version])
  const fingerprint = createHash('sha256').update(JSON.stringify([endpointId, tool.tool_name, args], (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort()) : value)).digest('hex')
  const capabilities = taskCapabilities(server)
  if (capabilities.generation === 'none') throw new Error('MCP 服务未声明任务能力')
  const { ownerId, runId } = authorization
  let saved = journal.claim(ownerId, runId, exec.callId, fingerprint)
  if (saved.result) return saved.result
  if (terminal(saved.state)) return resultFromTaskOutcome({ status: saved.state,
    ...(saved.error ? { error: new TaskFailedError(saved.error.message, saved.error) } : {}) })
  if (!saved.inserted && !saved.reference) throw new Error('MCP 任务创建结果未知，请核实外部状态；本次不会重复执行')
  const declaration = toolDeclaration({ name: tool.tool_name, inputSchema: tool.sourceInputSchema ?? tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}), taskSupport: tool.execution?.taskSupport })
  let cancellationSnapshot, inputRequired = false
  const saveOutcome = outcome => {
    // SDK failures also include transport/result-read errors. Only remote terminal
    // evidence, or a retrieved result, may retire a recoverable receipt.
    if (outcome.status !== 'completed' && !['failed', 'cancelled'].includes(outcome.task?.status)) return
    saved = { ...saved, state: outcome.status, ...(outcome.status === 'completed' ? { result: outcome.result } : {}),
      ...(outcome.error ? { error: { message: outcome.error.message, code: outcome.error.code, data: outcome.error.data } } : {}) }
    journal.save(ownerId, runId, exec.callId, saved)
  }
  const port = {
    endpointId, invalidated: false,
    taskCapabilities: capabilities,
    onNotification: () => () => {}, onServerRequest: () => () => {}, onInvalidated: () => () => {},
    async dispatch(request, options) {
      const response = await dispatch(request, options, saved.ticket)
      if (request.method === 'tasks/cancel') cancellationSnapshot = response.result
      if (response.task_ticket) {
        saved = { ...saved, ticket: response.task_ticket }
        journal.save(ownerId, runId, exec.callId, saved)
      }
      return response.error ? { kind: 'error', error: response.error } : { kind: 'result', result: response.result }
    },
  }
  const session = withTasks(port, { tools: { currentTool: () => declaration } })
  let execution
  try {
    execution = saved.reference ? await session.resumeTask(saved.reference, { declaration })
      : await session.callTool(tool.tool_name, args, { declaration, signal: exec.signal })
    if (execution.kind === 'task') {
      saved = { ...saved, state: 'active', reference: execution.serializeReference(),
        definition: { resourceId: tool.id, version: tool.version, manifestVersion: tool.manifest_version, args,
          expiresAt: saved.definition?.expiresAt ?? exec.deadlineMs ?? Date.now() + 350000 } }
      journal.save(ownerId, runId, exec.callId, saved)
    }
    const { outcome } = await execution.settle({ signal: exec.signal, close: false, onEvent: event => {
      if (event.type === 'task' && event.task.status === 'input_required') {
        inputRequired = true
        throw new Error('此 MCP 任务需要用户交互，当前仅支持无需交互的任务')
      }
    } })
    saveOutcome(outcome)
    return resultFromTaskOutcome(outcome)
  } catch (error) {
    if ((exec.signal?.aborted || inputRequired) && execution?.kind === 'task' && !terminal(saved.state)) {
      try {
        await execution.cancel(AbortSignal.timeout(controlTimeoutMs))
        // The official V1 cancel parser has validated this snapshot and task id.
        // V2 accepts cooperative cancellation without proving a terminal state.
        if (capabilities.generation === 'v1' && ['failed', 'cancelled'].includes(cancellationSnapshot?.status)) {
          saveOutcome({ status: cancellationSnapshot.status, task: cancellationSnapshot,
            ...(cancellationSnapshot.status === 'failed' ? { error: new TaskFailedError(cancellationSnapshot.statusMessage ?? 'Task failed') } : {}) })
        } else journal.save(ownerId, runId, exec.callId, { ...saved, state: 'cancel_requested' })
      } catch { journal.save(ownerId, runId, exec.callId, { ...saved, state: 'cancel_unknown' }) }
    }
    throw error
  } finally {
    if (execution?.kind === 'task') {
      await execution.detach()
      await execution.result().catch(() => {})
    }
    await session.close()
  }
}
