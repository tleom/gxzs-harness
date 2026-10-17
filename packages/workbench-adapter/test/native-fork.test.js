import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkbenchJobs } from '../src/jobs.js'

const requireNative = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(requireNative.resolve(`@deepseek-ai/${name}`)).href)
const internal = (name, file) => import(pathToFileURL(join(dirname(requireNative.resolve(`@deepseek-ai/${name}`)), 'types', file)).href)

it.each([false, true].flatMap(grouped => [false, true].map(hasChildren => ({ grouped, hasChildren }))))(
  'uses published DSH fork boundaries, workspace and child ownership ($grouped/$hasChildren)', async ({ grouped, hasChildren }) => {
    const [{ Context }, { default: Sessions }, { default: Projections }, { default: Query },
      { createUserMessage }, { SessionCommandController }, { subagentCatalogProjectionDefinition }] = await Promise.all([
      native('cordis'), native('dsh-session'), native('dsh-session-projection'), native('dsh-session-query'), native('dsh-llm'),
      internal('dsh-api-session-controller', 'commands.js'), internal('dsh-subagent', 'catalog.js'),
    ])
    const ctx = new Context()
    try {
      for (const plugin of [Sessions, Projections, Query]) await ctx.plugin(plugin)
      ctx.sessionProjections.register(subagentCatalogProjectionDefinition)
      const cwd = grouped ? '/workspace/案件材料' : '/workspace/conversations/2026-10-18/original'
      const source = ctx.sessions.create(undefined, { meta: { cwd } })
      source.append('turn/start', { turn: 1 })
      source.append('user/message', createUserMessage({ content: [{ type: 'text', text: '保留的问题' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      if (hasChildren) source.append('subagent/catalog', { version: 0, childId: 'original-child', childCreatedAt: 1, mode: 'continuable', label: '原子智能体' })
      const boundary = source.append('turn/end', { turn: 1, reason: { kind: 'completed' } }).seq
      source.append('turn/start', { turn: 2 })
      source.append('user/message', createUserMessage({ content: [{ type: 'text', text: '切点之后的问题' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const members = [source.id]
      const workspace = { id: 'cases', sessionIds: members, attachSession: vi.fn(async id => { members.push(id) }) }
      ctx.provide('workspaceRegistry', { list: () => grouped ? [workspace] : [] })
      ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) })
      // Exercise the published command and real Session/projection stores without a model request.
      ctx.provide('agents', { create: async options => ({ session: ctx.sessions.create(options.sessionId, options) }) })
      const controller = new SessionCommandController(ctx, {
        presetForObservation: () => undefined, composeAgent: async () => ({ setup() {} }),
      }, '/workspace')
      const fork = async session => {
        const result = await controller.fork({ sessionId: session.id, atSeq: boundary })
        return ctx.sessions.get(result.sessionId)
      }
      const child = await fork(source)
      expect(child.header).toMatchObject({ cwd, parentSession: source.id, isSeeded: true })
      expect(child.header.origin).not.toBe('subagent')
      expect(child.snapshotEvents().slice(0, boundary + 1)).toEqual(source.snapshotEvents().slice(0, boundary + 1))
      expect(JSON.stringify(child.snapshotEvents())).not.toContain('切点之后的问题')
      const catalog = session => ctx.sessionProjections.snapshot(session).values.subagentCatalog
      expect(catalog(source)).toHaveLength(hasChildren ? 1 : 0)
      expect(catalog(child)).toEqual([])
      child.append('subagent/catalog', { version: 0, childId: 'new-child', childCreatedAt: 2, mode: 'continuable', label: '分叉后的子智能体' })
      expect(catalog(child)).toEqual([expect.objectContaining({ id: 'new-child' })])
      const grandchild = await fork(child)
      expect(grandchild.header.cwd).toBe(cwd)
      expect(catalog(grandchild)).toEqual([])
      expect(catalog(source)).toHaveLength(hasChildren ? 1 : 0)
      expect(workspace.attachSession).toHaveBeenCalledTimes(grouped ? 2 : 0)
      if (grouped) expect(members).toEqual([source.id, child.id, grandchild.id])
    } finally { await ctx.fiber.dispose() }
  },
)

it('keeps running native background jobs with their source session after a fork', async () => {
  const [{ Context }, { default: Sessions }, { default: Jobs }] = await Promise.all([
    native('cordis'), native('dsh-session'), native('dsh-jobs-local'),
  ])
  const ctx = new Context()
  const finishes = []
  try {
    await ctx.plugin(Sessions)
    const agents = new Map()
    ctx.provide('agents', { get: id => agents.get(id) })
    await ctx.plugin(Jobs)
    ctx.jobs.attachController('fork-test')
    const source = ctx.sessions.create()
    const start = session => {
      agents.set(session.id, { id: session.id, session, ctx: ctx.plugin(() => {}).ctx })
      let finish
      const done = new Promise(resolve => { finish = resolve })
      finishes.push(finish)
      return ctx.jobs.start({ owner: session.id, kind: 'bash', label: '后台任务', run(handle) {
        handle.append(`output:${session.id}`)
        return { done, cancel() { finish({ status: 'killed' }) } }
      } })
    }
    const originalJob = start(source)
    const fork = ctx.sessions.fork(source)
    // Durable historical job events remain, but do not register another live job.
    expect(fork.snapshotEvents().some(event => event.type === 'job/registered')).toBe(true)
    expect(ctx.jobs.list(fork.id)).toEqual([])
    expect(ctx.jobs.list(source.id).map(job => job.id)).toEqual([originalJob])
    expect(() => ctx.jobs.readAt(originalJob, 0, fork.id)).toThrow()
    expect(() => ctx.jobs.kill(originalJob, fork.id)).toThrow()
    expect(ctx.jobs.get(originalJob, source.id).status).toBe('running')
    const forkJob = start(fork)
    expect(ctx.jobs.list(fork.id).map(job => job.id)).toEqual([forkJob])
    expect(ctx.jobs.list(source.id).map(job => job.id)).toEqual([originalJob])
    const nativeApi = { kill: vi.fn(({ jobId, sessionId }) => ctx.jobs.kill(jobId, sessionId)) }
    const gateway = new WorkbenchJobs({ registry: ctx.jobs, native: nativeApi,
      service: { requireChat: (_owner, id) => ({ sessionId: id === 'source' ? source.id : fork.id }) } })
    await expect(gateway.stop({ ownerId: 'owner' }, 'fork', originalJob)).rejects.toThrow('不属于此对话')
    expect(nativeApi.kill).not.toHaveBeenCalled()
    expect(await gateway.stop({ ownerId: 'owner' }, 'fork', forkJob)).toBe('requested')
    expect(ctx.jobs.get(originalJob, source.id).status).toBe('running')
  } finally {
    for (const finish of finishes) finish({ status: 'completed' })
    await ctx.fiber.dispose()
  }
})
