import { expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'

it('replays receipt bindings without decoding the catalog until a consumer needs it', () => {
  const db = new WorkbenchDatabase(':memory:')
  const tools = [{ id: 'resource', schema: { description: 'x'.repeat(1024 * 1024) } }]
  const serialized = JSON.stringify(tools)
  try {
    db.createChat({ id: 'chat', sessionId: 'session', ownerId: 'owner', selection: {} })
    db.createRun({ id: 'run', sessionId: 'session', chatId: 'chat', ownerId: 'owner', query: 'query', selection: {}, mcpTools: tools })
    db.setGoalRun('session', 'run')
    const parse = JSON.parse
    let catalogReads = 0
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((value, ...args) => {
      if (value === serialized) catalogReads++
      return parse(value, ...args)
    })
    try {
      for (let index = 0; index < 20; index++) {
        db.bindRunMessage('session', 'run', 1, 'message')
        expect(db.runForTurn('session', 1).id).toBe('run')
        expect(db.getRun('owner', 'run').query).toBe('query')
        expect(db.goalRun('session').id).toBe('run')
      }
      expect(catalogReads).toBe(0)
      const run = db.getRun('owner', 'run')
      expect(run.mcpTools).toEqual(tools)
      const first = run.mcpTools
      expect(run.mcpTools).toBe(first)
      expect(JSON.parse(JSON.stringify(run)).mcpTools).toEqual(tools)
      expect(catalogReads).toBe(1)
    } finally { spy.mockRestore() }
  } finally { db.close() }
})

it('preserves each fetched snapshot and ordinary writable/serializable receipt behavior', () => {
  const db = new WorkbenchDatabase(':memory:')
  try {
    db.createChat({ id: 'chat', sessionId: 'session', ownerId: 'owner', selection: {} })
    db.createRun({ id: 'run', sessionId: 'session', chatId: 'chat', ownerId: 'owner', query: '', selection: {}, mcpTools: [{ id: 'old' }] })
    const original = db.getRun('owner', 'run')
    db.updateRunResources(original, {}, [{ id: 'new' }])
    expect(original.mcpTools).toEqual([{ id: 'old' }])
    const current = db.getRun('owner', 'run')
    expect({ ...current }.mcpTools).toEqual([{ id: 'new' }])
    current.mcpTools.push({ id: 'local' })
    expect(db.getRun('owner', 'run').mcpTools).toEqual([{ id: 'new' }])
    const assigned = db.getRun('owner', 'run')
    assigned.mcpTools = [{ id: 'replacement' }]
    expect(JSON.parse(JSON.stringify(assigned)).mcpTools).toEqual([{ id: 'replacement' }])
  } finally { db.close() }
})
