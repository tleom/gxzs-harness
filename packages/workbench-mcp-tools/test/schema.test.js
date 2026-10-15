import { describe, expect, it } from 'vitest'
import { adaptInputSchema } from '../src/schema.js'

describe('MCP schema projection', () => {
  it('projects nullable weather fields to equivalent disjoint unions and preserves source validation', () => {
    const source = { type: 'object', properties: {
      latitude: { type: 'number' }, longitude: { type: 'number' },
      hourly_vars: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
    }, required: ['latitude', 'longitude'] }
    const before = structuredClone(source)
    const adapted = adaptInputSchema(source)
    expect(source).toEqual(before)
    expect(adapted.schema.properties.hourly_vars).toEqual({ oneOf: [{ type: 'string' }, { type: 'null' }], default: null })
    expect(() => adapted.validate({ latitude: 31, longitude: 121, hourly_vars: null })).not.toThrow()
    expect(() => adapted.validate({ latitude: 31, longitude: 121, hourly_vars: 'temperature_2m' })).not.toThrow()
    expect(() => adapted.validate({ latitude: 31, longitude: 121, hourly_vars: 12 })).toThrow('schema')
    expect(() => adapted.validate({ latitude: 31 })).toThrow('required')
  })

  it.each([
    [{ type: 'number' }, { type: 'integer' }],
    [{ type: 'string', enum: ['temperature'] }, { type: 'string' }],
  ])('retains rejection of overlapping anyOf branches', branches => {
    expect(() => adaptInputSchema({ type: 'object', properties: { value: { anyOf: branches } } })).toThrow('anyOf')
  })

  it('projects nested string lengths while enforcing the original Unicode bounds', () => {
    const source = { type: 'object', properties: {
      title: { type: 'string', description: 'Title', minLength: 1, maxLength: 2 },
      labels: { type: 'array', items: { type: 'string', maxLength: 2 } },
    }, required: ['title'] }
    const before = structuredClone(source)
    const adapted = adaptInputSchema(source)
    expect(source).toEqual(before)
    expect(adapted.schema.properties.title).toEqual({ type: 'string', description: 'Title\nminLength: 1; maxLength: 2' })
    expect(adapted.schema.properties.labels.items).toEqual({ type: 'string', description: 'maxLength: 2' })
    expect(() => adapted.validate({ title: '' })).toThrow('fewer than 1 characters')
    expect(() => adapted.validate({ title: 'abc' })).toThrow('more than 2 characters')
    expect(() => adapted.validate({ title: '标题', labels: ['abc'] })).toThrow('more than 2 characters')
    expect(() => adapted.validate({ title: '😀😀', labels: ['标'] })).not.toThrow()
  })

  it('projects string patterns while preserving required matching before dispatch', () => {
    const source = { type: 'object', properties: {
      idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    }, required: ['idempotencyKey'] }
    const adapted = adaptInputSchema(source)
    expect(adapted.schema.properties.idempotencyKey).toEqual({ type: 'string', description: 'pattern: "^[A-Za-z0-9_-]{1,64}$"' })
    expect(source.properties.idempotencyKey.pattern).toBe('^[A-Za-z0-9_-]{1,64}$')
    expect(() => adapted.validate({ idempotencyKey: 'invalid key' })).toThrow('match pattern')
    expect(() => adapted.validate({ idempotencyKey: 'request-1' })).not.toThrow()
  })

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
