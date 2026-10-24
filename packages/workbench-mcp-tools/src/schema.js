import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import Ajv2019 from 'ajv/dist/2019.js'
import draft6 from 'ajv/dist/refs/json-schema-draft-06.json' with { type: 'json' }
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
  const project = (schema, requiredProperty, references = new Set()) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
    if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/') && !references.has(schema.$ref)
      && Object.keys(schema).every(key => ['$ref', 'description', 'default', 'title', '$comment', 'examples'].includes(key))) {
      const target = schema.$ref.slice(2).split('/').reduce((value, key) => {
        key = key.replace(/~1/g, '/').replace(/~0/g, '~')
        return value && Object.hasOwn(value, key) ? value[key] : undefined
      }, source)
      if (target && typeof target === 'object' && !Array.isArray(target)) {
        const { $ref, ...annotations } = schema
        return project({ ...target, ...annotations }, requiredProperty, new Set([...references, $ref]))
      }
    }
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
      .map(([key, value]) => [key, project(value, Array.isArray(result.required) && result.required.includes(key), references)]))
    if (result.items) result.items = project(result.items, undefined, references)
    if (typeof result.additionalProperties === 'object') result.additionalProperties = project(result.additionalProperties, undefined, references)
    for (const key of ['anyOf', 'allOf', 'oneOf']) if (Array.isArray(result[key])) result[key] = result[key].map(value => project(value, undefined, references))
    if (result.not) result.not = project(result.not, undefined, references)
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
  let schema = project(source)
  const dialect = source.$schema
  const Validator = !dialect || dialect.includes('2020-12') ? Ajv2020
    : dialect.includes('2019-09') ? Ajv2019 : Ajv
  const validator = new Validator({ strict: false, strictSchema: true, validateFormats: false, allErrors: false })
  if (dialect?.includes('draft-06')) validator.addMetaSchema(draft6)
  validator.addKeyword({ keyword: '_req', schemaType: 'boolean', valid: true })
  const validate = validator.compile(source)
  try { assertObjectJsonSchema(schema) }
  catch (error) {
    if (error?.code !== 'UNSUPPORTED_SCHEMA') throw error
    // A wider model-facing schema is safe only while the complete original
    // schema is validated before proxy I/O. Never claim an anyOf is a oneOf.
    const widen = node => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return {}
      try {
        assertObjectJsonSchema({ type: 'object', properties: { value: node } })
        return node
      } catch (error) { if (error?.code !== 'UNSUPPORTED_SCHEMA') throw error }
      const result = {}
      if (typeof node.type === 'string' && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) result.type = node.type
      if (typeof node.description === 'string') result.description = node.description
      if (node.type === 'object') {
        if (node.properties) result.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, widen(child)]))
        if (Array.isArray(node.required) && node.required.every(key => result.properties?.[key])) result.required = node.required
        result.additionalProperties = node.additionalProperties !== false
      }
      if (node.type === 'array' && node.items) result.items = widen(node.items)
      return result
    }
    schema = widen(schema)
    schema.description = [schema.description, '原始参数约束在调用前校验；完整定义见工具发现的 inputSchema'].filter(Boolean).join('\n')
    assertObjectJsonSchema(schema)
  }
  return { schema, validate: (value) => {
    if (!validate(value)) throw new Error(`MCP arguments violate schema: ${validator.errorsText(validate.errors)}`)
  } }
}
