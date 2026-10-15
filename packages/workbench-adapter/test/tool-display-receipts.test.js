import { expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { nativePresentation } from '../src/display-events.js'
import { registerToolDisplayReceipts } from '../src/tool-display-receipts.js'

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
