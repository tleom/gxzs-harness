import { expect, it, vi } from 'vitest'
import { taskRecoveryScopes } from '../src/task-recovery.js'

it('offers retained tasks only in an authorized run and uses their exact saved receipt', async () => {
  const record = { ref: 'old-run:old-call', runId: 'old-run', callId: 'old-call', resourceId: 'global:mcp:reports:make', version: '1', manifestVersion: 'm', args: {} }
  const journal = { pending: vi.fn(() => [record]) }
  const run = { id: 'new-run', ownerId: 'owner', status: 'running', mcpTools: [{ id: record.resourceId, version: '1', manifest_version: 'm', tool_name: 'make',
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] }
  const definitions = new Map(), resume = vi.fn(async value => ({ content: [{ type: 'text', text: value.ref }], structuredContent: { value: value.ref } }))
  const agent = { id: 'agent', ctx: { tools: { register: definition => {
    definitions.set(definition.name, definition); return () => definitions.delete(definition.name)
  } } } }
  agent.ctx.get = name => name === 'tools' ? agent.ctx.tools : undefined
  const scopes = taskRecoveryScopes({ workbenchRuntime: { ownerId: 'owner', executionRun: () => run } }, journal, resume)
  scopes.sync(agent)
  const tool = [...definitions.values()][0]
  expect(tool.name).toMatch(/^resume_mcp_task_[a-f0-9]{16}$/)
  expect(tool.output.schema.properties.structuredContent).toEqual(run.mcpTools[0].outputSchema)
  await expect(tool.execute({ task_ref: record.ref }, { agent })).resolves.toEqual({ content: [{ type: 'text', text: record.ref }], structuredContent: { value: record.ref } })
  expect(resume).toHaveBeenCalledWith(record, { agent })
  await expect(tool.execute({ task_ref: 'other' }, { agent })).rejects.toThrow('引用无效')
  resume.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'provider failed' }] })
  await expect(tool.execute({ task_ref: record.ref }, { agent })).rejects.toThrow('provider failed')
  resume.mockResolvedValueOnce({ content: 'invalid' })
  await expect(tool.execute({ task_ref: record.ref }, { agent })).rejects.toThrow('invalid MCP result')
  run.ownerId = 'other-owner'
  scopes.sync(agent)
  expect(definitions.size).toBe(0)
  run.ownerId = 'owner'; run.mcpTools[0].version = '2'
  scopes.sync(agent)
  expect(definitions.size).toBe(0)
})
