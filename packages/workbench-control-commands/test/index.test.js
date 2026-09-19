import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

describe('workbench control commands plugin', () => {
  it('clears todos through the authoritative DSH session event', () => {
    let definition
    const register = vi.fn((value) => { definition = value; return () => {} })
    apply({ commands: { register }, effect: (factory) => factory() })
    const append = vi.fn()
    expect(definition.name).toBe('todos-clear')
    expect(definition.handler({ agent: { session: { append } } })).toEqual({ kind: 'success', text: '任务列表已清空' })
    expect(append).toHaveBeenCalledWith('todo/write', { todos: [] })
  })
})
