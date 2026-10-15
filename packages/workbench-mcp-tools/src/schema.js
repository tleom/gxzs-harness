import Ajv from 'ajv'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'

// DSH accepts a smaller schema vocabulary than external MCP servers.
// Advertise bounds as descriptions and retain their checks before proxy I/O.
export function adaptInputSchema(source) {
  try {
    assertObjectJsonSchema(source)
    return { schema: source, validate() {} }
  } catch (error) {
    if (error?.code !== 'UNSUPPORTED_SCHEMA') throw error
  }
  const project = (schema, requiredProperty) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
    const result = { ...schema }
    // md_cg's _p/_s generator retains this boolean after building the parent's
    // standard required list. Remove only a matching, redundant annotation;
    // never discard an unknown keyword or an unrepresented requirement.
    if ('_req' in result) {
      if (typeof result._req !== 'boolean' || result._req !== requiredProperty)
        throw Object.assign(new Error('MCP _req annotation must match the parent required list'), { code: 'UNSUPPORTED_SCHEMA' })
      delete result._req
    }
    const bounds = ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'minProperties', 'maxProperties', 'format']
    const limits = bounds
      .filter((key) => key in result).map((key) => `${key}: ${JSON.stringify(result[key])}`)
    for (const key of bounds) delete result[key]
    if (limits.length) result.description = [result.description, limits.join('; ')].filter(Boolean).join('\n')
    if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties)
      .map(([key, value]) => [key, project(value, Array.isArray(result.required) && result.required.includes(key))]))
    if (result.items) result.items = project(result.items)
    if (typeof result.additionalProperties === 'object') result.additionalProperties = project(result.additionalProperties)
    for (const key of ['anyOf', 'allOf', 'oneOf']) if (Array.isArray(result[key])) result[key] = result[key].map(value => project(value))
    if (result.not) result.not = project(result.not)
    // Nullable MCP fields commonly use anyOf. An exact-one union is equivalent
    // only when branch types are disjoint; overlapping unions remain rejected.
    if (Array.isArray(result.anyOf)) {
      const types = result.anyOf.map(branch => branch?.type)
      const supported = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])
      if (types.length >= 2 && types.every(type => supported.has(type))
        && new Set(types).size === types.length
        && !(types.includes('integer') && types.includes('number')) && !result.oneOf) {
        result.oneOf = result.anyOf
        delete result.anyOf
      }
    }
    return result
  }
  // The source schema remains authoritative. Standard validation is needed because
  // native DSH currently rejects these keywords even before tool registration.
  const schema = project(source)
  assertObjectJsonSchema(schema)
  const validator = new Ajv({ strict: false, validateFormats: false, allErrors: false })
  const validate = validator.compile(source)
  return { schema, validate: (value) => {
    if (!validate(value)) throw new Error(`MCP arguments violate schema: ${validator.errorsText(validate.errors)}`)
  } }
}
