import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchRuntime } from '../src/runtime.js'

 describe('frozen run MCP authorization', () => {
  it('authorizes only the frozen owner, resource and revision', () => {
    const database = new WorkbenchDatabase(':memory:')
    try {
      const chat = database.createChat({ ownerId: 't:1', sessionId: 's1', selection: {} })
      const { run } = database.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's1', query: 'q', selection: {}, mcpTools: [{ id: 'personal:server:search', version: 'v1' }] })
      database.transitionRun('t:1', run.id, 'running')
      const runtime = new WorkbenchRuntime(new Context(), database, 't:1')
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
