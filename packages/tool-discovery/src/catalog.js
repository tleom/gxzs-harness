import { createHash } from 'node:crypto'

export const TOOL_SEARCH_NAME = 'tool_search'
export const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const normalized = value => String(value ?? '').normalize('NFKC').toLowerCase().trim()
const STOP = new Set(['the', 'for', 'and', 'with', 'find', 'search', 'tool', 'tools', '查找', '搜索', '检索', '工具', '一下', '帮我', '请问', '查询'])

/** Unicode-aware clipping used only for descriptions, never parameter schemas. */
export function clip(value, limit) {
  const points = Array.from(String(value ?? ''))
  return points.length > limit ? `${points.slice(0, Math.max(0, limit - 1)).join('')}…` : points.join('')
}

/** English identifier words and Chinese bigrams remain local to the Host. */
export function terms(value) {
  const text = normalized(String(value ?? '').replace(/([a-z\d])([A-Z])/g, '$1 $2'))
  const tokens = text.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []
  const result = new Set()
  for (const token of tokens) {
    if (/\p{Script=Han}/u.test(token)) {
      const chars = [...token]
      if (chars.length === 1) result.add(token)
      for (let index = 0; index + 1 < chars.length; index++) result.add(chars[index] + chars[index + 1])
    } else result.add(token)
  }
  return [...result].filter(token => !STOP.has(token))
}

/** Normalize the bridge's current authorized catalogue without touching execution. */
export function buildCatalog(snapshot, config) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.tools)) throw new Error('工具发现目录格式无效')
  if (snapshot.tools.length > config.maxCatalogTools) throw new Error('工具发现目录超过数量上限')
  const byId = new Map(), byName = new Set(), plugins = new Map()
  let indexBytes = 0
  for (const source of snapshot.plugins ?? []) {
    if (typeof source.id !== 'string' || !source.id) continue
    plugins.set(source.id, {
      id: source.id, name: clip(source.name ?? source.displayName ?? source.id, 120), callName: clip(source.callName ?? source.id, 120),
      scope: source.scope === 'personal' ? 'personal' : 'global',
      description: clip(source.description, config.descriptionChars), preferred: source.preferred === true, count: 0,
    })
  }
  for (const source of snapshot.tools) {
    for (const key of ['id', 'name', 'pluginId', 'version']) {
      if (typeof source[key] !== 'string' || !source[key] || source[key].length > 2048) throw new Error(`工具发现目录缺少有效 ${key}`)
    }
    if (source.name.length > 256 || (source.manifestVersion !== undefined
      && (typeof source.manifestVersion !== 'string' || source.manifestVersion.length > 2048)))
      throw new Error('工具发现目录身份超出可恢复状态的长度限制')
    if (source.name === TOOL_SEARCH_NAME || byId.has(source.id) || byName.has(source.name)) throw new Error('工具发现目录包含重复或保留调用名')
    const definition = {
      name: source.name, description: String(source.description ?? ''), parameters: source.parameters ?? { type: 'object', properties: {} },
      ...(source.outputSchema === undefined ? {} : { outputSchema: source.outputSchema }),
      ...(source.unavailableReason ? { unavailableReason: clip(source.unavailableReason, 80) } : {}),
    }
    const definitionJson = JSON.stringify(definition)
    const item = {
      id: source.id, name: source.name, pluginId: source.pluginId,
      pluginName: clip(source.pluginName ?? source.pluginId, 120), pluginCallName: clip(source.pluginCallName ?? source.pluginId, 120), pluginScope: source.pluginScope === 'personal' ? 'personal' : 'global',
      description: String(source.description ?? ''), version: source.version, manifestVersion: String(source.manifestVersion ?? ''),
      definitionBytes: bytes(definitionJson), fingerprint: hash(definitionJson),
      unavailableReason: definition.unavailableReason,
    }
    item.nameText = normalized(item.name.replace(/([a-z\d])([A-Z])/g, '$1 $2'))
    item.nameTerms = new Set(terms(item.name))
    item.descriptionText = normalized(item.description)
    item.descriptionTerms = new Set(terms(item.description))
    item.parameterTerms = new Set(terms(JSON.stringify(definition.parameters)))
    item.pluginText = normalized(`${item.pluginId} ${item.pluginName} ${item.pluginCallName} ${plugins.get(item.pluginId)?.description ?? ''}`)
    item.pluginTerms = new Set(terms(item.pluginText))
    indexBytes += bytes(definitionJson) + bytes(item.pluginText)
    if (indexBytes > config.maxIndexBytes) throw new Error('工具发现目录超过索引大小上限')
    byId.set(item.id, item); byName.add(item.name)
    if (!plugins.has(item.pluginId)) plugins.set(item.pluginId, { id: item.pluginId, name: item.pluginName, callName: item.pluginCallName, scope: item.pluginScope, description: '', count: 0 })
    plugins.get(item.pluginId).count++
  }
  return {
    authorityKey: typeof snapshot.authorityKey === 'string' && snapshot.authorityKey.length <= 4096 ? snapshot.authorityKey : null,
    revision: String(snapshot.revision ?? ''), ready: snapshot.ready === true,
    byId, plugins: [...plugins.values()].filter(plugin => plugin.count > 0),
  }
}

export const activationEntry = tool => ({ id: tool.id, name: tool.name, version: tool.version, manifestVersion: tool.manifestVersion, fingerprint: tool.fingerprint })
export const matchesEntry = (tool, entry) => tool && tool.name === entry.name && tool.version === entry.version
  && tool.manifestVersion === entry.manifestVersion && tool.fingerprint === entry.fingerprint

/** Deterministic ranking; no matching term never becomes an arbitrary activation. */
export function search(catalog, query, pluginId) {
  const text = normalized(query), queryTerms = terms(query)
  const exact = [...catalog.byId.values()].filter(tool => (!pluginId || tool.pluginId === pluginId)
    && text && (text === normalized(tool.name) || text === normalized(tool.id)))
  if (exact.length) return exact
  const ranked = []
  for (const tool of catalog.byId.values()) {
    if (pluginId && tool.pluginId !== pluginId) continue
    if (!text) { ranked.push({ tool, score: 1 }); continue }
    let score = text === normalized(tool.name) || text === normalized(tool.id) ? 10000 : 0
    if (tool.nameText.includes(text)) score += 500
    if (tool.descriptionText.includes(text)) score += 150
    if (tool.pluginText.includes(text)) score += 80
    for (const term of queryTerms) {
      if (tool.nameTerms.has(term)) score += 50
      if (tool.descriptionTerms.has(term)) score += 15
      if (tool.parameterTerms.has(term)) score += 2
      if (tool.pluginTerms.has(term)) score += 5
    }
    if (score > 0) ranked.push({ tool, score })
  }
  return ranked.sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0)).map(row => row.tool)
}

export function cursorSignature(catalog, query, pluginId) {
  return hash([catalog.authorityKey, catalog.revision, normalized(query), pluginId ?? ''])
}

export function encodeCursor(signature, offset) { return Buffer.from(JSON.stringify({ v: 1, signature, offset })).toString('base64url') }
export function decodeCursor(cursor, signature, total) {
  if (!cursor) return 0
  try {
    if (typeof cursor !== 'string' || cursor.length > 512) return undefined
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return value.v === 1 && value.signature === signature && Number.isSafeInteger(value.offset) && value.offset >= 0 && value.offset <= total ? value.offset : undefined
  } catch { return undefined }
}

/** Bound the whole prompt section, including descriptions and the omission notice. */
export function renderCatalog(catalog, config, { searchAllowed = true, deniedCount = 0 } = {}) {
  if (!searchAllowed) return '当前会话策略未允许查找插件工具；仅可使用本步骤实际提供的工具。'
  if (!catalog?.ready) return catalog?.unavailableMessage ?? '插件目录暂不可用；可继续处理不依赖插件的任务。'
  const heading = `需要插件能力时先调用 ${TOOL_SEARCH_NAME}，再在下一步调用实际提供的工具。未列出的插件仍可按用途搜索。\n`
    + (deniedCount ? `最近一次准备有 ${deniedCount} 项未获当前会话策略许可，未加载这些工具。\n` : '')
  const plugins = [...catalog.plugins].sort((a, b) => Number(b.preferred) - Number(a.preferred) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rows = []
  for (const plugin of plugins) {
    const row = { id: plugin.id, name: plugin.name, callName: plugin.callName, scope: plugin.scope, description: plugin.description, tools: plugin.count }
    const trial = `${heading}${JSON.stringify([...rows, row])}\n另有 ${plugins.length - rows.length - 1} 个插件可搜索。`
    if (bytes(trial) > config.maxSummaryBytes) continue
    rows.push(row)
  }
  return `${heading}${JSON.stringify(rows)}${rows.length < plugins.length ? `\n另有 ${plugins.length - rows.length} 个插件可搜索。` : ''}`
}
