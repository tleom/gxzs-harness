import { expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { nativePresentation } from '../src/display-events.js'
import { registerToolDisplayReceipts } from '../src/tool-display-receipts.js'

it('uses the frozen catalog without rewriting large MCP resources for ordinary calls', async () => {
  const tool = { id: 'personal:mcp:records:search', runtime_name: 'search', provider_name: '资料库', tool_name: 'search' }
  const run = { id: 'run', ownerId: 'owner', mcpTools: [tool], selection: {} }
  const ctx = { on: vi.fn() }
  const database = { updateRunResources: vi.fn(), getRun: vi.fn(() => run) }
  registerToolDisplayReceipts(ctx, { database,
    runtime: { executionRun: () => run, mcpToolForName: () => tool }, ownerId: 'owner' })
  await ctx.on.mock.calls[0][1]({ name: 'search', callId: 'call', agent: { id: 'session' } }, async () => ({ kind: 'allow' }))
  expect(database.updateRunResources).not.toHaveBeenCalled()
})

it('preserves the actual MCP provider after its public alias changes and labels discovery separately', async () => {
  const database = new WorkbenchDatabase(':memory:')
  try {
    const chat = database.createChat({ ownerId: 'owner', sessionId: 'session', selection: {} })
    const { run } = database.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: 'session', selection: {}, query: 'search' })
    const ctx = { on: vi.fn() }
    const runtime = { executionRun: () => run,
      mcpToolForName: vi.fn(() => ({ id: 'personal:mcp:records:search', provider_name: '个人资料', tool_name: 'search' })) }
    registerToolDisplayReceipts(ctx, { database, runtime, ownerId: 'owner' })
    await ctx.on.mock.calls[0][1]({ name: 'search_new_alias', callId: 'mcp-call', agent: { id: 'session' } }, async () => ({ kind: 'allow' }))
    runtime.mcpToolForName.mockReturnValue({ id: 'global:mcp:other:lookup', provider_name: '子智能体资料', tool_name: 'lookup' })
    await ctx.on.mock.calls[0][1]({ name: 'child_alias', callId: 'mcp-call', agent: { id: 'child-session' } }, async () => ({ kind: 'allow' }))
    runtime.mcpToolForName.mockReturnValue(undefined)
    const frozen = database.getRun('owner', run.id)
    const event = { type: 'tool/result', data: { message: { source: { callId: 'mcp-call' }, content: [{ type: 'text', text: 'found' }] } } }
    expect(nativePresentation(frozen, event, { toolName: 'search_new_alias' })[0].data).toMatchObject({ provider_name: '个人资料', display_name: 'search' })
    expect(frozen.selection.tool_presentations['child-session']['mcp-call']).toMatchObject({ provider_name: '子智能体资料', display_name: 'lookup' })
    const search = { type: 'tool/call', data: { name: 'tool_search', callId: 'discovery', arguments: { query: 'records' } } }
    expect(nativePresentation(frozen, search)[0].data).toMatchObject({ display_name: '查找工具' })
    expect(nativePresentation(frozen, search)[0].data.provider_name).toBeUndefined()
  } finally { database.close() }
})

it('freezes an owned reminder name before native deletion and uses it on replay', async () => {
  const database = new WorkbenchDatabase(':memory:')
  try {
    const chat = database.createChat({ ownerId: 'owner', sessionId: 'session', selection: {} })
    const { run } = database.createRun({ ownerId: 'owner', chatId: chat.id, sessionId: 'session', selection: {}, query: 'delete' })
    const ctx = { on: vi.fn(), schedule: { catalog: vi.fn(async () => [{ id: 'schedule-id', sessionId: 'session', title: '每分钟问候：你好' }]) } }
    registerToolDisplayReceipts(ctx, { database, runtime: { executionRun: () => run }, ownerId: 'owner' })
    const handle = ctx.on.mock.calls[0][1]
    const next = vi.fn(async () => ({ kind: 'allow' }))
    await handle({ name: 'schedule_delete', callId: 'delete-call', arguments: { id: 'schedule-id' }, agent: { id: 'session' } }, next)
    ctx.schedule.catalog.mockResolvedValue([])
    const frozen = database.getRun('owner', run.id)
    const event = { type: 'tool/result', data: { message: { source: { callId: 'delete-call' }, content: [{ type: 'text', text: '{"deleted":true}' }] } } }
    expect(nativePresentation(frozen, event, { toolName: 'schedule_delete' })[0].data.display_name).toBe('每分钟问候：你好')
    expect(next).toHaveBeenCalledOnce()
    await handle({ name: 'schedule_delete', callId: 'foreign', arguments: { id: 'schedule-id' }, agent: { id: 'session' } }, async () => ({ kind: 'deny' }))
    expect(ctx.schedule.catalog).toHaveBeenCalledTimes(1)
    ctx.schedule.catalog.mockRejectedValue(new Error('catalog unavailable'))
    await expect(handle({ name: 'schedule_delete', callId: 'retry', arguments: { id: 'schedule-id' }, agent: { id: 'session' } }, next)).resolves.toEqual({ kind: 'allow' })
  } finally { database.close() }
})
