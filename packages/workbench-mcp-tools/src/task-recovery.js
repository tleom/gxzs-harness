import { createHash } from 'node:crypto'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'

export const isTaskRecoveryName = name => name === 'resume_mcp_task' || /^resume_mcp_task_[a-f0-9]{16}$/.test(name)

/** Native scoped recovery entry point for task receipts retained after a lost turn. */
export function taskRecoveryScopes(ctx, journal, resume) {
  const scopes = new Map()
  const dispose = agent => { scopes.get(agent)?.dispose(); scopes.delete(agent) }
  const sync = agent => {
    dispose(agent)
    const runtime = ctx.workbenchRuntime
    const pending = journal?.pending(runtime.ownerId)
    if (!pending?.length) return
    const run = runtime.executionRun?.(agent?.session?.id ?? agent?.id)
    const tools = agent?.ctx?.get?.('tools')
    if (!journal || !run || !tools || run.ownerId !== runtime.ownerId
      || run.status !== 'running' || run.stopConfirmation?.fenced) return
    const disposers = []
    try {
      for (const tool of run.mcpTools ?? []) {
        const records = pending.filter(record => tool.id === record.resourceId && tool.version === record.version
          && tool.manifest_version === record.manifestVersion)
        if (!records.length) continue
        const name = `resume_mcp_task_${createHash('sha256').update(tool.id).digest('hex').slice(0, 16)}`
        // Reuse the same native result validation, error and attachment projection as the original tool.
        disposers.push(tools.register(createMcpToolDefinition(agent.ctx, { name, rawName: tool.tool_name,
          description: `恢复 ${tool.tool_name} 已有任务并读取结果。可恢复引用：${JSON.stringify(records.map(record => record.ref))}`,
          inputSchema: { type: 'object', properties: { task_ref: { type: 'string', description: '可恢复任务引用' } },
            required: ['task_ref'], additionalProperties: false },
          outputSchema: tool.outputSchema,
          call: async (args, exec) => {
            const record = records.find(item => item.ref === args.task_ref)
            if (!record) throw new Error('MCP 任务引用无效')
            return resume(record, exec)
          },
        })))
      }
      scopes.set(agent, { dispose: () => { for (const stop of disposers) stop() } })
    } catch (error) { for (const stop of disposers) stop(); throw error }
  }
  return { sync, dispose, clear: () => { for (const agent of scopes.keys()) dispose(agent) } }
}
