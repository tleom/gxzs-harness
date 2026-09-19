import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from '../src/cursor.js'

describe('workbench SSE cursor', () => {
  it('round-trips the canonical stream cursor', () => {
    expect(encodeCursor(42)).toBe('42-0')
    expect(decodeCursor('42-0')).toBe(42)
    expect(decodeCursor(undefined)).toBe(0)
  })

  it.each(['-1-0', '01-0', '1-1', '1', 'x-0', '9007199254740992-0'])('rejects invalid cursor %s', (value) => {
    expect(() => decodeCursor(value)).toThrow()
  })
})
