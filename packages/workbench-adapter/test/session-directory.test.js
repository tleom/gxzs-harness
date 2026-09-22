import { describe, expect, it, vi } from 'vitest'
import { copySessionDirectory } from '../src/session-directory.js'

describe('conversation session history', () => {
  it('keeps the selected history boundary, preset and new directory for regeneration', async () => {
    const events = [{ seq: 0, type: 'first' }, { seq: 1, type: 'last-retained' }, { seq: 2, type: 'discarded-answer' }]
    const dispose = vi.fn()
    const source = { events, header: { cwd: '/workspace' }, projections: { values: { agentPreset: 'standard' } }, [Symbol.dispose]: dispose }
    const services = {
      sessionQuery: { observeSession: vi.fn(async () => source) },
      agentPresets: { resolve: vi.fn(async () => ({ id: 'standard' })), mount: vi.fn(async () => () => {}) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'qwen', model: 'flash' }) },
      agents: { create: vi.fn(async () => ({})) },
    }
    const child = await copySessionDirectory(services, 'old', '/workspace/conversations/chat', 1)
    const request = services.agents.create.mock.calls[0][0]
    expect(request).toMatchObject({ sessionId: child.sessionId, seed: events.slice(0, 2), inheritedEventCount: 2, meta: { cwd: '/workspace/conversations/chat', parentSession: 'old', agentPreset: 'standard' } })
    expect(await request.setup('agent-context')).toBeUndefined()
    expect(services.agentPresets.mount).toHaveBeenCalledWith('agent-context', 'standard')
    expect(source.events).toHaveLength(3)
    expect(dispose).toHaveBeenCalledOnce()
    services.agents.create.mockRejectedValueOnce(new Error('cannot create'))
    await expect(copySessionDirectory(services, 'old', '/workspace/conversations/chat')).rejects.toThrow('cannot create')
    expect(dispose).toHaveBeenCalledTimes(2)
  })
})
