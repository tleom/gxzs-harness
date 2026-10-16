import z from '@deepseek-ai/schemastery'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  MCP_NAME, TOOL_SEARCH_NAME, activationEntry, availablePlugins, buildCatalog, hash, matchesEntry, pluginSummary, renderCatalog, search,
} from './catalog.js'
import { ACTIVE_EVENT, PROJECTION_KEY, discoveryProjection } from './projection.js'

export { MCP_NAME, TOOL_SEARCH_NAME } from './catalog.js'
export const name = 'tool-discovery'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessionProjections', 'toolDiscoveryCatalog']
export const Config = z.object({
  pageSize: z.number().min(1).max(50).step(1).default(8),
  maxActiveTools: z.number().min(1).max(256).step(1).default(64),
  maxActiveDefinitionBytes: z.number().min(1024).step(1).default(131072),
  maxToolDefinitionBytes: z.number().min(512).step(1).default(32768),
  maxCatalogTools: z.number().min(1).step(1).default(10000),
  maxIndexBytes: z.number().min(1024).step(1).default(16777216),
})

/** Register one native DSH discovery capability backed by an injected catalogue. */
export function apply(ctx, supplied = {}) {
  const config = Config(supplied)
  const bridge = ctx.toolDiscoveryCatalog
  const states = new Map(), bySession = new WeakMap()
  let disposed = false, initialized = false
  ctx.sessionProjections.register(discoveryProjection)

  function stateFor(agent) {
    let state = states.get(agent)
    if (state) return state
    const restored = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY)
    state = {
      agent, authorityKey: restored?.authorityKey ?? null,
      active: new Map((restored?.tools ?? []).map(tool => [tool.id, tool])),
      pending: new Map(), catalogKey: undefined, catalog: undefined,
      maskStamp: undefined, liftMask: undefined, step: undefined, unpersisted: false, assembled: undefined,
      deniedCount: 0,
    }
    states.set(agent, state); bySession.set(agent.session, state)
    return state
  }

  function prepareMask(state, active) {
    const names = new Set([...active.values()].map(tool => tool.name))
    const deny = [...new Set(bridge.managedNames())].filter(toolName => ![TOOL_SEARCH_NAME, MCP_NAME].includes(toolName) && !names.has(toolName)).sort()
    const stamp = JSON.stringify(deny)
    if (stamp === state.maskStamp) return undefined
    const lift = deny.length ? state.agent.ctx.tools.restrict({ deny }) : undefined
    return { stamp, lift }
  }

  function installMask(state, prepared) {
    if (!prepared) return
    state.liftMask?.()
    state.liftMask = prepared.lift; state.maskStamp = prepared.stamp
  }

  /** Only the discovery restriction is replaced; authorization remains bridge-owned. */
  function refresh(agent) {
    if (disposed || !agent?.ctx?.tools || !agent.session) return undefined
    const state = stateFor(agent)
    let snapshot
    try {
      snapshot = bridge.snapshot(agent)
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid catalog snapshot')
    }
    catch { snapshot = { authorityKey: null, revision: '', ready: false, tools: [] } }
    const key = JSON.stringify([snapshot.authorityKey ?? null, snapshot.revision ?? '', snapshot.ready === true])
    if (key !== state.catalogKey) {
      try { state.catalog = buildCatalog(snapshot, config); state.catalogKey = key }
      catch (error) {
        // Keep native conversation usable while every MCP tool remains hidden.
        // Invalid or over-budget input is never published as a verified empty catalog.
        state.catalog = { authorityKey: typeof snapshot.authorityKey === 'string' && snapshot.authorityKey.length <= 4096 ? snapshot.authorityKey : null, revision: String(snapshot.revision ?? ''),
          ready: false, byId: new Map(), plugins: [],
          unavailableMessage: `插件目录暂不可用：${error.message}。可继续处理其他任务。` }
        state.catalogKey = key; state.pending.clear()
      }
    }
    const catalog = state.catalog
    if (state.authorityKey !== catalog.authorityKey) {
      state.authorityKey = catalog.authorityKey; state.active.clear(); state.pending.clear(); state.unpersisted = false; state.deniedCount = 0
    }
    if (catalog.ready) {
      const matching = new Map()
      for (const [id, entry] of state.active) {
        const tool = catalog.byId.get(id)
        if (matchesEntry(tool, entry)) matching.set(id, entry)
      }
      state.active = matching
    }
    installMask(state, prepareMask(state, catalog.ready ? state.active : new Map()))
    if (initialized && catalog.ready) {
      // During HMR bootstrap the bridge still holds its missing-core mask.
      // Validate native policy only after that independent fallback is released.
      const admitted = visibleEntries(state, state.active)
      const bounded = new Map()
      for (const [id, entry] of admitted) {
        if (!capacity(catalog, bounded, catalog.byId.get(id))) bounded.set(id, entry)
      }
      if (bounded.size !== state.active.size) {
        state.deniedCount = state.active.size - admitted.size
        state.active = bounded; state.unpersisted = true
        installMask(state, prepareMask(state, bounded))
      }
    }
    return state
  }

  function visibleEntries(state, entries) {
    const visible = bridge.visibleNames?.(state.agent) ?? ctx.tools.view(state.agent).visible
    return new Map([...entries].filter(([, entry]) => visible.has(entry.name)))
  }

  // Inventory revisions include unloaded plugins, labels and availability. Only
  // the definitions exposed in this Agent's request can invalidate its schemas.
  function requestSnapshot(state) {
    const entries = state.catalog.ready ? visibleEntries(state, state.active) : new Map()
    return JSON.stringify([state.authorityKey, [...entries.values()].sort((a, b) => a.id.localeCompare(b.id))])
  }

  function refreshAll() {
    for (const agent of ctx.agents.list()) refresh(agent)
  }

  function clearAgent(agent) {
    const state = states.get(agent)
    state?.liftMask?.(); state?.pending.clear()
    states.delete(agent)
    if (agent?.session) bySession.delete(agent.session)
  }

  function resultRow(tool, status, reason) {
    return { name: tool.rawName, plugin: tool.pluginCallName, description: tool.description, status,
      ...(reason ? { reason } : {}),
      ...(['prepared', 'active'].includes(status) ? { definition: tool.definition } : {}),
    }
  }

  function reserved(state) {
    const entries = new Map(state.active)
    for (const pending of state.pending.values()) for (const entry of pending.tools) entries.set(entry.id, entry)
    return entries
  }

  function capacity(catalog, entries, tool) {
    if (tool.unavailableReason) return tool.unavailableReason
    if (entries.has(tool.id)) return undefined
    if (tool.definitionBytes > config.maxToolDefinitionBytes) return 'definition_too_large'
    if (entries.size >= config.maxActiveTools) return 'active_tool_limit'
    const used = [...entries.values()].reduce((sum, item) => sum + (catalog.byId.get(item.id)?.definitionBytes ?? 0), 0)
    return used + tool.definitionBytes > config.maxActiveDefinitionBytes ? 'active_definition_budget' : undefined
  }

  function executionContext(exec) {
    exec.signal.throwIfAborted()
    if (!exec.agent) throw new Error('工具发现需要有效的智能体会话')
    const state = refresh(exec.agent)
    if (!state.step || state.step.signal.aborted) throw new Error('工具发现需要有效的运行步骤')
    return state
  }

  const unavailable = catalog => ({ status: 'unavailable', items: [],
    message: catalog.unavailableMessage ?? '当前插件目录暂不可用，请稍后重试。' })

  const unavailablePlugin = plugin => ({ status: 'unavailable', plugin: pluginSummary(plugin), items: [],
    ...(plugin.unavailableReason ? { reason: plugin.unavailableReason } : {}),
    message: plugin.unavailableReason === 'run_authorization_required'
      ? '插件当前可用，但本任务未获这些工具的授权。请重新提交任务以核验当前权限；重复搜索不会增加权限。'
      : '插件已安装，但工具目录暂不可用。请检查插件连接或授权状态后重试。' })

  function findPlugin(catalog, name) {
    if (typeof name !== 'string' || !name.trim()) return undefined
    return catalog.plugins.find(plugin => plugin.name === name)
  }

  function prepareTools(state, exec, tools, replace = false) {
    if (state.pending.size && (replace || [...state.pending.values()].some(item => item.replace)))
      throw new Error('replace_active 必须独占本步骤的工具发现；请在下一步单独调用。')
    const catalog = state.catalog, reservations = replace ? new Map() : reserved(state), prepared = []
    const items = tools.map(tool => {
      const active = !replace && state.active.has(tool.id)
      const reason = tool.unavailableReason ?? (!active ? capacity(catalog, reservations, tool) : undefined)
      const status = reason ? 'unavailable' : active ? 'active' : 'prepared'
      if (status === 'prepared') {
        const entry = activationEntry(tool)
        prepared.push(entry); reservations.set(entry.id, entry)
      }
      return resultRow(tool, status, reason)
    })
    if (prepared.length) state.pending.set(exec.callId, {
      callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId,
      authorityKey: catalog.authorityKey, turn: state.step.turn, step: state.step.step,
      tools: prepared, replace, finalized: false, durableSeq: undefined,
    })
    return items
  }

  function loadingResult(items) {
    const successful = items.filter(item => ['prepared', 'active'].includes(item.status))
    return { status: successful.length === items.length ? 'prepared' : successful.length ? 'partial' : 'unavailable', items,
      message: 'prepared 项将在本步骤结束后按当前权限核验并加载完整定义，下一步按实际提供的名称和参数调用；逐项检查失败原因。加载不执行工具。' }
  }

  function executeMcp(args, exec) {
    const state = executionContext(exec), catalog = state.catalog
    if (!catalog.ready || !catalog.authorityKey) return unavailable(catalog)
    if (args.tools !== undefined && (!Array.isArray(args.tools) || !args.tools.length
      || args.tools.some(name => typeof name !== 'string' || !name))) throw new Error('tools 必须是非空工具名称数组')
    if (args.name === undefined) {
      if (args.tools !== undefined) throw new Error('加载工具时必须提供插件 name')
      return { status: 'plugins', items: availablePlugins(catalog).map(pluginSummary) }
    }
    const plugin = findPlugin(catalog, args.name)
    if (!plugin) return { status: 'not_found', items: [], message: `插件未找到或当前不可用：${args.name}；可调用 mcp({}) 查看当前目录。` }
    if (!plugin.available) return unavailablePlugin(plugin)
    const tools = [...catalog.byId.values()].filter(tool => tool.pluginId === plugin.id)
    if (args.tools === undefined) return { status: 'browse', plugin: pluginSummary(plugin),
      items: tools.map(tool => ({ name: tool.rawName, description: tool.description })),
      message: '这是完整工具目录。使用 mcp({name, tools:[工具名称]}) 加载一个或多个工具的完整定义。' }
    const requested = [...new Set(args.tools)]
    const selected = requested.map(name => tools.find(tool => tool.rawName === name) ?? tools.find(tool => tool.name === name))
    const loaded = prepareTools(state, exec, selected.filter(Boolean), args.replace_active === true)
    let index = 0
    return { ...loadingResult(selected.map((tool, position) => tool ? loaded[index++]
      : { name: requested[position], status: 'not_found', reason: 'tool_not_found' })), plugin: pluginSummary(plugin) }
  }

  function executeSearch(args, exec) {
    const state = executionContext(exec), catalog = state.catalog
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query || query.length > 512) throw new Error('请提供 1 至 512 字符的查找关键词')
    if (!catalog.ready || !catalog.authorityKey) return unavailable(catalog)
    const plugin = args.name === undefined ? undefined : findPlugin(catalog, args.name)
    if (args.name !== undefined && !plugin) return { status: 'not_found', items: [], message: '指定插件未找到或当前不可用，可通过 mcp({}) 查看插件目录。' }
    if (plugin && !plugin.available) return unavailablePlugin(plugin)
    const matches = search(catalog, query, plugin?.id)
    if (!matches.length) return { status: 'no_match', items: [], message: '未找到匹配工具。搜索未命中不代表工具不存在；可用 mcp 查看插件的完整工具目录，再按准确名称加载。' }
    const limit = args.limit ?? config.pageSize
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit 必须是 1 至 50 的整数')
    return { ...loadingResult(prepareTools(state, exec, matches.slice(0, limit), args.replace_active === true)), total: matches.length }
  }

  const replacementParameter = { type: 'boolean', description: '加载预算不足时设为 true，用本次成功加载的工具替换已加载集合；须在本步骤单独调用。' }
  const output = kind => ({
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify({ ...value,
      items: kind === 'mcp' ? value.items : value.items.map(({ definition: _definition, ...item }) => item) }) }],
    presentationMeta: (_args, value) => ({ tool_discovery: { kind, status: value.status, matched: value.items.length,
      prepared: value.items.filter(item => item.status === 'prepared').length,
      definitions: value.items.filter(item => item.definition).map(item => ({ name: item.name, plugin: item.plugin, definition: item.definition })),
    } }),
  })
  const searchDefinition = {
    name: TOOL_SEARCH_NAME,
    description: '搜索并按需加载当前可用插件工具的完整定义。可用 name 限定插件。未命中时使用 mcp 查看完整目录。新工具在下一步可调用，不要在同一批调用或同一次 run_code 中调用新发现的工具。',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: '任务用途、能力关键词或准确工具名' },
      name: { type: 'string', description: '可选：插件的唯一英文 name' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多加载的搜索结果数量，默认 8；需要完整目录时使用 mcp' },
      replace_active: replacementParameter,
    }, required: ['query'], additionalProperties: false },
    isConcurrencySafe: () => false, output: output('search'), execute: executeSearch,
  }
  const mcpDefinition = {
    name: MCP_NAME,
    description: '查看插件。无参数返回插件目录；name 返回该插件的全部工具名称和完整描述，不分页；name 加非空 tools 数组按准确名称加载一个或多个工具的完整定义。加载后下一步可调用，不在同一批调用或同一次 run_code 中调用新工具。加载不执行业务操作。',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: '插件目录中的唯一英文 name' },
      tools: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: '要加载完整定义的工具名称，一次可指定多个；省略则浏览完整目录' },
      replace_active: replacementParameter,
    }, additionalProperties: false },
    isConcurrencySafe: () => false, output: output('mcp'), execute: executeMcp,
  }
  ctx.tools.register(searchDefinition)
  ctx.tools.register(mcpDefinition)

  ctx.on('tools/result', (exec, result) => {
    const state = states.get(exec.agent), pending = state?.pending.get(exec.callId)
    if (!pending) return
    if (result.isError) state.pending.delete(exec.callId)
    else pending.finalized = true
  }, { global: true })

  function commitStep(state, event) {
    const candidates = [...state.pending.values()].filter(item => item.turn === event.data.turn && item.step === event.data.step)
    for (const item of candidates) state.pending.delete(item.callId)
    if (!candidates.length || !state.step || state.step.turn !== event.data.turn || state.step.step !== event.data.step || state.step.signal.aborted) return
    refresh(state.agent)
    const catalog = state.catalog
    if (!catalog.ready || !catalog.authorityKey) return
    let next = new Map(state.active)
    for (const candidate of candidates) {
      if (!candidate.finalized || candidate.durableSeq === undefined || candidate.authorityKey !== catalog.authorityKey) continue
      if (candidate.replace) next = new Map()
      for (const entry of candidate.tools) {
        const current = catalog.byId.get(entry.id)
        if (matchesEntry(current, entry) && !capacity(catalog, next, current)) next.set(entry.id, entry)
      }
    }
    if (JSON.stringify([...next]) === JSON.stringify([...state.active])) return
    // Native scope policy remains authoritative after our discovery mask lifts.
    // A denied candidate must not consume active budget or survive in hints.
    installMask(state, prepareMask(state, next))
    const admitted = visibleEntries(state, next)
    state.deniedCount = next.size - admitted.size
    state.unpersisted ||= JSON.stringify([...admitted]) !== JSON.stringify([...state.active])
    state.active = admitted
    installMask(state, prepareMask(state, admitted))
  }

  ctx.on('session/event', (session, event) => {
    const state = bySession.get(session)
    if (!state) return
    if (event.type === 'tool/result') {
      const callId = event.data.message.toolCallId
      if (event.data.message.isError) {
        for (const [key, pending] of state.pending) if (key === callId || pending.rootCallId === callId) state.pending.delete(key)
      } else {
        const pending = state.pending.get(callId)
        if (pending) pending.durableSeq = event.seq
      }
    } else if (event.type === 'tool/ptc-dispatch') {
      const pending = state.pending.get(event.data.subCallId)
      if (pending && [TOOL_SEARCH_NAME, MCP_NAME].includes(event.data.name)) {
        if (event.data.isError) state.pending.delete(event.data.subCallId)
        else pending.durableSeq = event.seq
      }
    } else if (event.type === 'step/end') commitStep(state, event)
    else if (event.type === 'turn/end') { state.pending.clear(); state.step = undefined }
  })

  ctx.on('agent/created', ({ agent }) => { refresh(agent) }, { global: true })
  ctx.on('agent/inbox/claimed', ({ agent }) => { refresh(agent) }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { clearAgent(agent) }, { global: true })
  ctx.on('agent/pre-step', async (payload, next) => {
    const state = stateFor(payload.agent)
    state.step = { turn: payload.turn, step: payload.step, signal: payload.signal }
    const decision = await next()
    if (decision.kind === 'reject') return decision
    payload.signal.throwIfAborted()
    refresh(payload.agent)
    const text = renderCatalog(state.catalog, config, {
      searchAllowed: ctx.tools.get(TOOL_SEARCH_NAME, payload.agent) === searchDefinition,
      browseAllowed: ctx.tools.get(MCP_NAME, payload.agent) === mcpDefinition, deniedCount: state.deniedCount,
    })
    const digest = hash(text), visible = new Set(payload.agent.session.surface.nodes)
    const history = payload.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source?.kind === 'mcp-catalog' && visible.has(event.seq)).at(-1)
    const messages = decision.messages.filter(message => message.source?.kind !== 'mcp-catalog')
    if (history?.data.source.digest === digest) return { ...decision, messages }
    return { ...decision, messages: [...messages, createUserMessage({
      content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }],
      source: { kind: 'mcp-catalog', digest },
    })] }
  }, { global: true })
  // DSH resolves variables synchronously before collecting native schemas and
  // rendering the PTC SDK. No interpolation is needed for this host-only guard.
  ctx.systemPrompt.variable('tool_discovery_snapshot', context => {
    const state = context.scope?.session ? refresh(context.scope) : undefined
    // Catalog/preview assemblies may run concurrently with native assembly.
    // They refresh their own view but cannot overwrite the in-flight guard.
    if (state && context.agent === context.scope && context.signal)
      state.assembled = { snapshot: requestSnapshot(state), signal: context.signal }
    return undefined
  })
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const state = refresh(payload.agent)
    payload.signal.throwIfAborted()
    if (state.assembled?.signal !== payload.signal || state.assembled?.snapshot !== requestSnapshot(state))
      throw new Error('本步骤已加载的插件工具权限或定义发生变化，请重新提交任务；本步骤尚未发送。')
    if (state.unpersisted) {
      // Session forbids append from inside its event publication. This native
      // request hook runs after step/end and before the provider sees schemas.
      appendPluginRecord(state.agent.session, ACTIVE_EVENT, { version: 1, authorityKey: state.authorityKey, tools: [...state.active.values()] })
      state.unpersisted = false
    }
    return config
  }, { global: true })
  ctx.systemPrompt.section({
    name: 'tools:discovery-rules', order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK') - 1,
    interpolate: false,
    text: context => [
      '插件以会话目录中的 name 定位。新加载工具仅在下一步按实际提供的名称和参数调用。用户点名插件时优先用于其对应任务。',
      ...(ctx.tools.get(MCP_NAME, context.scope) === mcpDefinition ? ['mcp 查看插件目录或用 tools 数组批量加载完整定义。'] : []),
      ...(ctx.tools.get(TOOL_SEARCH_NAME, context.scope) === searchDefinition ? [ctx.tools.get(MCP_NAME, context.scope) === mcpDefinition
        ? 'tool_search 搜索并加载工具，搜索未命中时可通过 mcp 浏览完整目录。'
        : 'tool_search 搜索并加载工具，搜索未命中不代表工具不存在。'] : []),
    ].join('\n'),
  })

  const controller = { refresh, refreshAll }
  ctx.provide('toolDiscovery', controller)
  if (bridge.subscribe) ctx.effect(() => bridge.subscribe(refreshAll), 'tool-discovery.catalog-subscription')
  ctx.effect(() => () => {
    bridge.setDiscoveryReady?.(false)
    disposed = true
    for (const agent of states.keys()) clearAgent(agent)
  }, 'tool-discovery.cleanup')
  refreshAll()
  initialized = true
  bridge.setDiscoveryReady?.(true)
  refreshAll()
}
