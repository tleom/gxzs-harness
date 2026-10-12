import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
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
    ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) })
    ctx.provide('sessionPersistence', {})
    ctx.on('session/flush', () => {})
    await ctx.plugin(Schedule)
    const scope = createScope(ctx, agent)
    await scope.ctx.plugin(ToolSchedule)
    const service = { requireChat: () => chat }
    return { ctx, agent, gateway: new WorkbenchSchedules({ native: ctx.schedule, database: db, service }) }
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
    const daily = await first.gateway.create(owner, chat.id, { title: '每天提醒', prompt: '中文内容', daily: { time: '08:00:00', time_zone: 'Asia/Shanghai' } })
    const once = await first.gateway.create(owner, chat.id, { title: '立即验证', prompt: '只投递一次', after_seconds: 1 })
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce(), { timeout: 3500 })
    expect(delivered.mock.calls[0][0].source.kind).toBe('schedule')
    // Delivery acceptance precedes the asynchronous durable receipt commit.
    await vi.waitFor(async () => expect((await first.gateway.history(owner, once.id)).records).toHaveLength(1), { timeout: 3500 })
    const receipt = await first.gateway.history(owner, once.id)
    expect(receipt.records).toHaveLength(1)
    expect(receipt.records[0].prompt).toBe('只投递一次')
    await first.ctx.fiber.dispose()
    const restarted = await start()
    expect((await restarted.gateway.catalog(owner)).map(task => [task.id, task.status])).toEqual(expect.arrayContaining([[daily.id, 'active'], [once.id, 'inactive']]))
    expect(await restarted.gateway.history(owner, once.id)).toEqual(receipt)
    expect(delivered).toHaveBeenCalledOnce()
    const changed = await restarted.gateway.update(owner, daily.id, { expected: daily, title: '更新后的名称' })
    expect(changed.updated).toBe(true)
    const stale = await restarted.gateway.update(owner, daily.id, { expected: daily, title: '过期写入' })
    expect(stale.code).toBe('schedule_conflict')
    await restarted.gateway.delete(owner, once.id)
    expect(await restarted.gateway.catalog(owner)).toHaveLength(1)
    await restarted.ctx.parallel('workspace/session-stop', { sessionId: chat.sessionId })
    expect(await restarted.gateway.catalog(owner)).toEqual([])
    await restarted.ctx.parallel('workspace/session-stop', { sessionId: chat.sessionId })
    expect(delivered).toHaveBeenCalledOnce()
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    db.close(); await rm(root, { recursive: true, force: true })
  }
}, 10000)
