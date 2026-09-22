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
  const project = (schema) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
    const result = { ...schema }
    const limits = ['minimum', 'maximum', 'minItems', 'maxItems', 'format']
      .filter((key) => key in result).map((key) => `${key}: ${JSON.stringify(result[key])}`)
    for (const key of ['minimum', 'maximum', 'minItems', 'maxItems', 'format']) delete result[key]
    if (limits.length) result.description = [result.description, limits.join('; ')].filter(Boolean).join('\n')
    if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, project(value)]))
    if (result.items) result.items = project(result.items)
    if (typeof result.additionalProperties === 'object') result.additionalProperties = project(result.additionalProperties)
    for (const key of ['anyOf', 'allOf', 'oneOf']) if (Array.isArray(result[key])) result[key] = result[key].map(project)
    if (result.not) result.not = project(result.not)
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
