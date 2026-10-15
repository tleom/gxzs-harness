import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { appendSkillInvocations, resolveSkillInvocations } from '../src/skill-invocations.js'
import { WorkbenchService } from '../src/service.js'

const nativeRequire = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = name => import(pathToFileURL(nativeRequire.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { default: LlmRuntime, LlmAdapter, createUserMessage },
  { default: SessionStore }, { default: Projections }, { default: SystemPrompt },
  { default: ToolRuntime }, { default: AgentRegistry }, { default: AgentLoop },
  { default: Skills }, SkillTool, { default: Commands }, { default: PlanMode },
  { default: Goals }, GoalCommand, GoalDriver] = await Promise.all([
  native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'),
  native('dsh-system-prompt'), native('dsh-tools'), native('dsh-agent'), native('dsh-agent-loop'),
  native('dsh-skill'), native('dsh-tool-skill'), native('dsh-commands'), native('dsh-plan-mode'),
  native('dsh-goal'), native('dsh-command-goal'), native('dsh-goal-round-driver'),
])

const definition = (name, overrides = {}) => ({ name, description: 'Used for the native invocation test',
  invocation: { userInvocable: true, modelInvocable: false }, source: 'custom',
  provider: 'fixture', content: `BODY_FOR_${name}`, ...overrides })

test('selection uses Agent scope and cwd, permits user-only skills, and does not load bodies', async () => {
  const agent = {}, signal = new AbortController().signal
  let lookup
  const userOnly = definition('user-only')
  const result = await resolveSkillInvocations({ list: async options => { lookup = options; return [userOnly] } },
    ['user-only', 'user-only'], { agent, cwd: '/changed/current-directory', signal })
  assert.deepEqual(lookup, { scope: agent, cwd: '/changed/current-directory', signal })
  assert.deepEqual(result, [userOnly])
})

test('selection rejects unavailable, disabled, non-user-invocable and wrong personal-source aliases', async () => {
  const rows = [definition('global'), definition('disabled', { enabled: false }),
    definition('model-only', { invocation: { userInvocable: false, modelInvocable: true } })]
  const registry = { list: async () => rows }, agent = {}
  for (const id of ['missing', 'disabled', 'personal:global'])
    await assert.rejects(() => resolveSkillInvocations(registry, [id], { agent }), error => error.status === 409 && /不可用/.test(error.message))
  await assert.rejects(() => resolveSkillInvocations(registry, ['model-only'], { agent }), /不允许用户调用/)
  await assert.rejects(() => resolveSkillInvocations(registry, ['global']), /会话暂时无法恢复/)
})

test('a personal alias resolves once, while no selected skill requires neither Agent nor registry', async () => {
  const row = definition('personal', { provider: 'gxzs-sandbox-personal' })
  assert.deepEqual(await resolveSkillInvocations({ list: async () => [row] }, ['personal', 'personal:personal'], { agent: {} }), [row])
  assert.deepEqual(await resolveSkillInvocations(undefined, []), [])
})

test('gestures preserve first user query, attachments, deduplication, and exact DSH token boundaries', () => {
  const input = [{ type: 'text', text: '请 /one 执行；路径 /two/file，分数5/8' }, { type: 'image', data: 'fixture' }]
  const output = appendSkillInvocations(input, [definition('one'), definition('two'), definition('two')])
  assert.equal(output[0], input[0])
  assert.equal(output[1], input[1])
  assert.deepEqual(output[2], { type: 'text', text: '/two' })
  assert.equal(appendSkillInvocations(output, [definition('one'), definition('two')]), output)
  assert.equal(input.length, 2)
  assert.equal(appendSkillInvocations(input, []), input)
})

class Model extends LlmAdapter {
  requests = []
  async *stream(options) {
    this.requests.push(structuredClone({ ...options, signal: undefined }))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const cleanups = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(t, { goals = false, plan = false } = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.provide('workingDirectory', { ensure: async agent => agent.session.header.cwd,
    get: session => session.header.cwd })
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, ToolRuntime, AgentRegistry, Skills, Commands])
    await ctx.plugin(plugin)
  if (plan) await ctx.plugin(PlanMode, { section: 'Prepare a plan for the user.' })
  if (goals) {
    await ctx.plugin(Goals, { defaultMaxGoalRounds: 1 })
    await ctx.plugin(GoalCommand)
    await ctx.plugin(GoalDriver)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SkillTool)
  const model = new Model()
  ctx.llm.registerAdapter(['mock'], model)
  const agent = await ctx.agentLoop.create(`skills-${crypto.randomUUID()}`, { provider: 'mock', model: 'test' }, { cwd: '/workspace/current' })
  return { ctx, model, agent }
}

function injections(agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'skill-invocation')
}

test('actual DSH ordinary user prompt and steer load user-only skill without a model skill tool call', async t => {
  const { ctx, model, agent } = await fixture(t)
  ctx.skills.register(definition('manual-report'))
  const selected = await resolveSkillInvocations(ctx.skills, ['manual-report'], { agent, cwd: '/workspace/current' })
  for (const mode of ['followup', 'steer']) {
    const original = [{ type: 'text', text: `用户任务-${mode}` }]
    agent[mode](createUserMessage({ content: appendSkillInvocations(original, selected), source: { kind: 'user', rpcId: mode } }))
    await agent.whenIdle()
  }
  assert.equal(model.requests.length, 2)
  assert.equal(injections(agent).length, 2)
  assert.ok(model.requests.every(request => JSON.stringify(request).includes('BODY_FOR_manual-report')))
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0)
  const user = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
  assert.deepEqual(user.map(event => event.data.content[0].text), ['用户任务-followup', '用户任务-steer'])
})

test('actual DSH scoped skill is selected and another Agent cannot select it', async t => {
  const { ctx, agent } = await fixture(t)
  agent.ctx.get('skills').register(definition('scoped-only'))
  assert.equal((await resolveSkillInvocations(ctx.skills, ['scoped-only'], { agent }))[0].name, 'scoped-only')
  const other = await ctx.agentLoop.create(`other-${crypto.randomUUID()}`, { provider: 'mock', model: 'test' }, { cwd: '/workspace/other' })
  await assert.rejects(() => resolveSkillInvocations(ctx.skills, ['scoped-only'], { agent: other }), /不可用/)
})

test('actual DSH does not load stale selected content when skill is removed before execution', async t => {
  const { ctx, agent, model } = await fixture(t)
  const dispose = ctx.skills.register(definition('removed'))
  const selected = await resolveSkillInvocations(ctx.skills, ['removed'], { agent })
  dispose()
  agent.followup(createUserMessage({ content: appendSkillInvocations([{ type: 'text', text: 'task' }], selected), source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.equal(injections(agent).length, 0)
  assert.ok(!JSON.stringify(model.requests).includes('BODY_FOR_removed'))
})

test('actual native /plan command produces a user gesture and loads the skill in its first request', async t => {
  const { ctx, agent, model } = await fixture(t, { plan: true })
  ctx.skills.register(definition('plan-helper'))
  const selected = await resolveSkillInvocations(ctx.skills, ['plan-helper'], { agent })
  const displayQuery = '制定任务计划'
  const nativeText = appendSkillInvocations([{ type: 'text', text: displayQuery }], selected).map(block => block.text).join('\n')
  const execution = await ctx.commands.execute(agent, `/plan ${nativeText}`, [], new AbortController().signal)
  assert.equal(execution.result.kind, 'success')
  await agent.whenIdle()
  assert.equal(injections(agent).length, 1)
  assert.ok(JSON.stringify(model.requests[0]).includes('BODY_FOR_plan-helper'))
  assert.equal(displayQuery, '制定任务计划')
})

test('automatic goal and background resume sources cannot forge a user gesture', async t => {
  const { ctx, agent, model } = await fixture(t)
  ctx.skills.register(definition('manual'))
  for (const kind of ['goal', 'workbench-resume']) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '/manual' }], source: { kind } }))
    await agent.whenIdle()
  }
  assert.equal(injections(agent).length, 0)
  assert.ok(!JSON.stringify(model.requests).includes('BODY_FOR_manual'))
})

test('service queues the user gesture before the first Goal model request', { timeout: 5000 }, async t => {
  const { ctx, agent, model } = await fixture(t, { goals: true })
  ctx.skills.register(definition('goal-helper'))
  const selected = await resolveSkillInvocations(ctx.skills, ['goal-helper'], { agent })
  const service = new WorkbenchService({})
  service.onGoalChanged = listener => ctx.on('goal/changed', listener, { prepend: true })
  const execution = await service.withGoalSkillInvocations(agent, selected, () =>
    ctx.commands.execute(agent, '/goal 完成目标', [], new AbortController().signal))
  assert.equal(execution.result.kind, 'success')
  const deadline = Date.now() + 4000
  while ((ctx.goals.get(agent)?.phase !== 'blocked' || agent.status !== 'idle') && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(ctx.goals.get(agent)?.phase, 'blocked')
  assert.equal(injections(agent).length, 1)
  assert.ok(JSON.stringify(model.requests[0]).includes('BODY_FOR_goal-helper'))
  const user = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.source.kind === 'user')
  assert.deepEqual(user.data.content, [{ type: 'text', text: '完成目标' }, { type: 'text', text: '/goal-helper' }])
})
