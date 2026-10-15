import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchService } from '../src/service.js'
import { TaskScheduler } from '../src/scheduler.js'
import { WorkbenchRuntime } from '../src/runtime.js'
import { projectInboxClaim, projectSessionEvent, settleNativeIdle } from '../src/projection.js'
import { apply as personalSkills } from '../../workbench-sandbox-skills/src/index.js'

const req = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(req.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { default: LlmRuntime, LlmAdapter }, { default: Sessions },
  { default: Projections }, { default: Prompts }, { default: Tools }, { default: Agents },
  { default: AgentLoop }, { default: Skills }, SkillTool, { default: Goals }, GoalDriver,
  { default: Commands }, GoalCommand, { default: PlanMode }] = await Promise.all([
  native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'),
  native('dsh-system-prompt'), native('dsh-tools'), native('dsh-agent'), native('dsh-agent-loop'),
  native('dsh-skill'), native('dsh-tool-skill'), native('dsh-goal'), native('dsh-goal-round-driver'),
  native('dsh-commands'), native('dsh-command-goal'), native('dsh-plan-mode'),
])
const { SessionCommandController } = await import(pathToFileURL(join(dirname(req.resolve('@deepseek-ai/dsh-api-session-controller')), 'types', 'commands.js')).href)
const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const definition = (name, provider = 'gxzs-sandbox-personal') => ({ name, provider, source: 'custom',
  description: 'Skill fixture', content: `BODY_FOR_${name}`, invocation: { userInvocable: true, modelInvocable: false } })
const catalog = [{ id: 'global:mcp:records:lookup', scope: 'global', server_id: 'records', tool_name: 'lookup', provider_name: '档案 /hidden-skill 服务',
  runtime_name: 'lookup', version: 'v1', description: 'Fixture', inputSchema: { type: 'object', properties: {} } }]
const until = async predicate => {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
class Model extends LlmAdapter {
  requests = []
  constructor(script) { super(); this.script = [...script] }
  async *stream(options) {
    this.requests.push(options)
    const value = this.script.shift() ?? 'done'
    if (value === 'hang') {
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
      return
    }
    if (typeof value === 'function') await value()
    if (value?.name) {
      const id = `call-${this.requests.length}`, args = JSON.stringify(value.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: value.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: value.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture(script = []) {
  const ctx = new Context(), db = new WorkbenchDatabase(':memory:'), owner = { ownerId: 't:1' }
  ctx.provide('workingDirectory', { ensure: async agent => agent.session.header.cwd, get: session => session.header.cwd })
  for (const plugin of [LlmRuntime, Sessions, Projections, Prompts, Tools, Agents, Skills, Goals, Commands, GoalCommand, GoalDriver]) await ctx.plugin(plugin)
  await ctx.plugin(PlanMode, { section: 'Prepare a plan.' }); await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(SkillTool)
  const model = new Model(script); ctx.llm.registerAdapter(['mock'], model)
  const agent = await ctx.agentLoop.create(`skills-${crypto.randomUUID()}`, { provider: 'mock', model: 'mock' }, { cwd: '/workspace/conversations/chat' })
  const chat = db.createChat({ id: 'chat', ownerId: owner.ownerId, sessionId: agent.id, selection: { model: 'mock/mock' } })
  const controllerCtx = Object.create(ctx)
  controllerCtx.attachments = { admitPromptContent: async content => content }
  controllerCtx.fileUploads = { retirePrompt() {}, bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }) }
  const controller = new SessionCommandController(controllerCtx, { resolveAgent: async () => ({ agent }),
    selectionFor: () => ({ current: { provider: 'mock', model: 'mock' } }) }, '/workspace')
  const sessions = { prompt: (request, signal) => controller.prompt(request, signal), updateQueue: request => controller.updateQueue(request),
    modelCatalog: async () => ({ groups: [{ id: 'mock', models: [{ id: 'mock' }] }] }),
    selectModel: async () => ({}), cancel: () => agent.cancel({ kind: 'user' }, { keepInbox: true }) }
  let permitted = true
  const platform = { json: async request => {
    if (request.route === 'mcp/catalog') return { tools: catalog }
    if (request.route === 'workbench/config') return { data: { enabled: true, models: { default: 'mock/mock', providers: { mock: { models: [{ id: 'mock', name: 'Fixture' }] } } } } }
    if (request.route === 'mcp/cancel') return { data: { fenced: true } }
    return { data: { state: JSON.parse(request.body ?? '{}').action === 'release' ? 'done' : permitted ? 'running' : 'waiting' } }
  } }
  const scheduler = new TaskScheduler({ database: db, sessions, platformClient: platform, ownerId: owner.ownerId, agents: ctx.agents })
  const runtime = new WorkbenchRuntime(ctx, db, owner.ownerId); runtime.scheduler = scheduler
  const service = new WorkbenchService({ database: db, sessionController: sessions, agents: ctx.agents, scheduler, goals: ctx.goals,
    commands: ctx.commands, skills: ctx.skills, workingDirectory: ctx.workingDirectory, workspace: '/workspace',
    onGoalChanged: listener => ctx.on('goal/changed', listener, { prepend: true }), platformClient: platform, fileManager: { operate: async () => ({}) } })
  ctx.on('agent/inbox/claimed', payload => projectInboxClaim(db, payload, owner.ownerId))
  ctx.on('session/event', (session, event) => projectSessionEvent(db, session.id, event, owner.ownerId,
    { goal: ctx.goals.get(agent), nativeIdle: agent.status === 'idle' }))
  ctx.on('agent/status', ({ agent: current, status }) => { if (status === 'idle') settleNativeIdle(db, current.id, ctx.goals.get(current)) })
  // Match the production ordering: admission first, then wrap native SkillTool.
  ctx.on('agent/pre-step', (payload, next) => scheduler.admitNativeStep(payload, () => service.guardSkillInvocations(payload, next)), { prepend: true })
  cleanups.push(async () => { agent.cancel({ kind: 'user' }, { keepInbox: true }); scheduler.pendingTick = null; await scheduler.close(); await ctx.fiber.dispose(); db.close() })
  return { ctx, db, owner, agent, chat, model, service, scheduler, permit: value => { permitted = value },
    submit: (skills, query = '用户原文', extra = {}) => service.submitRun(owner, chat.id, { query, resource_mentions: { skills }, ...extra }),
    run: id => db.getRun(owner.ownerId, id),
    flush: async () => { scheduler.pendingTick = null; await scheduler.tick(); await agent.whenIdle() } }
}
const injections = h => h.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')
async function personal(h, name) {
  const item = { id: name, version: 'v1', enabled: true, content: `---\nname: ${name}\ndescription: Fixture\ndisable-model-invocation: true\n---\nBODY_FOR_${name}` }
  h.ctx.provide('workbenchFileManager', { personalResources: async () => ({ skills: [item] }) }); personalSkills(h.ctx)
  return item
}

test.each(['disabled', 'provider', 'policy', 'get-unavailable'])('native execution fails visibly when queued selected skill changes: %s', async change => {
  const h = await fixture(), item = await personal(h, 'selected')
  h.scheduler.pendingTick = new Promise(() => {})
  const run = await h.submit(['personal:selected'])
  assert.deepEqual(h.run(run.id).selection.skill_invocations.map(item => item.provider), ['gxzs-sandbox-personal'])
  if (change === 'provider') {
    const row = definition('selected', 'gxzs-filesystem')
    h.ctx.skills.registerProvider(() => ({ name: row.provider, list: async () => [{ ...row, rank: 300, locator: {} }], get: async () => row }))
  } else if (change === 'policy') item.content = item.content.replace('disable-model-invocation: true', 'user-invocable: false')
  else item.enabled = false
  // get-unavailable deliberately leaves the native summary cache populated:
  // only DSH's real body load detects the manager-side change.
  if (change !== 'get-unavailable') await h.ctx.parallel('workbench/resources-changed')
  await h.flush()
  assert.equal(h.run(run.id).status, 'failed'); assert.equal(h.model.requests.length, 0)
  assert.equal(injections(h).length, 0); assert.equal(h.run(run.id).query, '用户原文')
  assert.ok(h.run(run.id).error)
  assert.ok(h.db.allEvents(h.owner.ownerId, run.id).some(event => event.event === 'workbench_end' && event.status === 'failed' && event.error))
})

test.each(['tools', 'plugins'])('generated %s metadata cannot invoke a skill; user slash still can', async kind => {
  const h = await fixture(); h.ctx.skills.register(definition('hidden-skill'))
  const refs = { [kind]: [kind === 'tools' ? catalog[0].id : 'global:mcp:records'] }
  await h.submit([], '只用插件', { resource_mentions: refs }); await h.flush()
  assert.equal(injections(h).length, 0); assert.ok(!JSON.stringify(h.model.requests).includes('BODY_FOR_hidden-skill'))
  await h.submit([], '请 /hidden-skill 执行', { resource_mentions: refs }); await h.flush()
  assert.equal(injections(h).length, 1); assert.ok(JSON.stringify(h.model.requests.at(-1)).includes('BODY_FOR_hidden-skill'))
})

test('queued edits preserve identity and display while duplicate raw gestures load only once', async () => {
  const h = await fixture(); h.ctx.skills.register(definition('selected'))
  h.scheduler.pendingTick = new Promise(() => {})
  const run = await h.submit(['selected', 'personal:selected'])
  await h.service.editQueued(h.owner, run.id, { content: [{ type: 'text', text: '编辑 /selected 原文' }] })
  await h.flush()
  assert.equal(h.run(run.id).status, 'completed'); assert.equal(h.run(run.id).query, '编辑 /selected 原文')
  assert.equal(injections(h).length, 1)
})

test('later native tool steps do not require a second user skill-invocation', async () => {
  const h = await fixture([{ name: 'skill', args: { name: 'model-helper' } }, 'done'])
  h.ctx.skills.register(definition('selected'))
  h.ctx.skills.register({ ...definition('model-helper'), invocation: { modelInvocable: true, userInvocable: true } })
  const run = await h.submit(['personal:selected']); await h.flush()
  assert.equal(h.model.requests.length, 2); assert.equal(injections(h).length, 1)
  assert.equal(h.run(run.id).status, 'completed')
})

test.each(['queue', 'steer'])('native %s inbox rechecks selection after dispatch while another message is running', async mode => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = await fixture([() => gate]), item = await personal(h, 'selected')
  const first = await h.submit([], '正在执行')
  await until(() => h.model.requests.length === 1)
  const queued = await h.submit(['personal:selected'], '后续原文')
  await h.scheduler.tick()
  await until(() => Boolean(h.run(queued.id).messageId))
  item.enabled = false; await h.ctx.parallel('workbench/resources-changed')
  if (mode === 'steer') await h.service.steer(h.owner, queued.id, first.id)
  release(); await h.agent.whenIdle()
  assert.equal(h.model.requests.length, 1); assert.equal(injections(h).length, 0)
  const failed = h.run(mode === 'steer' ? first.id : queued.id)
  assert.equal(failed.status, 'failed'); assert.ok(failed.error)
  assert.equal(h.run(queued.id).query, '后续原文')
})

test.each(['plan', 'goal'])('native %s checks selection after waiting for admission before its first model call', async command => {
  const h = await fixture(), item = await personal(h, 'selected'); h.permit(false)
  const result = await h.service.issueCommand(h.owner, h.chat.id, { command: `/${command} 原始任务`, request_key: command,
    resource_mentions: { skills: ['personal:selected'] } })
  item.enabled = false; await h.ctx.parallel('workbench/resources-changed'); h.permit(true)
  await h.agent.whenIdle()
  assert.equal(h.model.requests.length, 0); assert.equal(h.run(result.run.id).status, 'failed')
  assert.equal(injections(h).length, 0); assert.equal(h.run(result.run.id).query, '原始任务')
})

test('scoped catalog matches actual execution while legacy host catalog and bare personal alias remain valid', async () => {
  const h = await fixture()
  h.ctx.skills.register(definition('same-name', 'gxzs-filesystem'))
  h.agent.ctx.get('skills').register(definition('same-name'))
  assert.equal((await h.service.catalogSkills(h.owner))[0].scope, 'global')
  assert.equal((await h.service.catalogSkills(h.owner, h.chat.id))[0].scope, 'personal')
  await assert.rejects(() => h.service.catalogSkills({ ownerId: 'other' }, h.chat.id), /不存在/)
  const run = await h.submit(['same-name']); await h.flush()
  assert.equal(h.run(run.id).selection.skill_invocations[0].provider, 'gxzs-sandbox-personal')
  assert.equal(h.run(run.id).status, 'completed')
})

test.each(['button', 'command'])('Goal %s resume rejects provider substitution instead of changing the selected source', async mode => {
  const h = await fixture(['hang']); await personal(h, 'selected')
  await h.service.issueCommand(h.owner, h.chat.id, { command: '/goal 原始目标', request_key: 'goal', resource_mentions: { skills: ['selected'] } })
  await until(() => h.model.requests.length === 1)
  await h.service.mutateGoal(h.owner, h.chat.id, 'pause', { ref: h.ctx.goals.get(h.agent) })
  h.agent.cancel({ kind: 'user' }, { keepInbox: true }); await h.agent.whenIdle()
  const row = definition('selected', 'gxzs-filesystem')
  h.ctx.skills.registerProvider(() => ({ name: row.provider, list: async () => [{ ...row, rank: 300, locator: {} }], get: async () => row }))
  await assert.rejects(() => mode === 'button'
    ? h.service.mutateGoal(h.owner, h.chat.id, 'resume', { ref: h.ctx.goals.get(h.agent) })
    : h.service.issueCommand(h.owner, h.chat.id, { command: '/goal resume', request_key: 'resume' }), /来源已改变/)
  assert.equal(h.model.requests.length, 1)
})

test.each(['button', 'command'])('Goal %s resume preserves raw display and invokes the valid skill through DSH', async mode => {
  const h = await fixture(['hang', 'hang']); await personal(h, 'selected')
  const first = await h.service.issueCommand(h.owner, h.chat.id, { command: '/goal 原始目标', request_key: 'goal', resource_mentions: { skills: ['personal:selected'] } })
  await until(() => h.model.requests.length === 1)
  await h.service.mutateGoal(h.owner, h.chat.id, 'pause', { ref: h.ctx.goals.get(h.agent) })
  h.agent.cancel({ kind: 'user' }, { keepInbox: true }); await h.agent.whenIdle()
  const resumed = mode === 'button'
    ? await h.service.mutateGoal(h.owner, h.chat.id, 'resume', { ref: h.ctx.goals.get(h.agent) })
    : await h.service.issueCommand(h.owner, h.chat.id, { command: '/goal resume', request_key: 'resume' })
  await until(() => h.model.requests.length === 2)
  assert.equal(injections(h).length, 2)
  assert.equal(h.run(first.run.id).query, '原始目标'); assert.equal(h.run(resumed.run.id).query, '原始目标')
  assert.ok(h.model.requests.every(request => JSON.stringify(request).includes('BODY_FOR_selected')))
})

test('accepted active Goal edit publishes its new identity before the native user gesture is claimed', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = await fixture([() => gate, 'hang'])
  h.ctx.skills.register(definition('first')); h.ctx.skills.register(definition('second'))
  const run = await h.service.issueCommand(h.owner, h.chat.id, { command: '/goal 初始目标', request_key: 'goal', resource_mentions: { skills: ['first'] } })
  await until(() => h.model.requests.length === 1)
  await h.service.issueCommand(h.owner, h.chat.id, { command: '/goal edit 修改目标', request_key: 'edit', resource_mentions: { skills: ['second'] } })
  assert.deepEqual(h.run(run.run.id).selection.skill_invocations.map(item => item.name), ['second'])
  release(); await until(() => h.model.requests.length === 2)
  assert.deepEqual(injections(h).map(event => event.data.source.name), ['first', 'second'])
})
