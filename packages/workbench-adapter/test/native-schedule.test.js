import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchSchedules } from '../src/schedules.js'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = async name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { default: Sessions }, { default: Agents }, { default: SystemPrompt },
  { default: Tools }, { default: Storage }, Json, { DomainFacility }, { default: Schedule }, { RemoteError }, { default: Projections }] = await Promise.all([
  native('cordis'), native('dsh-session'), native('dsh-agent'), native('dsh-system-prompt'), native('dsh-tools'),
  native('dsh-storage'), native('dsh-storage-json'), native('dsh-storage-domain'), native('dsh-schedule'), native('dsh-typert-protocol'), native('dsh-session-projection'),
])
const [{ createScope }, ToolSchedule] = await Promise.all([native('dsh-scope'), native('dsh-tool-schedule')])

it('uses native host targets, RRULE tools, execution, revisions and durable history across restart', async () => {
  const root = await mkdtemp(join(process.cwd(), '.native-schedule-'))
  const db = new WorkbenchDatabase(':memory:'), owner = { ownerId: 'owner' }, contexts = [], delivered = []
  const chat = db.createChat({ ownerId: owner.ownerId, sessionId: 'schedule-owner', selection: {} })
  async function start() {
    const ctx = new Context(); contexts.push(ctx)
    for (const plugin of [Sessions, Projections, Agents, SystemPrompt, Tools, Storage]) await ctx.plugin(plugin)
    await ctx.plugin(Json, { root })
    const facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.provide('storageDomain', facility)
    ctx.effect(() => async () => facility.closeAll())
    const agents = new Map()
    const create = ({ sessionId, cwd = '/workspace/conversations/source' }) => {
      const session = ctx.sessions.create(sessionId, { meta: { cwd } })
      const agent = { id: session.id, session, ctx, options: {}, status: 'idle',
        inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {},
        followup(message) { delivered.push({ sessionId, message }) } }
      agents.set(sessionId, agent)
      return { sessionId }
    }
    create({ sessionId: chat.sessionId })
    const resolveAgent = vi.fn(async id => {
      if (!agents.has(id)) throw new RemoteError('session/not-found', 'missing')
      return { agent: agents.get(id) }
    })
    ctx.provide('sessionController', { resolveAgent, create: vi.fn(create) })
    ctx.provide('sessionPersistence', { stat: async id => agents.has(id) ? { header: agents.get(id).session.header } : undefined })
    ctx.on('session/flush', () => {})
    const joined = []
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], resolveByPath: async cwd => cwd === '/workspace/conversations/project'
      ? { attachSession: async id => joined.push(id) } : undefined })
    await ctx.plugin(Schedule)
    const agent = agents.get(chat.sessionId), scope = createScope(ctx, agent)
    await scope.ctx.plugin(ToolSchedule)
    const service = { workspace: '/workspace', fileManager: { operate: vi.fn(async () => ({})) },
      workspaces: { root: '/workspace/conversations',
        requireWorkspace: async () => ({ workspaceId: 'project', path: 'project' }), resolveDirectory: async value => value },
      requireChat: (who, id) => db.getChat(who.ownerId, id) }
    const gateway = new WorkbenchSchedules({ native: ctx.schedule, database: db, service, ownerId: owner.ownerId })
    ctx.on('schedule/resolve-agent', (id, next) => gateway.activate(owner, id, next))
    return { ctx, agent, gateway, joined }
  }
  try {
    // Open actual v1 bytes through the installed native storage decoder. A read
    // must not rewrite old data; the first edit upgrades only the native shape.
    const { createAtScheduleRecord } = await native('dsh-schedule')
    const legacyRecord = createAtScheduleRecord('legacy-task', '保留旧内容', '2099-11-10T00:00:00Z', Date.now(), '原有任务')
    const legacyBytes = JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null,
      tables: { tasks: {
        'legacy-task': { record: legacyRecord, sessionId: chat.sessionId },
        'legacy-ended': { record: { ...legacyRecord, id: 'legacy-ended' }, sessionId: chat.sessionId, status: 'inactive' },
      } } })
    await writeFile(join(root, 'schedule.json'), legacyBytes)
    const first = await start()
    expect(await first.gateway.task(owner, 'legacy-task')).toMatchObject({ ...legacyRecord,
      target: { kind: 'session', sessionId: chat.sessionId }, chat_id: chat.id, status: 'active' })
    expect(await first.gateway.task(owner, 'legacy-ended')).toMatchObject({ status: 'ended' })
    expect(await readFile(join(root, 'schedule.json'), 'utf8')).toBe(legacyBytes)
    await first.gateway.update(owner, 'legacy-task', { expectedUpdatedAt: null, patch: { title: '旧任务更新' } })
    const upgraded = JSON.parse(await readFile(join(root, 'schedule.json'), 'utf8'))
    expect(upgraded.unit).toEqual({ name: 'schedule', version: 2 })
    expect(upgraded.tables.tasks['legacy-task']).not.toHaveProperty('sessionId')
    for (const name of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'])
      await vi.waitFor(() => expect(first.ctx.tools.get(name, first.agent), name).toBeDefined())
    expect(first.ctx.tools.get('schedule_update', first.agent)).toBeUndefined()
    const rrule = 'DTSTART;TZID=Asia/Shanghai:20991110T080000\nRRULE:FREQ=DAILY'
    const modelCreated = await first.ctx.tools.get('schedule_create', first.agent).execute({
      title: '模型任务', prompt: '原生 RRULE', rrule, target: 'this_session',
    }, { agent: first.agent, signal: new AbortController().signal })
    expect(modelCreated).toMatchObject({ kind: 'rrule', target: { kind: 'session', sessionId: chat.sessionId } })
    await first.gateway.delete(owner, modelCreated.id)
    const dailyRequest = { request_key: 'daily', title: '每天提醒', prompt: '中文内容',
      timing: { kind: 'daily', daily: { time: '08:00:00', time_zone: 'Asia/Shanghai' } }, target: { kind: 'session', chat_id: chat.id } }
    const daily = await first.gateway.create(owner, undefined, dailyRequest)
    expect(await first.gateway.create(owner, undefined, dailyRequest)).toEqual(daily)
    await expect(first.gateway.catalog({ ownerId: 'foreign' })).rejects.toMatchObject({ status: 403 })
    const once = await first.gateway.create(owner, undefined, { title: '默认工作区', prompt: '首轮新建，后续复用',
      timing: { kind: 'after', after_seconds: 3600 } })
    expect(once.target.kind).toBe('new_once')
    expect(once.target.create.cwd).toMatch(/^\/workspace\/conversations\/scheduled\//)
    expect(db.getChatBySession(once.target.sessionId)).toBeUndefined()
    await first.gateway.run(owner, once.id)
    const bound = await first.gateway.task(owner, once.id)
    expect(bound.target).toEqual({ kind: 'session', sessionId: once.target.sessionId })
    expect(bound.chat_id).toBeTruthy()
    expect(first.joined).toEqual([])
    const repeated = await first.gateway.create(owner, undefined, { title: '项目检查', prompt: '每次新会话', workspace_id: 'project',
      timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'new' } })
    await first.gateway.run(owner, repeated.id)
    expect(await first.gateway.run(owner, repeated.id)).toMatchObject({ code: 'schedule_execution_pending' })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + first.ctx.schedule.deliveryLimits().newSessionIntervalSeconds * 1000 + 1)
    await first.gateway.run(owner, repeated.id)
    const history = await first.gateway.history(owner, repeated.id)
    expect(history.records).toHaveLength(2)
    expect(new Set(history.records.map(item => item.targetSessionId)).size).toBe(2)
    for (const row of history.records) expect(db.getChatBySession(row.targetSessionId)).toBeTruthy()
    expect(first.joined).toHaveLength(2)
    const changed = await first.gateway.update(owner, daily.id, { expectedUpdatedAt: daily.updatedAt ?? null,
      patch: { title: '更新名称', active: false } })
    expect(changed).toMatchObject({ title: '更新名称', status: 'paused' })
    expect(await first.gateway.update(owner, daily.id, { expectedUpdatedAt: daily.updatedAt ?? null,
      patch: { title: '过期更新' } })).toMatchObject({ code: 'schedule_conflict' })
    await first.ctx.fiber.dispose()
    const restarted = await start()
    expect(await restarted.gateway.task(owner, 'legacy-task')).toMatchObject({ title: '旧任务更新', prompt: '保留旧内容',
      target: { kind: 'session', sessionId: chat.sessionId }, chat_id: chat.id })
    expect(await restarted.gateway.create(owner, undefined, dailyRequest)).toEqual(daily)
    expect(await restarted.gateway.history(owner, repeated.id)).toEqual(history)
    expect(await restarted.gateway.task(owner, daily.id)).toMatchObject({ status: 'paused' })
    const stage = join(root, '.00000000-0000-4000-8000-000000000001.tmp')
    const other = join(root, '.00000000-0000-4000-8000-000000000002.tmp')
    await writeFile(stage, await readFile(join(root, 'schedule.json')))
    await writeFile(other, '{"unit":{"name":"workspace","version":1},"global":"unrelated"}')
    for (const task of await restarted.gateway.catalog(owner)) await restarted.gateway.delete(owner, task.id)
    await restarted.ctx.storageDomain.get('schedule').purgeOrphanStages()
    expect(await readdir(root)).not.toContain(stage.split(/[\\/]/).at(-1))
    expect(await readFile(other, 'utf8')).toContain('unrelated')
    expect(await readFile(join(root, 'schedule.json'), 'utf8')).not.toContain('中文内容')
    expect(delivered).toHaveLength(3)
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    db.close(); await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
}, 10000)
