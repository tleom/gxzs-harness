import z from '@deepseek-ai/schemastery'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import {
  TOOL_SEARCH_NAME, activationEntry, buildCatalog, bytes, clip, cursorSignature,
  decodeCursor, encodeCursor, matchesEntry, renderCatalog, search,
} from './catalog.js'
import { ACTIVE_EVENT, PROJECTION_KEY, discoveryProjection } from './projection.js'

export { TOOL_SEARCH_NAME } from './catalog.js'
export const name = 'tool-discovery'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessionProjections', 'toolDiscoveryCatalog']
export const Config = z.object({
  pageSize: z.number().min(1).max(50).step(1).default(8),
  maxActiveTools: z.number().min(1).max(256).step(1).default(64),
  maxActiveDefinitionBytes: z.number().min(1024).step(1).default(131072),
  maxToolDefinitionBytes: z.number().min(512).step(1).default(32768),
  maxResultBytes: z.number().min(1024).step(1).default(8192),
  maxSummaryBytes: z.number().min(512).step(1).default(4096),
  descriptionChars: z.number().min(16).max(1000).step(1).default(180),
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
    const deny = [...new Set(bridge.managedNames())].filter(toolName => toolName !== TOOL_SEARCH_NAME && !names.has(toolName)).sort()
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
      catch {
        // Keep native conversation usable while every MCP tool remains hidden.
        // Invalid or over-budget input is never published as a verified empty catalog.
        state.catalog = { authorityKey: typeof snapshot.authorityKey === 'string' && snapshot.authorityKey.length <= 4096 ? snapshot.authorityKey : null, revision: String(snapshot.revision ?? ''),
          ready: false, byId: new Map(), plugins: [],
          unavailableMessage: '插件目录超出发现预算或数据无效，插件工具暂不可用；可继续处理其他任务。' }
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
    return {
      id: tool.id, name: tool.name, plugin_id: tool.pluginId, plugin_name: clip(tool.pluginName, 80),
      scope: tool.pluginScope, description: clip(tool.description, config.descriptionChars), status,
      ...(reason ? { reason } : {}),
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

  function executeSearch(args, exec) {
    exec.signal.throwIfAborted()
    if (!exec.agent) throw new Error('工具发现需要有效的智能体会话')
    const state = refresh(exec.agent), catalog = state.catalog
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const pluginId = typeof args.plugin_id === 'string' ? args.plugin_id.trim() : ''
    if (query.length > 512 || pluginId.length > 2048) throw new Error('查找条件过长，请缩短后重试')
    if (!query && !pluginId) throw new Error('请提供查找关键词或插件 ID')
    if (!catalog.ready || !catalog.authorityKey) return { status: 'unavailable', items: [], message: catalog.unavailableMessage ?? '当前插件目录暂不可用，请稍后重试。' }
    if (!state.step || state.step.signal.aborted) throw new Error('工具发现需要有效的运行步骤')
    const matches = search(catalog, query, pluginId)
    const signature = cursorSignature(catalog, query, pluginId)
    const offset = decodeCursor(args.cursor, signature, matches.length)
    if (offset === undefined) return { status: 'stale_cursor', items: [], message: '目录或查找条件已变化，请去掉 cursor 后重新查找。' }
    if (!matches.length) return { status: 'no_match', items: [], message: '未找到匹配工具；请尝试中英文能力关键词、准确工具名，或仅提供 plugin_id 浏览目录后再搜索。' }
    const replace = args.replace_active === true
    if (query && state.pending.size && (replace || [...state.pending.values()].some(item => item.replace)))
      throw new Error('replace_active 必须独占本步骤的工具发现；请在下一步单独调用。')
    const reservations = replace ? new Map() : reserved(state), rows = [], prepared = []
    const response = {
      status: query ? 'matches' : 'browse', items: rows,
      message: query ? (replace ? 'prepared 项已进入替换候选；步骤结束后按当前会话策略核验，以随后实际提供的工具为准。' : 'prepared 项已进入加载候选；步骤结束后按当前会话策略核验，以随后实际提供的工具为准。预算不足可用 replace_active:true。') : '这是插件能力目录。使用 query 指定所需能力以加载工具。',
    }
    let consumed = 0
    for (const tool of matches.slice(offset, offset + config.pageSize)) {
      const alreadyActive = !replace && state.active.has(tool.id)
      const reason = tool.unavailableReason ?? (query && !alreadyActive ? capacity(catalog, reservations, tool) : undefined)
      const status = reason ? 'unavailable' : alreadyActive ? 'active' : !query ? 'available' : 'prepared'
      const row = resultRow(tool, status, reason)
      rows.push(row)
      const hasMore = offset + consumed + 1 < matches.length
      const trial = { ...response, status: prepared.length || status === 'prepared' ? 'prepared' : response.status,
        ...(hasMore ? { next_cursor: encodeCursor(signature, offset + consumed + 1) } : {}) }
      if (bytes(trial) > config.maxResultBytes) { rows.pop(); break }
      consumed++
      if (status === 'prepared') {
        const entry = activationEntry(tool); prepared.push(entry); reservations.set(entry.id, entry)
      }
    }
    if (!rows.length) return { status: 'result_budget', items: [], message: '单条目录信息超过结果预算，请使用更准确的工具名或调整目录说明。' }
    if (offset + consumed < matches.length) response.next_cursor = encodeCursor(signature, offset + consumed)
    if (prepared.length) {
      response.status = 'prepared'
      state.pending.set(exec.callId, {
        callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId,
        authorityKey: catalog.authorityKey, turn: state.step.turn, step: state.step.step,
        tools: prepared, replace, finalized: false, durableSeq: undefined,
      })
    }
    return response
  }

  const searchDefinition = {
    name: TOOL_SEARCH_NAME,
    description: '查找并按需加载当前可用插件的真实工具。按目录的中文用途、英文标识或准确工具名搜索；无匹配可改用另一种语言，或仅提供 plugin_id 分页浏览全局/个人插件能力。prepared 表示加载候选，步骤结束后仍按当前会话策略核验；下一步以实际提供的工具为准。请勿在同一批调用或同一次 run_code 中调用新发现的工具。',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: '任务用途、能力关键词或准确工具名' },
      plugin_id: { type: 'string', description: '可选：插件目录中的稳定 ID，用来限定具体插件' },
      cursor: { type: 'string', description: '继续同一次查找时使用返回的 next_cursor，保留相同查找条件' },
      replace_active: { type: 'boolean', description: '预算不足时设为 true，在成功步骤结束后用此次发现的工具替换已有加载集合。本步骤须单独调用一次工具发现。' },
    }, additionalProperties: false },
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ tool_discovery: { kind: 'search', status: value.status, matched: value.items.length, prepared: value.items.filter(item => item.status === 'prepared').length } }),
    },
    execute: async (args, exec) => executeSearch(args, exec),
  }
  ctx.tools.register(searchDefinition)

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
      if (pending && event.data.name === TOOL_SEARCH_NAME) {
        if (event.data.isError) state.pending.delete(event.data.subCallId)
        else pending.durableSeq = event.seq
      }
    } else if (event.type === 'step/end') commitStep(state, event)
    else if (event.type === 'turn/end') { state.pending.clear(); state.step = undefined }
  })

  ctx.on('agent/created', ({ agent }) => { refresh(agent) }, { global: true })
  ctx.on('agent/inbox/claimed', ({ agent }) => { refresh(agent) }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { clearAgent(agent) }, { global: true })
  ctx.on('agent/pre-step', (payload, next) => {
    const state = stateFor(payload.agent)
    state.step = { turn: payload.turn, step: payload.step, signal: payload.signal }
    return next()
  }, { global: true })
  // DSH resolves variables synchronously before collecting native schemas and
  // rendering the PTC SDK. No interpolation is needed for this host-only guard.
  ctx.systemPrompt.variable('tool_discovery_snapshot', context => {
    const state = context.scope?.session ? refresh(context.scope) : undefined
    if (state) state.assembled = { catalogKey: state.catalogKey, maskStamp: state.maskStamp }
    return undefined
  })
  ctx.on('agent/request', (payload, next) => {
    const state = refresh(payload.agent)
    payload.signal.throwIfAborted()
    if (state.assembled?.catalogKey !== state.catalogKey || state.assembled?.maskStamp !== state.maskStamp)
      throw new Error('插件目录在请求准备期间变化，请重试；本次请求尚未发送。')
    if (state.unpersisted) {
      // Session forbids append from inside its event publication. This native
      // request hook runs after step/end and before the provider sees schemas.
      appendPluginRecord(state.agent.session, ACTIVE_EVENT, { version: 1, authorityKey: state.authorityKey, tools: [...state.active.values()] })
      state.unpersisted = false
    }
    return next()
  }, { global: true })
  ctx.systemPrompt.section({
    name: 'tools:discovery-catalog', order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK') - 1,
    interpolate: false, text: context => {
      if (!context.scope) return ''
      const state = states.get(context.scope)
      return renderCatalog(state?.catalog, config, {
        searchAllowed: ctx.tools.get(TOOL_SEARCH_NAME, context.scope) === searchDefinition, deniedCount: state?.deniedCount,
      })
    },
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
