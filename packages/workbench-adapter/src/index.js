import { createHash, timingSafeEqual } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { AssertionVerifier } from './assertion.js'
import { RunEventBus } from './events.js'
import { HumanInputBridge } from './human-input.js'
import { httpError, parseJson, readBody, sendError, sendJson } from './http.js'
import { streamRunEvents } from './sse.js'
import { MigrationImporter } from './migration.js'
import { WorkbenchDatabase } from './persistence.js'
import { resolveWorkspacePath } from './paths.js'
import { createAssistantStreamProjector, projectInboxClaim, projectSessionEvent } from './projection.js'
import { WorkbenchRuntime } from './runtime.js'
import { WorkbenchService } from './service.js'

export const name = 'workbench-adapter'
export const inject = ['webServer', 'sessionController', 'fs', 'agents', 'commands', 'skills', 'workbenchFileManager', 'workbenchPlatformClient']

export const Config = z.object({
  basePath: z.string().default('/ai/workbench'),
  databasePath: z.string().required(),
  workspace: z.string().default('/workspace'),
  ownerId: z.string().required(),
  assertionIssuer: z.string().required(),
  assertionAudiencePath: z.string().default('/console/api/workbench'),
  assertionKeyEnv: z.string().default('GXZS_ASSERTION_SIGNING_KEY'),
  migrationTokenEnv: z.string().default('GXZS_MIGRATION_TOKEN'),
  humanInputTimeoutSeconds: z.number().default(60),
})

function safeToken(value, expected) {
  const actualHash = createHash('sha256').update(typeof value === 'string' ? value : '').digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualHash, expectedHash)
}

export function apply(ctx, config) {
  if (!config.ownerId || !config.assertionIssuer) throw new Error('workbench host owner and assertion issuer are required')
  const eventBus = new RunEventBus()
  const database = new WorkbenchDatabase(config.databasePath, { onEvent: (runId, event) => eventBus.publish(runId, event) })
  database.recoverInterrupted()
  new WorkbenchRuntime(ctx, database, config.ownerId)
  const service = new WorkbenchService({ database, sessionController: ctx.sessionController, agents: ctx.agents, commands: ctx.commands, skills: ctx.skills, fileManager: ctx.workbenchFileManager, platformClient: ctx.workbenchPlatformClient, workspace: config.workspace })
  const humanInput = new HumanInputBridge({ database, timeoutSeconds: config.humanInputTimeoutSeconds })
  const migration = new MigrationImporter({ database, sessions: ctx.sessionController, agents: ctx.agents, fileManager: ctx.workbenchFileManager, ownerId: config.ownerId, workspace: config.workspace })
  const verifier = new AssertionVerifier({
    issuer: config.assertionIssuer,
    signingKey: process.env[config.assertionKeyEnv],
  })

  const projectAssistantStream = createAssistantStreamProjector(database, config.ownerId)
  ctx.on('user-questions/request', humanInput.handleRequest, { global: true, prepend: true })
  ctx.on('agent/assistant-stream', projectAssistantStream, { global: true })
  ctx.on('agent/inbox/claimed', (payload) => projectInboxClaim(database, payload, config.ownerId), { global: true })

  ctx.on('session/event', (session, event) => {
    projectSessionEvent(database, session?.id ?? session?.header?.id, event, config.ownerId)
  }, { global: true })

  const buildCatalog = async (owner) => {
    const catalog = await ctx.sessionController.modelCatalog()
    const models = (catalog.groups ?? []).flatMap((group) => (group.models ?? []).map((model) => ({
      id: `${group.id}/${model.id}`, name: model.name || model.id, provider: group.id, description: model.description,
    })))
    const mcpTools = await service.mcpCatalog(owner)
    return {
      activity_protocol: 1, human_input_protocol: 1, followup_protocol: 1,
      control_protocol: 1, resources_protocol: 0, command_resources_protocol: 0,
      default_selection: { model: catalog.default ? `${catalog.default.provider}/${catalog.default.model}` : models[0]?.id ?? '', tools: [], skills: [], knowledge: [], model_parameters: {}, tool_parameters: {} },
      models, tools: mcpTools.map((tool) => ({
        id: tool.id, name: tool.name, description: tool.description, scope: tool.scope,
        provider: tool.provider, provider_name: tool.provider_name, tool_name: tool.tool_name, runtime_name: tool.runtime_name,
      })), skills: [], knowledge: [],
    }
  }

  let workspaceTarget
  const confinedTarget = async (requested) => {
    const absolute = resolveWorkspacePath(config.workspace, requested)
    workspaceTarget ??= await ctx.fs.resolve(config.workspace, { cwd: config.workspace })
    const target = await ctx.fs.resolve(absolute, { cwd: config.workspace })
    if (!ctx.fs.contains(workspaceTarget, target)) throw httpError(403, '文件路径超出工作区')
    return { absolute, target }
  }

  const managerPath = (value) => {
    const requested = String(value ?? '')
    if (!requested) throw httpError(400, '缺少 path')
    const absolute = resolveWorkspacePath(config.workspace, requested)
    const prefix = `${config.workspace.replace(/\/+$/, '')}/`
    if (absolute === config.workspace || !absolute.startsWith(prefix)) throw httpError(403, '工作区根目录不可修改')
    return absolute.slice(prefix.length)
  }

  const proxyPlatform = async (context, res, route) => {
    const result = await ctx.workbenchPlatformClient.request({
      owner: context.owner, method: context.req.method, route, query: context.url.search,
      body: context.body, contentType: context.req.headers['content-type'] ?? '',
    })
    const headers = { 'cache-control': 'private, no-store' }
    for (const name of ['content-type', 'content-disposition', 'etag']) {
      const value = result.headers.get(name)
      if (value) headers[name] = value
    }
    res.writeHead(result.status, headers)
    res.end(Buffer.from(result.bytes))
  }

  const fileDto = (requestedPath, info) => ({
    name: requestedPath.split('/').filter(Boolean).at(-1) || '/', path: requestedPath,
    kind: info.type === 'directory' ? 'directory' : 'file', size: info.size ?? 0,
    version: info.version == null ? null : String(info.version), downloadable: info.type !== 'directory',
  })

  const routes = [
    ['POST', /^\/migration\/import$/, async ({ req, json }, res) => {
      const expected = process.env[config.migrationTokenEnv]
      if (!expected || !safeToken(req.headers['x-gxzs-migration-token'], expected)) throw httpError(401, '迁移授权无效')
      sendJson(res, 200, { data: await migration.import(json) })
    }],
    ['GET', /^\/identity$/, async ({ owner }, res) => sendJson(res, 200, {
      user: { id: owner.userId, name: owner.name, email: '' }, workspaceId: owner.tenantId,
      workspaces: [{ id: owner.tenantId, name: owner.tenantId, current: true }],
    })],
    ['GET', /^\/catalog$/, async ({ owner }, res) => sendJson(res, 200, { data: await buildCatalog(owner) })],
    ['GET', /^\/models\/parameters$/, async ({ url }, res) => sendJson(res, 200, { data: await service.modelParameters(url.searchParams.get('model')) })],
    ['GET', /^\/resources$/, async (_context, res) => sendJson(res, 200, { data: await service.resources() })],
    ['POST', /^\/resources$/, async ({ json }, res) => {
      const result = await service.mutateResource(json)
      if (json.operation !== 'skill_inspect' && json.operation !== 'mcp_read') ctx.emit('workbench/resources-changed')
      sendJson(res, 200, { data: result })
    }],
    ['GET', /^\/chats$/, async ({ owner }, res) => sendJson(res, 200, { data: service.listChats(owner) })],
    ['POST', /^\/chats$/, async ({ owner }, res) => {
      const catalog = await ctx.sessionController.modelCatalog()
      const defaultModel = catalog.default ? `${catalog.default.provider}/${catalog.default.model}` : ''
      const chat = await service.createChat(owner, config.workspace, {
        model: defaultModel, tools: [], skills: [], knowledge: [], model_parameters: {}, tool_parameters: {},
      })
      sendJson(res, 201, { data: service.getChat(owner, chat.id) })
    }],
    ['GET', /^\/chats\/([\w-]+)$/, async ({ owner }, res, match) => sendJson(res, 200, { data: service.getChat(owner, match[1]) })],
    ['PATCH', /^\/chats\/([\w-]+)$/, async ({ owner, json }, res, match) => sendJson(res, 200, { data: await service.updateChat(owner, match[1], json) })],
    ['DELETE', /^\/chats\/([\w-]+)$/, async ({ owner }, res, match) => {
      await service.deleteChat(owner, match[1])
      res.writeHead(204)
      res.end()
    }],
    ['PUT', /^\/chats\/([\w-]+)\/config$/, async ({ owner, json }, res, match) => sendJson(res, 200, { data: await service.updateConfig(owner, match[1], json) })],
    ['GET', /^\/chats\/([\w-]+)\/control$/, async ({ owner }, res, match) => sendJson(res, 200, { data: service.getControl(owner, match[1]) })],
    ['POST', /^\/chats\/([\w-]+)\/todos\/clear$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.clearTodos(owner, match[1], json) })],
    ['POST', /^\/chats\/([\w-]+)\/commands$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: await service.issueCommand(owner, match[1], json) })],
    ['GET', /^\/chats\/([\w-]+)\/followups$/, async ({ owner, url }, res, match) => {
      const tracked = (url.searchParams.get('tracked') ?? '').split(',').filter(Boolean)
      sendJson(res, 200, { data: service.followups(owner, match[1], tracked) })
    }],
    ['POST', /^\/chats\/([\w-]+)\/runs$/, async ({ owner, json }, res, match) =>
      sendJson(res, 202, { data: await service.submitRun(owner, match[1], json) })],
    ['GET', /^\/runs\/([\w-]+)$/, async ({ owner }, res, match) => sendJson(res, 200, { data: service.getRun(owner, match[1]) })],
    ['POST', /^\/runs\/([\w-]+)\/regenerate$/, async ({ owner, json }, res, match) =>
      sendJson(res, 202, { data: await service.regenerate(owner, match[1], json) })],
    ['POST', /^\/runs\/([\w-]+)\/feedbacks$/, async ({ owner, json }, res, match) =>
      sendJson(res, 200, { data: service.feedback(owner, match[1], json.rating ?? null) })],
    ['POST', /^\/runs\/([\w-]+)\/stop$/, async ({ owner }, res, match) =>
      sendJson(res, 200, { data: await service.stopRun(owner, match[1]) })],
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
      humanInput.skip(owner.ownerId, match[1], json.request_id)
      sendJson(res, 200, { data: service.getRun(owner, match[1]) })
    }],
    ['POST', /^\/runs\/([\w-]+)\/input-interaction$/, async ({ owner, json }, res, match) => {
      humanInput.touch(owner.ownerId, match[1], json.request_id)
      sendJson(res, 200, { data: service.getRun(owner, match[1]) })
    }],
    ['GET', /^\/files\/preview$/, async (context, res) => proxyPlatform(context, res, 'files/preview')],
    ['POST', /^\/files\/preview$/, async (context, res) => proxyPlatform(context, res, 'files/preview')],
    ['GET', /^\/files\/shares$/, async (context, res) => proxyPlatform(context, res, 'files/shares')],
    ['POST', /^\/files\/shares$/, async (context, res) => proxyPlatform(context, res, 'files/shares')],
    ['DELETE', /^\/files\/shares$/, async (context, res) => proxyPlatform(context, res, 'files/shares')],
    ['POST', /^\/chats\/draft\/audio$/, async (context, res) => proxyPlatform(context, res, 'audio')],
    ['POST', /^\/chats\/([\w-]+)\/audio$/, async (context, res, match) => {
      service.requireChat(context.owner, match[1])
      await proxyPlatform(context, res, 'audio')
    }],
    ['GET', /^\/files$/, async ({ url }, res) => {
      const requested = url.searchParams.get('path') || config.workspace
      const { target } = await confinedTarget(requested)
      const info = await ctx.fs.stat(target)
      if (!info) throw httpError(404, '路径不存在')
      if (info.type !== 'directory') return sendJson(res, 200, { data: { entries: [fileDto(requested, info)] } })
      const entries = await ctx.fs.listDir(target)
      sendJson(res, 200, { data: { entries: entries.map((entry) => fileDto(`${requested.replace(/\/+$/, '')}/${entry.name}`, entry)) } })
    }],
    ['GET', /^\/files\/stat$/, async ({ url }, res) => {
      const requested = url.searchParams.get('path') || ''
      if (!requested) throw httpError(400, '缺少 path 参数')
      const { target } = await confinedTarget(requested)
      const info = await ctx.fs.stat(target)
      if (!info) throw httpError(404, '路径不存在')
      sendJson(res, 200, { data: fileDto(requested, info) })
    }],
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
      if (database.hasActiveRuns(owner.ownerId)) throw httpError(409, '工作台正在执行任务，请停止后再删除文件')
      const result = await ctx.workbenchFileManager.operate({ operation: 'delete', path: requested, version: json.version ?? null })
      sendJson(res, 200, { data: result })
    }],
    ['POST', /^\/files\/directories$/, async ({ json }, res) => {
      const result = await ctx.workbenchFileManager.operate({ operation: 'mkdir', path: managerPath(json.path) })
      sendJson(res, 200, { data: result })
    }],
    ['GET', /^\/files\/download$/, async ({ url }, res) => {
      const requested = url.searchParams.get('path') || ''
      const { target } = await confinedTarget(requested)
      const info = await ctx.fs.stat(target)
      if (!info || info.type !== 'file') throw httpError(404, '文件不存在')
      const bytes = await ctx.fs.readBytes(target, undefined, 128 * 1024 * 1024)
      res.writeHead(200, {
        'content-type': 'application/octet-stream', 'content-length': bytes.byteLength,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(requested.split('/').at(-1) || 'download')}`,
        etag: `"${String(info.version)}"`, 'cache-control': 'no-store',
      })
      res.end(Buffer.from(bytes))
    }],
    ['GET', /^\/files\/text$/, async ({ url }, res) => {
      const requested = url.searchParams.get('path') || ''
      const { target } = await confinedTarget(requested)
      const info = await ctx.fs.stat(target)
      if (!info || info.type !== 'file') throw httpError(404, '文件不存在')
      if ((info.size ?? 0) > 2 * 1024 * 1024) throw httpError(400, '在线编辑支持 2 MiB 以内的 UTF-8 文本文件')
      const text = await ctx.fs.readText(target)
      if (text.includes('\0')) throw httpError(400, '文件不是 UTF-8 文本，请下载后编辑')
      sendJson(res, 200, { data: { text, version: String(info.version) } })
    }],
    ['GET', /^\/runs\/([\w-]+)\/events$/, async ({ owner, req, url }, res, match) => {
      streamRunEvents({
        database, eventBus, ownerId: owner.ownerId, runId: match[1], req, res,
        cursor: req.headers['last-event-id'] || url.searchParams.get('cursor'),
      })
    }],
  ]

  const handler = async (req, res) => {
    try {
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
      if (!res.headersSent) sendError(res, error)
      else res.end()
    }
  }

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: config.basePath, handler })
    return () => {
      disposeRoute?.()
      database.close()
    }
  }, 'gxzs workbench adapter')
}
