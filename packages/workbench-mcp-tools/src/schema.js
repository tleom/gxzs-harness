// DSH accepts a smaller schema vocabulary than external MCP servers.
// Advertise bounds as descriptions and retain their checks before proxy I/O.
export function adaptInputSchema(source) {
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
  const validate = (schema, value, path = '$') => {
    if (!schema || value === undefined) return
    for (const [key, invalid] of [
      ['minimum', typeof value === 'number' && value < schema.minimum],
      ['maximum', typeof value === 'number' && value > schema.maximum],
      ['minItems', Array.isArray(value) && value.length < schema.minItems],
      ['maxItems', Array.isArray(value) && value.length > schema.maxItems],
    ]) if (invalid) throw new Error(`MCP argument ${path} violates ${key}: ${schema[key]}`)
    if (Array.isArray(value)) value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`))
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      validate(schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined), item, `${path}.${key}`)
    }
    for (const key of ['anyOf', 'allOf', 'oneOf']) {
      if (!Array.isArray(schema[key])) continue
      if (key === 'allOf') schema[key].forEach((branch) => validate(branch, value, path))
      else if (key === 'oneOf' || key === 'anyOf') {
        const matches = schema[key].filter((branch) => {
          try { validate(branch, value, path); return true } catch { return false }
        })
        if ((key === 'oneOf' && matches.length !== 1) || (key === 'anyOf' && matches.length === 0))
          throw new Error(`MCP argument ${path} violates ${key}`)
      }
    }
    if (schema.not) {
      try { validate(schema.not, value, path) } catch { return }
      throw new Error(`MCP argument ${path} violates not`)
    }
    // JSON Schema format is an annotation; the MCP server validates formats it requires.
  }
  return { schema: project(source), validate: (value) => validate(source, value) }
}
