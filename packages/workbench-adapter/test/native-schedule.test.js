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
  { default: Tools }, { default: Storage }, Json, { DomainFacility }, { default: Schedule }] = await Promise.all([
  native('cordis'), native('dsh-session'), native('dsh-agent'), native('dsh-system-prompt'), native('dsh-tools'),
  native('dsh-storage'), native('dsh-storage-json'), native('dsh-storage-domain'), native('dsh-schedule'),
])
const [{ createScope }, ToolSchedule] = await Promise.all([native('dsh-scope'), native('dsh-tool-schedule')])
it('uses the published native JSON domain, delivers once and preserves rule/history across restart', async () => {
  const root = await mkdtemp(join(process.cwd(), '.native-schedule-'))
  const db = new WorkbenchDatabase(':memory:')
  const owner = { ownerId: 'owner' }
  const chat = db.createChat({ ownerId: owner.ownerId, sessionId: 'schedule-owner', selection: {} })
  const contexts = []
  const delivered = vi.fn()
  async function start() {
    const ctx = new Context(); contexts.push(ctx)
    for (const plugin of [Sessions, Agents, SystemPrompt, Tools, Storage]) await ctx.plugin(plugin)
    await ctx.plugin(Json, { root })
    const facility = new DomainFacility(ctx, { backend: 'json' })
    ctx.provide('storageDomain', facility)
    ctx.effect(() => async () => facility.closeAll())
    const session = ctx.sessions.create(chat.sessionId)
    const agent = { id: session.id, session, ctx, options: {}, followup: delivered, status: 'idle' }
    const resolveAgent = vi.fn(async () => ({ agent }))
    ctx.provide('sessionController', { resolveAgent })
    ctx.provide('sessionPersistence', {})
    ctx.on('session/flush', () => {})
    await ctx.plugin(Schedule)
    const scope = createScope(ctx, agent)
    await scope.ctx.plugin(ToolSchedule)
    const service = { requireChat: (who, id) => db.getChat(who.ownerId, id) }
    return { ctx, agent, resolveAgent, gateway: new WorkbenchSchedules({ native: ctx.schedule, database: db, service }) }
  }
  try {
    const first = await start()
    for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) expect(first.ctx.tools.get(name, first.agent)).toBeDefined()
    const tool = first.ctx.tools.get('schedule_create', first.agent)
    const modelCreated = await tool.execute({ title: '对话创建', prompt: '由模型工具创建的提醒', after_seconds: 3600 }, {
      agent: first.agent, signal: new AbortController().signal,
    })
    expect(modelCreated).toMatchObject({ title: '对话创建', prompt: '由模型工具创建的提醒', kind: 'after' })
    expect((await first.gateway.catalog(owner)).some(task => task.id === modelCreated.id)).toBe(true)
    await first.gateway.delete(owner, modelCreated.id)
    const createDaily = { request_key: 'daily-creation', title: '每天提醒', prompt: '中文内容', daily: { time: '08:00:00', time_zone: 'Asia/Shanghai' } }
    const daily = await first.gateway.create(owner, chat.id, createDaily)
    expect(await first.gateway.create(owner, chat.id, createDaily)).toEqual(daily)
    const once = await first.gateway.create(owner, chat.id, { title: '立即验证', prompt: '只投递一次', after_seconds: 1 })
    const forkSession = first.ctx.sessions.fork(first.agent.session)
    const fork = db.createChat({ ownerId: owner.ownerId, sessionId: forkSession.id, selection: {} })
    expect(await first.ctx.schedule.list({ sessionId: fork.sessionId })).toEqual([])
    expect((await first.ctx.schedule.list({ sessionId: chat.sessionId })).map(task => task.id)).toEqual([daily.id, once.id])
    expect(await first.gateway.task(owner, daily.id)).toMatchObject({ sessionId: chat.sessionId, chat_id: chat.id })
    // A schedule created after the fork belongs only to the fork. Stopping it must not stop the source reminders.
    const own = await first.gateway.create(owner, fork.id, { title: '分叉的新提醒', prompt: '仅新对话', after_seconds: 3600 })
    expect(await first.gateway.task(owner, own.id)).toMatchObject({ sessionId: fork.sessionId, chat_id: fork.id })
    await first.ctx.parallel('workspace/session-stop', { sessionId: fork.sessionId })
    expect(await first.ctx.schedule.list({ sessionId: fork.sessionId })).toEqual([])
    expect(await first.gateway.task(owner, daily.id)).toMatchObject({ sessionId: chat.sessionId, chat_id: chat.id })
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce(), { timeout: 3500 })
    expect(first.resolveAgent).toHaveBeenCalledExactlyOnceWith(chat.sessionId)
    expect(delivered.mock.calls[0][0].source.kind).toBe('schedule')
    // Delivery acceptance precedes the asynchronous durable receipt commit.
    await vi.waitFor(async () => expect((await first.gateway.history(owner, once.id)).records).toHaveLength(1), { timeout: 3500 })
    const receipt = await first.gateway.history(owner, once.id)
    expect(receipt.records).toHaveLength(1)
    expect(receipt.records[0].prompt).toBe('只投递一次')
    await first.ctx.fiber.dispose()
    const restarted = await start()
    expect(await restarted.gateway.create(owner, chat.id, createDaily)).toEqual(daily)
    expect((await restarted.gateway.catalog(owner)).map(task => [task.id, task.status])).toEqual(expect.arrayContaining([[daily.id, 'active'], [once.id, 'inactive']]))
    expect(await restarted.gateway.history(owner, once.id)).toEqual(receipt)
    expect(delivered).toHaveBeenCalledOnce()
    const changed = await restarted.gateway.update(owner, daily.id, { expected: daily, title: '更新后的名称' })
    expect(changed.updated).toBe(true)
    const stale = await restarted.gateway.update(owner, daily.id, { expected: daily, title: '过期写入' })
    expect(stale.code).toBe('schedule_conflict')
    // A failed atomic publish can leave its private body in a UUID stage.
    const stage = join(root, '.00000000-0000-4000-8000-000000000001.tmp')
    const partial = join(root, '.00000000-0000-4000-8000-000000000002.tmp')
    const other = join(root, '.00000000-0000-4000-8000-000000000003.tmp')
    await writeFile(stage, await readFile(join(root, 'schedule.json')))
    await writeFile(partial, '{"unit":{"name":"schedule","version":1},"tables":{"tasks":{"partial":"private')
    await writeFile(other, '{"unit":{"name":"workspace","version":1},"global":"unrelated"}')
    await restarted.gateway.delete(owner, once.id)
    expect(await restarted.gateway.catalog(owner)).toHaveLength(1)
    await restarted.ctx.parallel('workspace/session-stop', { sessionId: chat.sessionId })
    expect(await restarted.gateway.catalog(owner)).toEqual([])
    await restarted.ctx.schedule.deleteSessionPermanently(chat.sessionId)
    expect(await readdir(root)).not.toContain(stage.split(/[\\/]/).at(-1))
    await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(other, 'utf8')).toContain('unrelated')
    expect(await readFile(join(root, 'schedule.json'), 'utf8')).not.toContain('中文内容')
    await restarted.ctx.schedule.deleteSessionPermanently(chat.sessionId)
    await restarted.ctx.parallel('workspace/session-stop', { sessionId: chat.sessionId })
    expect(delivered).toHaveBeenCalledOnce()
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    db.close(); await rm(root, { recursive: true, force: true })
  }
}, 10000)
