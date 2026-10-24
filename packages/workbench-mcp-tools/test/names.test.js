import { describe, expect, it } from 'vitest'
import { platformToolNames } from '../src/names.js'

describe('MCP public identities', () => {
  it('resolves aliases colliding with legal raw names and remains stable after reordering', () => {
    const tools = ['a', 'b'].map(server_id => ({ id: server_id, scope: 'global', server_id, tool_name: 'lookup' }))
    const alias = platformToolNames(tools).get('a')
    tools.push({ id: 'c', scope: 'global', server_id: 'c', tool_name: alias })
    const names = platformToolNames(tools)
    expect(new Set(names.values()).size).toBe(3)
    expect(names.get('c')).toBe(alias)
    expect(Object.fromEntries(platformToolNames([...tools].reverse()))).toEqual(Object.fromEntries(names))
    const native = platformToolNames(tools, name => name === names.get('a'))
    expect(new Set(native.values()).size).toBe(3)
    expect([...native.values()]).not.toContain(names.get('a'))
  })
})
