import { afterAll, beforeAll, test } from 'vitest'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import * as discovery from '../src/index.js'
import { ACTIVE_EVENT } from '../src/projection.js'
import * as mcp from '../../workbench-mcp-tools/src/index.js'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'

// Use the pinned native Session format and its real JSONL reader;
// replaying a raw in-memory seed alone skips the durable reader's validation.

const catalog = [{ id: 'global:mcp:cases:case_lookup', runtime_name: 'global_cases_lookup', scope: 'global', server_id: 'cases',
  tool_name: 'case_lookup', provider_name: '案件检索', provider_call_name: 'cases', provider_description: '案件档案',
  version: 'v1', manifest_version: 'm1', description: '检索案件记录',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }]
let serial = 0
const response = (name, args) => name ? [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: `cold-${++serial}`, name, argumentsDelta: JSON.stringify(args ?? {}) },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: `cold-${serial}`, name, arguments: JSON.stringify(args ?? {}) } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
] : [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'done' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }, { type: 'finish', reason: { kind: 'stop' } }]
class Model extends LlmAdapter {
  requests = []
  constructor(script) { super(); this.script = [...script] }
  async *stream(options) {
    this.requests.push(structuredClone({ ...options, signal: undefined }))
    const chunks = this.script.shift()
    if (!chunks) throw new Error('Fixture script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

async function mount(root, { owner = 'owner-a', runOwner = owner, rows = catalog, frozen = catalog,
  script = [response('case_lookup', { query: 'restored' }), response()] } = {}) {
  const ctx = new Context(), calls = []
  ctx.provide('workingDirectory', { get: () => root, ensure: async () => root })
  for (const plugin of [LlmRuntime, SessionStore, Projections, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(Jsonl, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const model = new Model(script)
  ctx.llm.registerAdapter(['mock'], model)
  const run = { id: 'run-1', ownerId: runOwner, status: 'running', mcpTools: frozen }
  ctx.provide('workbenchRuntime', { ownerId: owner, agents: ctx.agents, executionRun: () => run,
    authorizeMcpCall: async (_sessionId, id, version) => {
      const resource = run.ownerId === owner && run.status === 'running' && run.mcpTools.find(row => row.id === id && row.version === version)
      return resource ? { ownerId: owner, runId: run.id, resource } : undefined
    },
  })
  ctx.provide('workbenchPlatformClient', { json: async request => {
    if (request.route === 'mcp/catalog') return { tools: rows }
    calls.push(JSON.parse(request.body.toString()))
    return { data: { result: { content: [{ type: 'text', text: 'Found record' }] } } }
  } })
  await ctx.plugin(mcp, { discovery: true })
  await ctx.plugin(discovery)
  return { ctx, model, calls, run,
    send: async agent => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue test' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }, close: () => ctx.fiber.dispose(),
  }
}

const temp = fileURLToPath(new URL('../../../../temp/', import.meta.url))
let directory, originalRoot, originalAgent
const sessionId = 'cold-discovery-session'
beforeAll(async () => {
  await mkdir(temp, { recursive: true })
  directory = await mkdtemp(join(temp, 'tool-discovery-cold-'))
  originalRoot = join(directory, 'original')
  await mkdir(originalRoot, { recursive: true })
  const h = await mount(originalRoot, { script: [response('tool_search', { query: 'case_lookup' }), response()] })
  try {
    originalAgent = await h.ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: originalRoot })
    await h.send(originalAgent)
    assert.deepEqual(h.model.requests[0].tools.map(tool => tool.name), ['mcp', 'tool_search'])
    assert.deepEqual(h.model.requests[1].tools.map(tool => tool.name), ['case_lookup', 'mcp', 'tool_search'])
    await h.ctx.sessionPersistence.flush()
    const exported = { header: originalAgent.session.header, events: originalAgent.session.snapshotEvents(),
      checkpoint: h.ctx.sessionProjections.checkpoint(originalAgent.session) }
    await writeFile(join(directory, 'exported-session.json'), JSON.stringify(exported), 'utf8')
    const persisted = JSON.parse(await readFile(join(directory, 'exported-session.json'), 'utf8'))
    assert.equal(persisted.checkpoint.toolDiscovery.val.tools[0].name, 'case_lookup')
    const activation = persisted.events.find(event => event.type === ACTIVE_EVENT)
    assert.equal(activation?.ignorable, true)
  } finally { await h.close() }
})
afterAll(async () => {
  if (directory) {
    assert.ok(resolve(directory).startsWith(resolve(temp) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const cases = [
  ['same authority', {}, true],
  ['changed owner', { owner: 'owner-b' }, false],
  ['mismatched owner', { owner: 'owner-b', runOwner: 'owner-a' }, false],
  ['changed version', { rows: catalog.map(row => ({ ...row, version: 'v2' })), frozen: catalog.map(row => ({ ...row, version: 'v2' })) }, false],
  ['changed manifest', { rows: catalog.map(row => ({ ...row, manifest_version: 'm2' })), frozen: catalog.map(row => ({ ...row, manifest_version: 'm2' })) }, false],
  ['changed schema at the same version', { rows: catalog.map(row => ({ ...row, inputSchema: { type: 'object', properties: { other: { type: 'number' } } } })) }, false],
  ['removed tool', { rows: [] }, false],
]
test.each(cases)('actual JSONL cold resume validates %s before the first provider request', async (name, options, expected) => {
  const root = join(directory, name.replaceAll(' ', '-'))
  await cp(originalRoot, root, { recursive: true })
  const h = await mount(root, options)
  try {
    const handle = await h.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    assert.notEqual(handle.agent, originalAgent)
    assert.equal(Boolean(h.ctx.tools.get('case_lookup', handle.agent)), expected)
    await h.send(handle.agent)
    assert.equal(h.model.requests.length, 2)
    assert.equal(h.model.requests[0].tools.some(tool => tool.name === 'case_lookup'), expected)
    assert.equal(h.calls.length, expected ? 1 : 0)
    if (expected) assert.equal(h.calls[0].resource_id, catalog[0].id)
    else assert.ok(handle.agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.isError))
    await h.ctx.sessionPersistence.flush()
  } finally { await h.close() }
})
