import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchRuntime } from '../src/runtime.js'

 describe('frozen run MCP authorization', () => {
  it('retains the exact spawning run for a live native child after its parent completes or accepts another prompt', () => {
    const database = new WorkbenchDatabase(':memory:')
    try {
      const chat = database.createChat({ ownerId: 't:1', sessionId: 'root', selection: {} })
      const { run } = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 'root', query: 'spawn', selection: {}, mcpTools: [{ id: 'old', version: 'v1' }] })
      database.bindRunMessage('root', run.id, 1, 'message')
      database.transitionRun('t:1', run.id, 'running')
      let turn = 1
      const root = { id: 'root', session: { id: 'root' }, status: 'running', ctx: { sessionProjections: { stateOf: () => ({ lastTurn: turn }) } } }
      const child = { id: 'child', session: { id: 'child' }, status: 'running', cancel() {} }
      const unrelated = { id: 'unrelated', session: { id: 'unrelated', header: { parentSession: 'root' } }, status: 'running' }
      const agents = { list: () => [root, child, unrelated], get: id => [root, child, unrelated].find(item => item.id === id), isOwnedBy: (id, parent) => id === 'child' && parent === root }
      const runtime = new WorkbenchRuntime(new Context(), database, 't:1'); runtime.agents = agents
      runtime.scheduler = { hasAdmission: () => true }
      runtime.bindChild(child)
      database.transitionRun('t:1', run.id, 'completed'); root.status = 'idle'
      expect(runtime.executionRun('root')).toMatchObject({ id: run.id, background: true })
      expect(runtime.authorizeMcp('child', 'old', 'v1')).toMatchObject({ runId: run.id })
      expect(runtime.authorizeRunMcp('t:1', run.id, 'old', 'v1')).toBe(true)
      expect(runtime.authorizeMcp('unrelated', 'old', 'v1')).toBeUndefined()
      const next = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 'root', query: 'new', selection: {}, mcpTools: [{ id: 'new', version: 'v2' }] }).run
      database.bindRunMessage('root', next.id, 2, 'next-message'); database.transitionRun('t:1', next.id, 'running'); turn = 2
      expect(runtime.authorizeMcp('child', 'new', 'v2')).toBeUndefined()
      expect(runtime.authorizeMcp('child', 'old', 'v1')).toMatchObject({ runId: run.id })
      runtime.childRuns.delete(child)
      runtime.bindChild(child)
      expect(runtime.authorizeMcp('child', 'old', 'v1')).toMatchObject({ runId: run.id })
      expect(runtime.authorizeMcp('child', 'new', 'v2')).toBeUndefined()
      child.status = 'idle'
      expect(runtime.authorizeMcp('child', 'old', 'v1')).toBeUndefined()
      expect(runtime.authorizeRunMcp('t:1', run.id, 'old', 'v1')).toBe(false)
    } finally { database.close() }
  })
  it('authorizes only the frozen owner, resource and revision', () => {
    const database = new WorkbenchDatabase(':memory:')
    try {
      const chat = database.createChat({ ownerId: 't:1', sessionId: 's1', selection: {} })
      const { run } = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's1', query: 'q', selection: {}, mcpTools: [{ id: 'personal:server:search', version: 'v1' }] })
      database.transitionRun('t:1', run.id, 'running')
      const runtime = new WorkbenchRuntime(new Context(), database, 't:1')
      runtime.agents = new Map([['s1', { id: 's1' }]])
      expect(runtime.authorizeRunMcp('t:1', run.id, 'personal:server:search', 'v1')).toBe(true)
      expect(runtime.authorizeRunMcp('t:2', run.id, 'personal:server:search', 'v1')).toBe(false)
      expect(runtime.authorizeRunMcp('t:1', 'missing', 'personal:server:search', 'v1')).toBe(false)
      expect(runtime.authorizeRunMcp('t:1', run.id, 'personal:server:search', 'v2')).toBe(false)
      expect(runtime.authorizeRunMcp('t:1', run.id, 'global:other:search', 'v1')).toBe(false)
      expect(runtime.authorizeMcp('s1', 'personal:server:search', 'v1')).toMatchObject({ runId: run.id, ownerId: 't:1' })
      expect(runtime.authorizeMcp('s1', 'personal:server:search', 'v2')).toBeUndefined()
      expect(runtime.authorizeMcp('s1', 'global:other:search', 'v1')).toBeUndefined()
      const other = new WorkbenchRuntime(new Context(), database, 't:2')
      expect(other.authorizeMcp('s1', 'personal:server:search', 'v1')).toBeUndefined()
      database.transitionRun('t:1', run.id, 'completed')
      expect(runtime.authorizeRunMcp('t:1', run.id, 'personal:server:search', 'v1')).toBe(false)
      expect(runtime.authorizeMcp('s1', 'personal:server:search', 'v1')).toBeUndefined()
    } finally { database.close() }
  })
})
