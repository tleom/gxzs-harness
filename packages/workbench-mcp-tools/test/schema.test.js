import { describe, expect, it } from 'vitest'
import { adaptInputSchema } from '../src/schema.js'

describe('MCP schema projection', () => {
  it('advertises legal object bounds and enforces the original nonempty request before dispatch', () => {
    const source = { type: 'object', properties: { query: { type: 'string' } },
      additionalProperties: true, minProperties: 1, description: 'At least one search criterion' }
    const before = structuredClone(source)
    const adapted = adaptInputSchema(source)
    expect(source).toEqual(before)
    expect(adapted.schema.minProperties).toBeUndefined()
    expect(adapted.schema.description).toContain('At least one search criterion')
    expect(adapted.schema.description).toContain('minProperties: 1')
    expect(() => adapted.validate({})).toThrow('fewer than 1 properties')
    expect(() => adapted.validate({ query: 'fixture' })).not.toThrow()
    expect(() => adapted.validate({ query: 1 })).toThrow('string')
  })

  it('retains nested object minimum and maximum property validation', () => {
    const adapted = adaptInputSchema({ type: 'object', properties: {
      filters: { type: 'object', additionalProperties: true, minProperties: 1, maxProperties: 2 },
    }, required: ['filters'] })
    expect(adapted.schema.properties.filters.description).toContain('maxProperties: 2')
    expect(() => adapted.validate({ filters: {} })).toThrow('fewer than 1 properties')
    expect(() => adapted.validate({ filters: { a: 1, b: 2, c: 3 } })).toThrow('more than 2 properties')
    expect(() => adapted.validate({ filters: { a: 1 } })).not.toThrow()
  })

  it('removes the md_cg generator marker while enforcing standard required and argument types', () => {
    const source = {
      type: 'object', properties: {
        op: { type: 'string', _req: true },
        tags: { type: 'array' },
        optional: { type: 'string', _req: false },
        nested: { type: 'object', properties: { name: { type: 'string', _req: true } }, required: ['name'] },
      }, required: ['op'],
    }
    const before = structuredClone(source)
    const adapted = adaptInputSchema(source)
    expect(source).toEqual(before)
    expect(adapted.schema.properties.op).toEqual({ type: 'string' })
    expect(adapted.schema.required).toEqual(['op'])
    expect(adapted.schema.properties.tags).toEqual({ type: 'array' })
    expect(() => adapted.validate({})).toThrow('required')
    expect(() => adapted.validate({ op: 1 })).toThrow('string')
    expect(() => adapted.validate({ op: 'read', nested: {} })).toThrow('required')
    expect(() => adapted.validate({ op: 'read', tags: ['one', 2, {}], nested: { name: 'x' } })).not.toThrow()
  })

  it.each([
    { type: 'object', _req: true },
    { type: 'object', properties: { op: { type: 'string', _req: true } } },
    { type: 'object', properties: { op: { type: 'string', _req: 'true' } }, required: ['op'] },
    { type: 'object', properties: { op: { type: 'string', _req: false } }, required: ['op'] },
  ])('rejects unrepresented or malformed required annotations', (schema) => {
    expect(() => adaptInputSchema(schema)).toThrow('must match')
  })

  it('does not remove unknown constraint keywords or data properties named _req', () => {
    expect(() => adaptInputSchema({ type: 'object', properties: { op: { type: 'string', _secretConstraint: true } } }))
      .toThrow('not a supported keyword')
    const source = { type: 'object', properties: { _req: { type: 'boolean' } }, required: ['_req'] }
    expect(adaptInputSchema(source).schema).toEqual(source)
  })
})
