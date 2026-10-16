import { afterAll, beforeAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as discovery from '../src/index.js'
import { ACTIVE_EVENT } from '../src/projection.js'
import * as mcp from '../../workbench-mcp-tools/src/index.js'

const tool = { id: 'global:mcp:cases:case_lookup', runtime_name: 'global_cases_lookup', scope: 'global', server_id: 'cases',
  tool_name: 'case_lookup', provider_name: '案件检索', provider_call_name: 'cases', provider_description: '合成案件档案',
  version: 'v1', manifest_version: 'm1', description: '检索合成案件记录',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
const SUMMARY = 'COMPACTION_FIXTURE_SUMMARY: A case lookup capability was discovered.'
const OLD_HISTORY = 'Historical context for synthetic discovery verification. '.repeat(300)
let callId = 0
const answer = (text = 'done') => [{ type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } }]
const call = (name, args) => {
  const id = `compact-${++callId}`, argumentsJson = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}
class Model extends LlmAdapter {
  requests = []; summaryRequests = []
  constructor(script) { super(); this.script = [...script] }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } } }
  async *stream(options) {
    const copy = structuredClone({ ...options, signal: undefined })
    const summarizing = options.model === 'summary'
    ;(summarizing ? this.summaryRequests : this.requests).push(copy)
    const chunks = summarizing ? answer(SUMMARY) : this.script.shift()
    if (!chunks) throw new Error('Compaction fixture script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

async function mount(root, { owner = 'owner-a', currentTool = tool, script = [call('case_lookup', { query: 'restored' }), answer()] } = {}) {
  const ctx = new Context(), calls = [], model = new Model(script)
  ctx.provide('workingDirectory', { get: () => root, ensure: async () => root })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter(['fixture'], model)
  await ctx.plugin(BasicCompaction, { auto: false, summarizationProvider: 'fixture', summarizationModel: 'summary', retainTokens: 0, maxTokens: 1024 })
  const run = { id: 'same-run', ownerId: owner, status: 'running', mcpTools: [currentTool] }
  ctx.provide('workbenchRuntime', { ownerId: owner, agents: ctx.agents, executionRun: () => run,
    authorizeMcp: (_session, id, version) => id === currentTool.id && version === currentTool.version
      ? { ownerId: owner, runId: run.id, resource: currentTool } : undefined,
  })
  ctx.provide('workbenchPlatformClient', { json: async request => {
    if (request.route === 'mcp/catalog') return { tools: [currentTool] }
    calls.push(JSON.parse(request.body.toString()))
    return { result: { content: [{ type: 'text', text: 'Synthetic case record' }] } }
  } })
  await ctx.plugin(mcp, { discovery: true }); await ctx.plugin(discovery)
  return { ctx, model, calls, close: () => ctx.fiber.dispose(), send: async (agent, text = 'Continue after real compaction') => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  } }
}

const temp = fileURLToPath(new URL('../../../../temp/', import.meta.url)), sessionId = 'compacted-discovery'
let directory, originalRoot, originalAgent, originalContext
beforeAll(async () => {
  await mkdir(temp, { recursive: true })
  directory = await mkdtemp(join(temp, 'tool-discovery-compaction-cold-'))
  originalRoot = join(directory, 'original'); await mkdir(originalRoot, { recursive: true })
  const h = await mount(originalRoot, { script: [call('tool_search', { query: 'case_lookup' }), answer()] })
  originalContext = h.ctx
  try {
    originalAgent = await h.ctx.agentLoop.create(sessionId, { provider: 'fixture', model: 'conversation' }, { cwd: originalRoot })
    await h.send(originalAgent, OLD_HISTORY)
    assert.deepEqual(h.model.requests[0].tools.map(item => item.name), ['mcp', 'tool_search'])
    assert.deepEqual(h.ctx.sessionProjections.stateOf(originalAgent.session, 'toolDiscovery').tools.map(item => item.name), ['case_lookup'])
    const before = JSON.stringify(originalAgent.session.deriveMessages())
    const result = await h.ctx.compaction.compactNow(originalAgent, new AbortController().signal)
    assert.ok(result, 'BasicCompaction must perform a real useful replacement')
    assert.equal(h.model.summaryRequests.length, 1, 'The actual basic summarizer must issue its auxiliary model request')
    const after = JSON.stringify(originalAgent.session.deriveMessages())
    assert.ok(after.includes(SUMMARY))
    assert.ok(!after.includes(OLD_HISTORY))
    assert.ok(after.length < before.length)
    const events = originalAgent.session.snapshotEvents()
    assert.ok(events.some(event => event.type === 'compaction/summary'))
    assert.ok(events.some(event => event.type === 'compaction/end'))
    assert.equal(events.find(event => event.type === ACTIVE_EVENT)?.ignorable, true)
    assert.equal(h.ctx.sessionProjections.checkpoint(originalAgent.session).toolDiscovery.val.tools[0].name, 'case_lookup')
    await h.ctx.sessionPersistence.flush()
  } finally { await h.close() }
})

afterAll(async () => {
  if (!directory) return
  assert.ok(resolve(directory).startsWith(resolve(temp) + sep))
  await rm(directory, { recursive: true, force: true })
})

test.each([
  ['same authority and definition', {}, true],
  ['different owner', { owner: 'owner-b' }, false],
  ['changed authorized version', { currentTool: { ...tool, version: 'v2' } }, false],
])('actual compaction plus JSONL cold resume validates %s at the first request', async (name, options, expected) => {
  const root = join(directory, name.replaceAll(' ', '-')); await cp(originalRoot, root, { recursive: true })
  const h = await mount(root, options)
  try {
    assert.notEqual(h.ctx, originalContext)
    const handle = await h.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'fixture', model: 'conversation' } })
    const restored = handle.agent
    assert.notEqual(restored, originalAgent)
    assert.ok(JSON.stringify(restored.session.deriveMessages()).includes(SUMMARY), 'The restored native surface retains the actual compacted summary')
    assert.ok(restored.session.snapshotEvents().some(event => event.type === 'compaction/summary'))
    assert.equal(Boolean(h.ctx.tools.get('case_lookup', restored)), expected)
    await h.send(restored)
    assert.equal(h.model.requests.length, 2)
    assert.equal(h.model.requests[0].tools.some(item => item.name === 'case_lookup'), expected)
    assert.equal(h.calls.length, expected ? 1 : 0, 'A guessed revoked name must never reach the original MCP proxy')
    assert.equal(h.model.summaryRequests.length, 0, 'Cold resume must reuse the persisted compaction, not perform a substitute compaction')
    await h.ctx.sessionPersistence.flush()
  } finally { await h.close() }
})
