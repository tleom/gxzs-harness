import z from '@deepseek-ai/schemastery'
import { AssertionVerifier } from './assertion.js'
import { RunEventBus } from './events.js'
import { HumanInputBridge } from './human-input.js'
import { httpError, parseJson, readBody, sendError, sendJson, withResponseSignal } from './http.js'
import { streamRunEvents } from './sse.js'
import { streamHistoryEvents, streamNativeEvents } from './history-events.js'
import { WorkbenchDatabase } from './persistence.js'
import { resolveWorkspacePath } from './paths.js'
import { claimNeedsResources, createAssistantStreamProjector, prepareRecoveredInboxes, projectInboxClaim, projectSessionEvent, reconcileNativeSessions, settleNativeIdle } from './projection.js'
import { WorkbenchRuntime } from './runtime.js'
import { WorkbenchService } from './service.js'
import { TaskScheduler } from './scheduler.js'
import { registerDatabasePrompt } from './database-prompt.js'
import { registerModelToolCallGuard } from './model-tool-call-guard.js'
import { databaseModelCatalog } from './database-models.js'
import { registerRunResourceContext } from './resource-mentions.js'
import { prepareNativeFiles } from './attachments.js'
import { WorkbenchWorkspaces } from './workspaces.js'
import { streamWorkspaceEvents } from './workspace-events.js'
import { WorkbenchSchedules } from './schedules.js'
import { WorkbenchSubagents } from './subagents.js'
import { WorkbenchTerminals } from './terminals.js'
import { WorkbenchBrowsers } from './browsers.js'
import { SidebarLeases } from './sidebar-leases.js'
import { registerBrowserTool } from './browser-tool.js'
import { browserClient } from './browser-client.js'
import { registerTerminalTool } from './terminal-tool.js'
import { WorkbenchJobs } from './jobs.js'
import { registerScheduledClaims } from './scheduled-claims.js'
import { isNativeNotice } from './display-events.js'
import { registerToolDisplayReceipts } from './tool-display-receipts.js'
import { nativeHostActivity } from './host-activity.js'
import { WorkbenchNativeClient } from './native-client.js'
import { WorkbenchNativeSessions } from './native-sessions.js'
import { WorkbenchSubagentSettings } from './settings.js'
import { setTimeout as delay } from 'node:timers/promises'

export const name = 'workbench-adapter'
export const inject = ['webServer', 'sessionController', 'workspaceController', 'sessionReferenceResolver', 'fileReferences', 'workspaceChanges', 'workingDirectory', 'agents', 'commands', 'skills', 'systemPrompt', 'tokenMeter', 'workbenchFileManager', 'workbenchPlatformClient', 'sessionQuery', 'sessionProjections', 'agentPresets', 'agentDefaultModel', 'settings', 'attachments', 'fileUploads', 'goals', 'terminalController', 'subagents', 'subprocess', 'jobs', 'jobController', 'tools']

export const Config = z.object({
  basePath: z.string().default('/ai/workbench'),
  databasePath: z.string().required(),
  workspace: z.string().default('/workspace'),
  ownerId: z.string().required(),
  assertionIssuer: z.string().required(),
  assertionAudiencePath: z.string().default('/console/api/workbench'),
  assertionKeyEnv: z.string().default('GXZS_ASSERTION_SIGNING_KEY'),
  humanInputTimeoutSeconds: z.number().default(60),
})



export async function waitSessionActivity(ctx, sessionId, { timeoutMs = 30_000, pollMs = 50 } = {}) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Session activity did not settle before deletion')), timeoutMs)
  })
  try {
    while ((await Promise.race([
      ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([])), timeout,
    ])).length) {
      await Promise.race([new Promise(resolve => setTimeout(resolve, pollMs)), timeout])
    }
  } finally { clearTimeout(timer) }
}

export function apply(ctx, config) {
  if (!config.ownerId || !config.assertionIssuer) throw new Error('workbench host owner and assertion issuer are required')
  registerModelToolCallGuard(ctx)
  const eventBus = new RunEventBus()
  const database = new WorkbenchDatabase(config.databasePath, { onEvent: (runId, event) => {
    eventBus.publish(runId, event)
    if (event.event === 'workbench_end') ctx.emit('workbench/completion')
  } })
  const runtime = new WorkbenchRuntime(ctx, database, config.ownerId)
  const workspaces = new WorkbenchWorkspaces({ controller: ctx.workspaceController, database, root: resolveWorkspacePath(config.workspace, 'conversations'), fileManager: ctx.workbenchFileManager, sessions: ctx.sessionController })
  const scheduler = new TaskScheduler({ database, sessions: ctx.sessionController, platformClient: ctx.workbenchPlatformClient, ownerId: config.ownerId, agents: ctx.agents, modelSettings: ctx.settings, goals: ctx.goals,
    prepareContent: (sessionId, content) => prepareNativeFiles(ctx.fileUploads, sessionId, content) })
  runtime.scheduler = scheduler
  scheduler.hasOwnedWork = sessionId => runtime.hasOwnedWork(sessionId)
  scheduler.cancelOwned = (sessionId, runId) => runtime.cancelOwned(sessionId, runId)
  scheduler.executionRun = (sessionId) => runtime.executionRun(sessionId)
  const service = new WorkbenchService({ database, sessionController: ctx.sessionController, agents: ctx.agents, commands: ctx.commands, skills: ctx.skills, fileManager: ctx.workbenchFileManager, platformClient: ctx.workbenchPlatformClient, workspace: config.workspace, sessionQuery: ctx.sessionQuery, agentPresets: ctx.agentPresets, agentDefaultModel: ctx.agentDefaultModel, modelSettings: ctx.settings, scheduler, attachments: ctx.attachments, goals: ctx.goals, fileUploads: ctx.fileUploads, nativeFileAttachments: process.env.GXZS_NATIVE_FILE_ATTACHMENTS === '1' })
  service.workspaceChanges = ctx.workspaceChanges
  service.workingDirectory = ctx.workingDirectory
  service.onGoalChanged = listener => ctx.on('goal/changed', listener, { prepend: true })
  service.workspaces = workspaces
  service.sessionReferences = ctx.sessionReferenceResolver
  service.fileReferences = ctx.fileReferences
  service.cancelOwned = (sessionId, runId) => runtime.cancelOwned(sessionId, runId)
  service.hasOwnedWork = (sessionId, runId) => runtime.hasOwnedWork(sessionId, runId)
  service.executionRun = sessionId => runtime.executionRun(sessionId)
  service.refreshMcpCatalog = owner => {
    if (owner.ownerId !== config.ownerId || !runtime.refreshMcpCatalog)
      throw Object.assign(new Error('MCP 工具目录暂不可用，请稍后重试'), { status: 503, code: 'MCP_CATALOG_UNAVAILABLE' })
    return runtime.refreshMcpCatalog()
  }
  service.waitSessionActivity = sessionId => waitSessionActivity(ctx, sessionId)
  const schedules = new WorkbenchSchedules({ native: () => ctx.get('schedule'), database, service })
  workspaces.schedules = schedules
  const subagents = new WorkbenchSubagents({ sessions: ctx.sessionController, service, native: ctx.subagents, attachments: ctx.attachments, runtime })
  const nativeSessions = new WorkbenchNativeSessions({ ctx, sessions: ctx.sessionController, service, subagents, database })
  const terminals = new WorkbenchTerminals({ native: ctx.terminalController, service, sessions: ctx.sessionController })
  const browsers = new WorkbenchBrowsers({ subprocess: ctx.subprocess, service })
  const sidebarLeases = new SidebarLeases({ browsers, terminals, service })
  runtime.sidebarActivity = () => ({ browser: browsers.activity(), terminal: terminals.activity() })
  registerBrowserTool(ctx, { browsers, runtime, database, ownerId: config.ownerId })
  registerTerminalTool(ctx, { native: ctx.terminalController, terminals, runtime, database, ownerId: config.ownerId })
  const jobs = new WorkbenchJobs({ native: ctx.jobController, registry: ctx.jobs, service, subagents })
  const nativeClient = new WorkbenchNativeClient({ modules: () => ctx.get('clientModules') })
  const subagentSettings = new WorkbenchSubagentSettings({ controller: () => ctx.get('settingsController'),
    modelCatalog: owner => databaseModelCatalog(ctx.workbenchPlatformClient, ctx.sessionController, owner, ctx.settings),
    assertWritable: () => ctx.workbenchFileManager.assertSettingsWritable() })
  service.closeTerminals = async sessionId => {
    const items = ctx.terminalController.list(sessionId)
    if (!items.length) return
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    await Promise.all(items.map(item => ctx.terminalController.close(resolved.agent, item.id)))
  }
  service.subscribeGoal = (sessionId, listener) => ctx.on('goal/activation-changed', event => {
    if (event.sessionId === sessionId) listener()
  }, { global: true })
  // MCP readiness can retry recovery after native timers already claimed new work.
  // Freeze the startup boundary once, independently of those retry entry points.
  const startupRunIds = database.listChats(config.ownerId)
    .flatMap(chat => database.listRuns(config.ownerId, chat.id).map(run => run.id))
  let recovered = false
  let recoveryError
  let recoveryTimer
  let recovery
  let recovering = false
  const beginRecovery = () => {
    if (recovering) return recovery
    clearTimeout(recoveryTimer)
    recovering = true
    recovered = false
    recovery = (async () => {
      const queued = await reconcileNativeSessions(database, ctx.sessionQuery, config.ownerId, () => {
        // Missing autonomous receipts need a fresh frozen catalog. Retry
        // recovery until its first verified sync; an unavailable read is not empty.
        if (!runtime.mcpCatalogState?.ready) throw Object.assign(
          new Error('MCP catalog is not ready for native notice recovery'), { code: 'MCP_CATALOG_UNAVAILABLE' })
        return { mcpTools: runtime.mcpResources?.() ?? [] }
      }, startupRunIds, () => ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
      await scheduler.flushFences()
      const resumeInboxes = await prepareRecoveredInboxes(database, ctx.sessionController, config.ownerId, queued,
        () => ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
      if (scheduler.closed) return
      recovered = true
      recoveryError = undefined
      scheduler.start()
      resumeInboxes()
    })().catch(error => {
      recoveryError = error
      if (!scheduler.closed) {
        recoveryTimer = setTimeout(beginRecovery, 1000)
        recoveryTimer.unref?.()
      }
    }).finally(() => { recovering = false })
    return recovery
  }
  beginRecovery()
  const humanInput = new HumanInputBridge({ database, timeoutSeconds: config.humanInputTimeoutSeconds,
    executionRun: sessionId => runtime.executionRun(sessionId), resumeInput: (run, signal) => scheduler.resumeInput(run, signal) })
  service.humanInput = humanInput
  const verifier = new AssertionVerifier({
    issuer: config.assertionIssuer,
    signingKey: process.env[config.assertionKeyEnv],
  })

  registerDatabasePrompt(ctx, config.ownerId)
  registerRunResourceContext(ctx)

  const projectAssistantStream = createAssistantStreamProjector(database, config.ownerId)
  ctx.on('user-questions/request', humanInput.handleRequest, { global: true, prepend: true })
  ctx.on('agent/assistant-stream', projectAssistantStream, { global: true })
  ctx.on('agent/created', ({ agent }) => runtime.bindChild(agent), { global: true, prepend: true })
  ctx.on('subagent/start', ({ id }) => {
    const child = ctx.agents.get(id)
    if (child) runtime.bindChild(child, { activation: true })
  }, { global: true, prepend: true })
  registerScheduledClaims(ctx, { runtime, database, ownerId: config.ownerId })
  registerToolDisplayReceipts(ctx, { runtime, database, ownerId: config.ownerId })
  ctx.on('agent/pre-step', async (payload, next) => {
    const autonomous = payload.messages?.filter(message => ['schedule', 'tool-jobs'].includes(message.source?.kind) || isNativeNotice(message)) ?? []
    const displays = new Map()
    const rememberSchedule = run => {
      if (run?.selection?.native_source === 'schedule' && !displays.has(run.id)) {
        displays.set(run.id, schedules.rememberRun(run).catch(() => {
          ctx.logger.warn('Scheduled delivery title enrichment deferred')
        }))
      }
    }
    if (autonomous.length) {
      const needsResources = autonomous.some(message => claimNeedsResources(database,
        { agent: payload.agent, message, turn: payload.turn }, config.ownerId))
      while (needsResources && !runtime.mcpCatalogState?.ready) {
        await delay(100, undefined, { signal: payload.signal })
      }
      payload.signal?.throwIfAborted()
      for (const message of autonomous) {
        const claimed = projectInboxClaim(database, { agent: payload.agent, message, turn: payload.turn }, config.ownerId,
          needsResources ? { mcpTools: runtime.mcpResources?.() ?? [] } : undefined)
        rememberSchedule(claimed)
      }
    }
    await recovery
    if (autonomous.length && recoveryError) await beginRecovery()
    if (recoveryError) return { kind: 'reject' }
    rememberSchedule(runtime.executionRun(payload.agent.session?.id ?? payload.agent.id))
    await Promise.all(displays.values())
    return scheduler.admitNativeStep(payload, () => service.guardSkillInvocations(payload, next))
  }, { global: true, prepend: true })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') {
      runtime.settleChild(agent)
      settleNativeIdle(database, agent.session?.id ?? agent.id, ctx.goals?.get(agent))
    }
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    let context
    if (session && ['plan/mode', 'command/run', 'command/done'].includes(event.type))
      context = { plan: ctx.sessionProjections.snapshot(session, ['plan']).values.plan }
    if (session && ['assistant/message', 'request/context'].includes(event.type)) {
      const requestContext = session.requestContext()
      const measurement = ctx.tokenMeter.measure(session)
      context = {
        used_tokens: measurement.totalTokens,
        window_tokens: requestContext?.contextWindow ?? null,
        estimated: measurement.baseline.kind !== 'usage',
        model: requestContext ? `${requestContext.provider}/${requestContext.model}` : '',
      }
    }
    if (event.type === 'turn/end' || event.type === 'goal/change') {
      const agent = ctx.agents.get(session.id)
      context = { ...context, goal: agent ? ctx.goals?.get(agent) : undefined, nativeIdle: agent?.status === 'idle' }
    }
    projectSessionEvent(database, session?.id ?? session?.header?.id, event, config.ownerId,
      { ...context, mcpCatalogReady: runtime.mcpCatalogState?.ready === true, mcpTools: runtime.mcpResources?.() ?? [] })
  }, { global: true })

  const buildCatalog = async (owner, modelsOnly = false, chatId) => {
    const [catalog, mcpCatalog, skills] = await Promise.all([
      databaseModelCatalog(ctx.workbenchPlatformClient, ctx.sessionController, owner, ctx.settings),
      modelsOnly ? { tools: [], plugins: [] } : service.mcpCatalog(owner, { includePlugins: true }), modelsOnly ? [] : service.catalogSkills(owner, chatId),
    ])
    const models = (catalog.groups ?? []).flatMap((group) => (group.models ?? []).map((model) => ({
      id: `${group.id}/${model.id}`, name: model.name || model.id, provider: group.id, description: model.description,
    })))
    return {
      resources_pending: modelsOnly,
      dsh_version: '0.2.1-alpha.2', schedule_protocol: 1, subagent_protocol: 1, terminal_protocol: 1, browser_protocol: 1, browser_input_protocol: 2, job_protocol: 1,
      activity_protocol: 1, sidebar_lease_protocol: 1, human_input_protocol: 1, followup_protocol: 1, history_protocol: 1, native_history_protocol: 1,
      ...(ctx.get('clientModules') ? { native_client_protocol: 1, native_session_client_protocol: 2, native_schedule_client_protocol: 1,
        ...(ctx.sessionReferenceResolver.listSessionCandidates && ctx.get('fileReferences')?.listObserved ? { native_subagent_reference_protocol: 1 } : {}),
        ...(ctx.get('settingsController') ? { native_subagent_settings_protocol: 1, native_prompt_mode_protocol: 1 } : {}) } : {}),
      control_protocol: 1, goal_events_protocol: 1, compact_events_protocol: 1, resources_protocol: 1, command_resources_protocol: 1, plugin_mentions_protocol: 2, scoped_skills_protocol: 1, submission_control_protocol: 1,
      default_selection: { model: catalog.default ? `${catalog.default.provider}/${catalog.default.model}` : models[0]?.id ?? '', tools: [], skills: [], knowledge: [], model_parameters: {}, tool_parameters: {} },
      models, plugins: mcpCatalog.plugins, tools: mcpCatalog.tools.map((tool) => ({
        id: tool.id, name: tool.name, display_name: tool.display_name,
        description: tool.description, scope: tool.scope,
        group: tool.group, provider: tool.provider, provider_name: tool.provider_name,
        provider_call_name: tool.provider_call_name, provider_description: tool.provider_description,
        tool_name: tool.tool_name, runtime_name: tool.runtime_name,
      })),
      skills: skills.map((skill) => ({
        ...skill, id: skill.scope === 'personal' ? `personal:${skill.id}` : skill.id,
      })),
      knowledge: [],
    }
  }

  const managerPath = (value, { allowRoot = false } = {}) => {
    const requested = String(value ?? '')
    if (!requested) throw httpError(400, '缺少 path')
    const absolute = resolveWorkspacePath(config.workspace, requested)
    const root = config.workspace.replace(/\/+$/, '')
    if (absolute === root) {
      if (allowRoot) return '.'
      throw httpError(403, '工作区根目录不可修改')
    }
    const prefix = `${root}/`
    if (!absolute.startsWith(prefix)) throw httpError(403, '文件路径超出工作区')
    return absolute.slice(prefix.length)
  }

  const proxyPlatform = async (context, res, route) => withResponseSignal(res, async signal => {
    const result = await ctx.workbenchPlatformClient.request({
      owner: context.owner, method: context.req.method, route, query: context.url.search,
      body: context.body, contentType: context.req.headers['content-type'] ?? '',
      signal,
      ...(route === 'files/preview' && context.req.method !== 'DELETE' ? { timeoutMs: 120000 } : {}),
    })
    signal.throwIfAborted()
    const headers = { 'cache-control': 'private, no-store' }
    for (const name of ['content-type', 'content-disposition', 'etag', 'x-workbench-preview-metadata']) {
      const value = result.headers.get(name)
      if (value) headers[name] = value
    }
    res.writeHead(result.status, headers)
    res.end(Buffer.from(result.bytes))
  })

  const routes = [
    ['GET', /^\/native\/sessions$/, async ({ owner }, res) => {
      const controller = new AbortController()
      const close = () => controller.abort()
      res.on('close', close)
      try { sendJson(res, 200, { data: await nativeSessions.list(owner, controller.signal) }) }
      finally { res.off('close', close) }
    }],
    ['GET', /^\/native\/sessions\/control$/, async ({ owner }, res) =>
      streamNativeEvents({ res, follow: signal => nativeSessions.control(owner, signal) })],
    ['GET', /^\/native\/sessions\/events$/, async ({ owner }, res) =>
      streamNativeEvents({ res, follow: signal => nativeSessions.events(owner, signal) })],
    ['GET', /^\/chats\/([\w-]+)\/native\/session\/follow$/, async ({ owner, url }, res, match) => {
      const request = parseJson(Buffer.from(url.searchParams.get('request') || '{}'))
      await streamNativeEvents({ res, follow: signal => nativeSessions.follow(owner, match[1], request, signal) })
    }],
    ['GET', /^\/chats\/([\w-]+)\/native\/session\/(page|projections|attachment)$/, async ({ owner, url }, res, match) => {
      const request = parseJson(Buffer.from(url.searchParams.get('request') || '{}'))
      const controller = new AbortController()
      const close = () => controller.abort()
      res.on('close', close)
      try { sendJson(res, 200, { data: await nativeSessions.read(owner, match[1], match[2], request, controller.signal) }) }
      finally { res.off('close', close) }
    }],
    ['GET', /^\/native\/client$/, async (_context, res) => sendJson(res, 200, { data: nativeClient.manifest() })],
    ['GET', /^\/native\/client\/bundle$/, async ({ url }, res) => sendJson(res, 200, {
      data: await nativeClient.bundle(url.searchParams.get('url'), url.searchParams.get('rev')),
    })],
    ['GET', /^\/chats\/([\w-]+)\/events$/, async ({ owner }, res, match) => {
      await service.ensureChatDirectory(owner, match[1])
      await streamHistoryEvents({ service, owner, chatId: match[1], res })
    }],
    ['GET', /^\/chats\/([\w-]+)\/history$/, async ({ owner, url }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try {
        const raw = url.searchParams.get('cursor')
        let cursor
        if (raw !== null) {
          try { cursor = JSON.parse(raw) }
          catch { throw httpError(400, '历史消息游标无效，请重新打开对话') }
        }
        if (raw === null) await service.ensureChatDirectory(owner, match[1])
        const data = await service.historyPage(owner, match[1], cursor, abort.signal, url.searchParams.get('native') === '1')
        if (!abort.signal.aborted) sendJson(res, 200, { data })
      } finally { res.off('close', disconnected) }
    }],
    ['GET', /^\/chats\/([\w-]+)\/changes$/, async ({owner,url},res,match) => {
      const abort=new AbortController()
      const disconnected=()=>abort.abort()
      res.once('close',disconnected)
      try {
        const data=await service.changes(owner,match[1],url.searchParams.get('seq'),url.searchParams.get('index'),abort.signal)
        if(!abort.signal.aborted) sendJson(res,200,{data})
      } finally {res.off('close',disconnected)}
    }],
    ['GET', /^\/identity$/, async ({ owner }, res) => sendJson(res, 200, {
      user: { id: owner.userId, name: owner.name, email: '' }, workspaceId: owner.tenantId,
      workspaces: [{ id: owner.tenantId, name: owner.tenantId, current: true }],
    })],
    ['GET', /^\/catalog$/, async ({ owner, url }, res) => sendJson(res, 200, { data: await buildCatalog(owner, url.searchParams.get('view') === 'models', url.searchParams.get('chat_id')) })],
    ['GET', /^\/native\/settings$/, async (_context, res) => sendJson(res, 200, { data: subagentSettings.describe() })],
    ['POST', /^\/native\/settings\/mutate$/, async ({ owner, body }, res) => sendJson(res, 200, { data: await subagentSettings.mutate(owner, parseJson(body)) })],
    ['GET', /^\/native\/models$/, async ({ owner }, res) => sendJson(res, 200, { data: await databaseModelCatalog(ctx.workbenchPlatformClient, ctx.sessionController, owner, ctx.settings) })],
    ['GET', /^\/chats\/([\w-]+)\/references$/, async ({ owner, url }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try {
        const data = await service.referenceCandidates(owner, match[1], url.searchParams.get('query') || '', abort.signal)
        if (!abort.signal.aborted) sendJson(res, 200, { data })
      } finally { res.off('close', disconnected) }
    }],
    ['GET', /^\/chats\/([\w-]+)\/subagents\/([\w-]+)\/references$/, async ({ owner, url }, res, match) => withResponseSignal(res, async signal => {
      const data = await subagents.references(owner, match[1], match[2], url.searchParams.get('query') || '', signal)
      if (!signal.aborted) sendJson(res, 200, { data })
    })],
    ['GET', /^\/workspaces$/, async ({ owner }, res) => sendJson(res, 200, { data: await workspaces.baseline(owner) })],
    ['GET', /^\/schedules$/, async ({ owner }, res) => sendJson(res, 200, { data: await schedules.catalog(owner) })],
    ['POST', /^\/sidebar\/lease$/, async ({ owner, json }, res) => sendJson(res, 200, { data: await sidebarLeases.update(owner, json) })],
    ['DELETE', /^\/sidebar\/lease\/([\w-]+)$/, async ({ owner }, res, match) => { await sidebarLeases.release(owner, match[1]); sendJson(res, 200, { data: {} }) }],
    ['POST', /^\/browsers$/, async ({ owner, json }, res) => {
      const abort = new AbortController()
      const cancel = () => abort.abort()
      res.on('close', cancel)
      try { sendJson(res, 201, { data: await browsers.create(owner, json, abort.signal) }) }
      finally { res.off('close', cancel) }
    }],
    ['GET', /^\/browser-client$/, async (_context, res) => sendJson(res, 200, { data: await browserClient() })],
    ['POST', /^\/browsers\/([\w-]+)\/display$/, async ({ owner, json }, res, match) => withResponseSignal(res, async signal => {
      await browsers.displayInput(owner, match[1], json, signal)
      if (!signal.aborted) sendJson(res, 200, { data: {} })
    })],
    ['GET', /^\/browsers\/([\w-]+)\/events$/, async ({ owner, url }, res, match) =>
      streamNativeEvents({ res, follow: signal => browsers.follow(owner, match[1], url.searchParams.get('attachment'), signal, url.searchParams.get('visible') !== '0', url.searchParams.get('display_protocol') === '1') })],
    ['POST', /^\/browsers\/([\w-]+)\/actions$/, async ({ owner, json }, res, match) => {
      const abort = new AbortController()
      const cancel = () => abort.abort()
      res.on('close', cancel)
      try {
        const value = await browsers.control(owner, match[1], json, AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]))
        if (!abort.signal.aborted) sendJson(res, 200, { data: value || {} })
      } finally { res.off('close', cancel) }
    }],
    ['DELETE', /^\/browsers\/([\w-]+)$/, async ({ owner }, res, match) => {
      await browsers.close(owner, match[1]); sendJson(res, 200, { data: {} })
    }],
    ['GET', /^\/chats\/([\w-]+)\/terminals$/, async ({ owner }, res, match) => sendJson(res, 200, { data: terminals.list(owner, match[1]) })],
    ['POST', /^\/chats\/([\w-]+)\/terminals$/, async ({ owner, json }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try {
        const data = await terminals.create(owner, match[1], json, abort.signal)
        if (!abort.signal.aborted) sendJson(res, 201, { data })
      } finally { res.off('close', disconnected) }
    }],
    ['GET', /^\/chats\/([\w-]+)\/terminals\/([\w-]+)\/events$/, async ({ owner, url }, res, match) => streamNativeEvents({ res, follow: signal => terminals.follow(owner, match[1], match[2], url.searchParams.get('attachment'), signal) })],
    ['POST', /^\/chats\/([\w-]+)\/terminals\/([\w-]+)\/(write|resize)$/, async ({ owner, json }, res, match) => { await terminals.control(owner, match[1], match[2], match[3], json); sendJson(res, 200, { data: {} }) }],
    ['DELETE', /^\/chats\/([\w-]+)\/terminals\/([\w-]+)$/, async ({ owner }, res, match) => { await terminals.control(owner, match[1], match[2], 'close', {}); sendJson(res, 200, { data: {} }) }],
    ['GET', /^\/chats\/([\w-]+)\/jobs\/events$/, async ({ owner, url }, res, match) =>
      streamNativeEvents({ res, follow: signal => jobs.list(owner, match[1], signal, url.searchParams.get('session_id')) })],
    ['GET', /^\/chats\/([\w-]+)\/jobs\/([\w-]{1,128})\/events$/, async ({ owner, url }, res, match) =>
      streamNativeEvents({ res, follow: signal => jobs.follow(owner, match[1], match[2], url.searchParams.get('from'), signal, url.searchParams.get('session_id')) })],
    ['POST', /^\/chats\/([\w-]+)\/jobs\/([\w-]{1,128})\/stop$/, async ({ owner, url }, res, match) =>
      sendJson(res, 200, { data: await jobs.stop(owner, match[1], match[2], url.searchParams.get('session_id'), new AbortController().signal) })],
    ['GET', /^\/chats\/([\w-]+)\/subagents$/, async ({ owner }, res, match) => sendJson(res, 200, { data: await subagents.catalog(owner, match[1], new AbortController().signal) })],
    ['POST', /^\/chats\/([\w-]+)\/subagents\/([\w-]+)\/stop$/, async ({ owner }, res, match) =>
      sendJson(res, 200, { data: await subagents.stop(owner, match[1], match[2], new AbortController().signal) })],
    ['PATCH', /^\/chats\/([\w-]+)\/subagents\/([\w-]+)\/queue$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await subagents.updateQueue(owner, match[1], match[2], json, new AbortController().signal) })],
    ['POST', /^\/chats\/([\w-]+)\/subagents\/([\w-]+)\/messages$/, async ({ owner, json }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try { const data = await subagents.prompt(owner, match[1], match[2], json, abort.signal)
        if (!abort.signal.aborted) sendJson(res, 201, { data })
      } finally { res.off('close', disconnected) }
    }],
    ['POST', /^\/chats\/([\w-]+)\/subagents\/([\w-]+)\/images$/, async ({ owner, json }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try {
        const image = await subagents.image(owner, match[1], match[2], json.ref, abort.signal)
        if (!abort.signal.aborted) {
          res.writeHead(200, { 'content-type': image.ref.mediaType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          res.end(Buffer.from(image.data))
        }
      } finally { res.off('close', disconnected) }
    }],
    ['GET', /^\/chats\/([\w-]+)\/subagents\/([\w-]+)\/history$/, async ({ owner, url }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try {
        const cursor = url.searchParams.has('cursor') ? parseJson(Buffer.from(url.searchParams.get('cursor'))) : undefined
        const page = await subagents.history(owner, match[1], match[2], cursor, abort.signal)
        if (!abort.signal.aborted) sendJson(res, 200, { data: page })
      } finally { res.off('close', disconnected) }
    }],
    ['POST', /^\/chats\/([\w-]+)\/schedules$/, async ({ owner, json }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try {
        const data = await schedules.create(owner, match[1], json, abort.signal)
        if (!abort.signal.aborted) sendJson(res, 201, { data })
      } finally { res.off('close', disconnected) }
    }],
    ['GET', /^\/schedules\/([\w-]+)\/history$/, async ({ owner, url }, res, match) => sendJson(res, 200, { data: await schedules.history(owner, match[1], url.searchParams.get('before')) })],
    ['PATCH', /^\/schedules\/([\w-]+)$/, async ({ owner, json }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try {
        const data = await schedules.update(owner, match[1], json, abort.signal)
        if (!abort.signal.aborted) sendJson(res, 200, { data })
      } finally { res.off('close', disconnected) }
    }],
    ['DELETE', /^\/schedules\/([\w-]+)$/, async ({ owner }, res, match) => {
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      res.once('close', disconnected)
      try {
        const data = await schedules.delete(owner, match[1], abort.signal)
        if (!abort.signal.aborted) sendJson(res, 200, { data })
      } finally { res.off('close', disconnected) }
    }],
    ['GET', /^\/workspaces\/events$/, async ({ owner }, res) => streamWorkspaceEvents({ workspaces, owner, res,
      subscribe: changed => {
        const stops = ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity', 'schedule/changed', 'workbench/completion'].map(event => ctx.on(event, changed))
        return () => stops.forEach(stop => stop())
      },
    })],
    ['POST', /^\/workspaces$/, async ({ owner, json }, res) => sendJson(res, 200, { data: await workspaces.mutate(owner, json) })],
    ['GET', /^\/models\/parameters$/, async ({ url, owner }, res) => sendJson(res, 200, { data: await service.modelParameters(url.searchParams.get('model'), owner) })],
    ['GET', /^\/resources$/, async ({ owner }, res) => sendJson(res, 200, { data: await service.resources(owner) })],
    ['POST', /^\/resources$/, async ({ owner, json }, res) => {
      const result = await service.mutateResource(json, owner)
      if (json.operation !== 'skill_inspect' && json.operation !== 'mcp_read') ctx.emit('workbench/resources-changed')
      sendJson(res, 200, { data: result })
    }],
    ['GET', /^\/chats$/, async ({ owner }, res) => sendJson(res, 200, { data: service.listChats(owner) })],
    ['POST', /^\/chats$/, async ({ owner, json }, res) => {
      const catalog = await databaseModelCatalog(ctx.workbenchPlatformClient, ctx.sessionController, owner, ctx.settings)
      const defaultModel = catalog.default ? `${catalog.default.provider}/${catalog.default.model}` : ''
      const chat = await service.createChat(owner, config.workspace, {
        model: defaultModel, tools: [], skills: [], knowledge: [], model_parameters: {}, tool_parameters: {},
      }, json.workspaceId)
      sendJson(res, 201, { data: service.getChat(owner, chat.id) })
    }],
    ['GET', /^\/chats\/([\w-]+)$/, async ({ owner }, res, match) => {
      await service.ensureChatDirectory(owner, match[1])
      sendJson(res, 200, { data: service.getChat(owner, match[1]) })
    }],
    ['PATCH', /^\/chats\/([\w-]+)$/, async ({ owner, json }, res, match) => sendJson(res, 200, { data: await service.updateChat(owner, match[1], json) })],
    ['DELETE', /^\/chats\/([\w-]+)$/, async ({ owner }, res, match) => {
      await service.deleteChat(owner, match[1])
      res.writeHead(204)
      res.end()
    }],
    ['PUT', /^\/chats\/([\w-]+)\/config$/, async ({ owner, json }, res, match) => sendJson(res, 200, { data: await service.updateConfig(owner, match[1], json) })],
    ['GET', /^\/chats\/([\w-]+)\/control$/, async ({ owner }, res, match) => sendJson(res, 200, { data: await service.getControl(owner, match[1]) })],
    ['POST', /^\/chats\/([\w-]+)\/todos\/clear$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.clearTodos(owner, match[1], json) })],
    ['POST', /^\/chats\/([\w-]+)\/goals\/(edit|pause|resume|clear)$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.mutateGoal(owner, match[1], match[2], json) })],
    ['POST', /^\/chats\/([\w-]+)\/commands$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.issueCommand(owner, match[1], json) })],
    ['GET', /^\/chats\/([\w-]+)\/followups$/, async ({ owner, url }, res, match) => {
      const tracked = (url.searchParams.get('tracked') ?? '').split(',').filter(Boolean)
      sendJson(res, 200, { data: service.followups(owner, match[1], tracked) })
    }],
    ['POST', /^\/chats\/([\w-]+)\/runs$/, async ({ owner, json }, res, match) =>
      sendJson(res, 202, { data: await service.submitRun(owner, match[1], json) })],
    ['POST', /^\/chats\/([\w-]+)\/runs\/stop$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.stopSubmission(owner, match[1], json.request_key) })],
    ['GET', /^\/runs\/([\w-]+)$/, async ({ owner, url }, res, match) => sendJson(res, 200, {
      data: service.getRun(owner, match[1], url.searchParams.get('view') !== 'state',
        url.searchParams.has('after') ? { after: url.searchParams.get('after'), through: url.searchParams.get('through') } : undefined),
    })],
    ['GET', /^\/runs\/([\w-]+)\/mcp-authorization$/, async ({ owner, url }, res, match) =>
      sendJson(res, 200, { data: { authorized: runtime.authorizeRunMcp(owner.ownerId, match[1], url.searchParams.get('resource_id'), url.searchParams.get('version')) } })],
    ['POST', /^\/runs\/([\w-]+)\/fork$/, async ({ owner, json }, res, match) =>
      sendJson(res, 201, { data: await service.fork(owner, match[1], json) })],
    ['POST', /^\/runs\/([\w-]+)\/feedbacks$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: service.feedback(owner, match[1], json.rating ?? null) })],
    ['POST', /^\/runs\/([\w-]+)\/stop$/, async ({ owner }, res, match) =>
      sendJson(res, 200, { data: await service.stopRun(owner, match[1]) })],
    ['PATCH', /^\/runs\/([\w-]+)\/queue$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.editQueued(owner, match[1], json) })],
    ['DELETE', /^\/runs\/([\w-]+)\/queue$/, async ({ owner }, res, match) =>
      sendJson(res, 200, { data: await service.removeQueued(owner, match[1]) })],
    ['POST', /^\/runs\/([\w-]+)\/steer$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.steer(owner, match[1], String(json.target_run_id ?? '')) })],
    ['POST', /^\/runs\/([\w-]+)\/input-supplement$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.supplement(owner, match[1], json) })],
    ['POST', /^\/runs\/([\w-]+)\/resume$/, async ({ owner, json }, res, match) => {
      humanInput.resume(owner.ownerId, match[1], json)
      sendJson(res, 200, { data: service.getRun(owner, match[1]) })
    }],
    ['POST', /^\/runs\/([\w-]+)\/input-skip$/, async ({ owner, json }, res, match) => {
      humanInput.skip(owner.ownerId, match[1], json.request_id)
      sendJson(res, 200, { data: service.getRun(owner, match[1]) })
    }],
    ['POST', /^\/runs\/([\w-]+)\/input-timeout$/, async ({ owner, json }, res, match) => {
      humanInput.timeout(owner.ownerId, match[1], json.request_id)
      sendJson(res, 200, { data: service.getRun(owner, match[1]) })
    }],
    ['POST', /^\/runs\/([\w-]+)\/input-interaction$/, async ({ owner, json }, res, match) => {
      humanInput.touch(owner.ownerId, match[1], json.request_id)
      sendJson(res, 200, { data: service.getRun(owner, match[1]) })
    }],
    // The platform renders Word in an offline, resource-limited container.
    ['GET', /^\/files\/preview$/, async (context, res) => proxyPlatform(context, res, 'files/preview')],
    ['POST', /^\/files\/preview$/, async (context, res) => proxyPlatform(context, res, 'files/preview')],
    ['DELETE', /^\/files\/preview$/, async (context, res) => proxyPlatform(context, res, 'files/preview')],
    ['GET', /^\/files\/shares$/, async (context, res) => proxyPlatform(context, res, 'files/shares')],
    ['POST', /^\/files\/shares$/, async (context, res) => proxyPlatform(context, res, 'files/shares')],
    ['DELETE', /^\/files\/shares$/, async (context, res) => proxyPlatform(context, res, 'files/shares')],
    ['POST', /^\/chats\/draft\/audio$/, async (context, res) => proxyPlatform(context, res, 'audio')],
    ['POST', /^\/chats\/([\w-]+)\/audio$/, async (context, res, match) => {
      service.requireChat(context.owner, match[1])
      await proxyPlatform(context, res, 'audio')
    }],
    ['GET', /^\/files$/, async ({ url }, res) => withResponseSignal(res, async signal => {
      const requested = managerPath(url.searchParams.get('path') || '.', { allowRoot: true })
      const result = await ctx.workbenchFileManager.operate({ operation: 'list', path: requested, ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) }, signal)
      signal.throwIfAborted()
      if (result.conflict) throw httpError(409, result.message || '目录已改变，请刷新后重试')
      sendJson(res, 200, { data: result })
    })],
    ['GET', /^\/files\/stat$/, async ({ url }, res) => withResponseSignal(res, async signal => {
      const requested = managerPath(url.searchParams.get('path'), { allowRoot: true })
      const result = await ctx.workbenchFileManager.operate({ operation: 'stat', path: requested }, signal)
      signal.throwIfAborted()
      if (result.kind === 'missing') throw httpError(404, '路径不存在')
      sendJson(res, 200, { data: result })
    })],
    ['POST', /^\/files$/, async ({ json }, res) => {
      const requested = managerPath(json.path)
      if (typeof json.data !== 'string') throw httpError(400, '缺少 data')
      const bytes = Buffer.from(json.data, 'base64')
      if (bytes.length > 20 * 1024 * 1024) throw httpError(413, '文件超过 20 MiB')
      const result = await ctx.workbenchFileManager.operate({ operation: 'upload', path: requested, version: json.version ?? null, data: json.data })
      sendJson(res, 200, { data: result })
    }],
    ['DELETE', /^\/files$/, async ({ owner, json }, res) => {
      const requested = managerPath(json.path)
      if (database.hasActiveRuns(owner.ownerId) || database.listChats(owner.ownerId)
        .some(chat => runtime.hasOwnedWork(chat.sessionId)))
        throw httpError(409, '工作台正在执行任务，请停止后再删除文件')
      const result = await ctx.workbenchFileManager.operate({ operation: 'delete', path: requested, version: json.version ?? null })
      sendJson(res, 200, { data: result })
    }],
    ['POST', /^\/files\/directories$/, async ({ json }, res) => {
      const result = await ctx.workbenchFileManager.operate({ operation: 'mkdir', path: managerPath(json.path) })
      sendJson(res, 200, { data: result })
    }],
    ['GET', /^\/files\/download$/, async ({ url }, res) => withResponseSignal(res, async signal => {
      const requested = managerPath(url.searchParams.get('path'))
      const result = await ctx.workbenchFileManager.operate({ operation: 'get', path: requested }, signal)
      signal.throwIfAborted()
      const bytes = Buffer.from(result.data, 'base64')
      res.writeHead(200, {
        'content-type': 'application/octet-stream', 'content-length': bytes.byteLength,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name || requested.split('/').at(-1) || 'download')}`,
        etag: `"${String(result.version)}"`, 'cache-control': 'no-store',
      })
      res.end(bytes)
    })],
    ['GET', /^\/files\/text$/, async ({ url }, res) => withResponseSignal(res, async signal => {
      const requested = managerPath(url.searchParams.get('path'))
      const result = await ctx.workbenchFileManager.operate({ operation: 'get', path: requested }, signal)
      signal.throwIfAborted()
      if (result.kind === 'directory') throw httpError(400, '文件不是 UTF-8 文本，请下载后编辑')
      const bytes = Buffer.from(result.data, 'base64')
      if (bytes.length > 2 * 1024 * 1024) throw httpError(400, '在线编辑支持 2 MiB 以内的 UTF-8 文本文件')
      let text
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { throw httpError(400, '文件不是 UTF-8 文本，请下载后编辑') }
      if (text.includes('\0')) throw httpError(400, '文件不是 UTF-8 文本，请下载后编辑')
      sendJson(res, 200, { data: { text, version: String(result.version) } })
    })],
    ['GET', /^\/runs\/([\w-]+)\/events$/, async ({ owner, req, url }, res, match) => {
      streamRunEvents({
        database, eventBus, ownerId: owner.ownerId, runId: match[1], req, res,
        cursor: req.headers['last-event-id'] || url.searchParams.get('cursor'),
      })
    }],
  ]

  const handler = async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === config.basePath + '/health') {
        const available = recovered && !database.streamFlushError
        const activity = available ? await nativeHostActivity(ctx, runtime.sidebarActivity, () => subagentSettings.activeWrites) : { protocol: 1, status: 'unknown' }
        // Sample the non-reconnecting native transport after the activity await.
        // A completed bootstrap does not make a subsequently closed SSH usable.
        const ssh = ctx.get('ssh')
        const transportFailed = ssh?.closed === true || Boolean(ssh?.failure) || ssh?.lifetime?.signal.aborted === true
        const ready = available && !transportFailed && runtime.mcpCatalogState?.ready === true
        sendJson(res, ready ? 200 : 503, { live: true, ready, recovery: recovered ? 'ready' : recoveryError ? 'failed' : 'recovering',
          recovery_dependency: recoveryError?.code === 'MCP_CATALOG_UNAVAILABLE' ? 'mcp_catalog' : undefined,
          resources: runtime.mcpCatalogState?.status ?? 'initializing',
          runtime_error: transportFailed ? 'SSH_UNAVAILABLE' : undefined,
          activity })
        return
      }
      await recovery
      if (recoveryError) throw Object.assign(httpError(503, '原生会话恢复尚未完成'), { code: 'RECOVERY_UNAVAILABLE' })
      const body = await readBody(req)
      const url = new URL(req.url ?? '/', 'http://workbench.local')
      const path = url.pathname.slice(config.basePath.length) || '/'
      const target = `${config.assertionAudiencePath}${path}${url.search}`
      const owner = verifier.verify(req.headers['x-gxzs-assertion'], {
        method: req.method, target, body,
        contentType: req.headers['content-type'] ?? '', lastEventId: req.headers['last-event-id'] ?? '',
      })
      if (owner.ownerId !== config.ownerId) throw httpError(403, '当前用户不属于此工作台宿主')
      const contentType = req.headers['content-type'] ?? ''
      const context = { owner, req, url, body, json: body.length && contentType.includes('application/json') ? parseJson(body) : {} }
      let methodNotAllowed = false
      for (const [method, pattern, route] of routes) {
        const match = pattern.exec(path)
        if (!match) continue
        if (method !== req.method) { methodNotAllowed = true; continue }
        await route(context, res, match)
        return
      }
      if (methodNotAllowed) throw httpError(405, '方法不允许')
      throw httpError(501, '该工作台能力尚未迁移')
    } catch (error) {
      if (res.destroyed || res.writableEnded) return
      if (!res.headersSent) sendError(res, error)
      else res.end()
    }
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: config.basePath, handler })
    return () => {
      clearTimeout(recoveryTimer)
      scheduler.close()
      sidebarLeases.dispose()
      browsers.dispose()
      disposeRoute?.()
      database.close()
    }
  }, 'gxzs workbench adapter')
}
