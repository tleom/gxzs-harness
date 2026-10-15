import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import * as discovery from '../src/index.js'

let nextCallId = 0
export function response(calls = []) {
  if (!calls.length) return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'done' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }, { type: 'finish', reason: { kind: 'stop' } }]
  const chunks = calls.flatMap(([name, args], index) => {
    const id = `fixture-${++nextCallId}`, argumentsJson = JSON.stringify(args)
    return [{ type: 'block-start', index, blockType: 'tool-call' }, { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsJson }, { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsJson } }]
  })
  return [...chunks, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
export const call = (name, args = {}, mode = 'native') => response(mode === 'native' ? [[name, args]] : [['run_code', { description: `Fixture ${name}`, code: JSON.stringify({ name, args }) }]])

class Adapter extends LlmAdapter {
  requests = []
  constructor(script) { super(); this.script = [...script] }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.requests.push(structuredClone({ ...options, signal: undefined }))
    const item = this.script.shift()
    if (!item) throw new Error('Fixture script exhausted')
    const chunks = typeof item === 'function' ? await item(options) : item
    for (const chunk of chunks) yield chunk
  }
}
class FixturePtc extends PtcRuntime {
  language = 'typescript'; isolation = 'fake'; observations = []
  resolve(request) { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 5000 } }
  async run(request) {
    const action = JSON.parse(request.program), functions = request.bindings[0].functions
    this.observations.push(Object.keys(functions))
    try {
      const result = await functions[action.name](action.args)
      if (action.failAfter) return { logs: [], error: { kind: 'exception', message: 'Fixture outer program failed' } }
      return { value: result, logs: [] }
    } catch (error) { return { logs: [], error: { kind: 'exception', message: error.message } } }
  }
}

export function row(id, name, pluginScope = 'global', description = '检索案件记录 case records', extra = {}) {
  return { id, name, pluginId: `${pluginScope}:mcp:records`, pluginName: pluginScope === 'global' ? '全局案件' : '个人笔记', pluginScope,
    description, version: 'v1', manifestVersion: 'm1', parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false }, ...extra }
}

export class Bridge {
  constructor(rows) { this.rows = rows; this.revision = 1; this.ready = true; this.owner = 'owner-a'; this.run = 'run-1'; this.listeners = new Set(); this.readyTransitions = [] }
  snapshot(agent) { return { authorityKey: `${this.owner}\0${this.run}`, revision: String(this.revision), ready: this.ready, tools: this.visible ? this.visible(agent, this.rows) : this.rows } }
  managedNames() { return this.rows.map(item => item.name) }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  setDiscoveryReady(ready) { this.readyTransitions.push(ready) }
  notify() { this.revision++; for (const listener of this.listeners) listener() }
}

export async function mount({ rows = [row('g:cases', 'case_lookup')], mode = 'native', script = [response()], config = {}, mountDiscovery = true, bridgeFactory } = {}) {
  const ctx = new Context(), executions = []
  ctx.provide('workingDirectory', { defaultDirectory: process.cwd(), get: () => process.cwd(), ensure: async () => process.cwd() })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjection, SystemPrompt]) await ctx.plugin(plugin)
  await ctx.plugin(ToolRuntime, { mode })
  if (mode === 'ptc') await ctx.plugin(FixturePtc)
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new Adapter(script); ctx.llm.registerAdapter(['fixture'], adapter)
  const registrations = new Map()
  function register(item) {
    const dispose = ctx.tools.register({ name: item.name, description: item.description, parameters: item.parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { executions.push(item.name); return `executed:${item.name}` },
    })
    registrations.set(item.id, dispose)
  }
  for (const item of rows) register(item)
  const bridge = bridgeFactory ? await bridgeFactory(ctx) : new Bridge(rows)
  if (!bridgeFactory) ctx.provide('toolDiscoveryCatalog', bridge)
  let plugin = mountDiscovery ? await ctx.plugin(discovery, config) : undefined
  return {
    ctx, bridge, adapter, executions, registrations, register,
    get plugin() { return plugin },
    remount: async () => { plugin = await ctx.plugin(discovery, config); return plugin },
    create: async (id = 'agent-1') => ctx.agentLoop.create(id, { provider: 'fixture', model: 'fixture' }),
    send: async (agent, text = 'Find a useful tool') => { agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })); await agent.whenIdle() },
    close: () => ctx.fiber.dispose(),
  }
}
