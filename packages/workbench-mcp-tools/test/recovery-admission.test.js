import { expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply } from '../src/index.js'
import { executeMcpTask, McpTaskJournal } from '../src/tasks.js'
import { WorkbenchService } from '../../workbench-adapter/src/service.js'

const nativeRequire = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = async name => import(pathToFileURL(nativeRequire.resolve(`@deepseek-ai/${name}`)).href)
const catalog = () => process.env.MCP_RECOVERY_CATALOG_FIXTURE
  ? JSON.parse(readFileSync(process.env.MCP_RECOVERY_CATALOG_FIXTURE, 'utf8'))
  : { tools: [{ id: 'global:mcp:reports:report', scope: 'global', server_id: 'reports', tool_name: 'report', name: 'report',
    runtime_name: 'global_reports_report', description: '', version: '1', manifest_version: 'fixture',
    inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } }],
  plugins: [{ id: 'global:mcp:reports', scope: 'global', server_id: 'reports', name: 'reports', version: '1',
    manifest_version: 'fixture', available: true, protocol_version: '2025-11-25',
    capabilities: { tasks: { requests: { tools: { call: {} } } } } }] }

it('freezes a retained capacity catalog for a new run and resumes through native Tools and official Tasks without another creation', async () => {
  const published = catalog(), owner = 'tenant:7', tool = published.tools[0], server = published.plugins[0]
  const db = new DatabaseSync(':memory:')
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE runs(id TEXT PRIMARY KEY); INSERT INTO runs VALUES ('old-run'), ('new-run')")
  const journal = new McpTaskJournal({ db }), methods = [], cleanups = []
  const [{ Context }, { default: Tools }, { createScope }, { default: Prompt }] = await Promise.all([
    native('cordis'), native('dsh-tools'), native('dsh-scope'), native('dsh-system-prompt'),
  ])
  const nativeContext = new Context()
  let run, lost = true, scope
  const snapshot = status => ({ taskId: 'fixture-task', status, createdAt: '2026-10-24T00:00:00Z',
    lastUpdatedAt: '2026-10-24T00:00:00Z', ttl: 60000, pollInterval: 1 })
  const dispatch = async request => {
    methods.push(request.method)
    if (request.method === 'tools/call') return { task_ticket: 'ticket', result: { task: snapshot('working') } }
    if (request.method === 'tasks/get') {
      if (lost) throw new Error('connection lost')
      return { result: snapshot('completed') }
    }
    if (request.method === 'tasks/result') return { result: { content: [{ type: 'text', text: 'recovered-complete' }] } }
    throw new Error('Unexpected task replay or control')
  }
  try {
    await expect(executeMcpTask({ tool, server, args: {}, journal, controlTimeoutMs: 1000,
      exec: { callId: 'old-call', signal: new AbortController().signal, deadlineMs: Date.now() + 60000 },
      authorization: { ownerId: owner, runId: 'old-run' }, dispatch })).rejects.toThrow('connection lost')
    expect(journal.pending(owner)).toHaveLength(1)
    const definitions = new Map()
    const ctx = {
      tools: { get: name => definitions.get(name), register: definition => {
        definitions.set(definition.name, definition); return () => definitions.delete(definition.name)
      } },
      workbenchRuntime: { ownerId: owner, database: { db }, executionRun: () => run,
        authorizeMcpCall: vi.fn(async () => ({ ownerId: owner, runId: run.id, resource: tool })) },
      workbenchPlatformClient: { json: vi.fn(async request => request.route === 'mcp/catalog'
        ? published : dispatch(JSON.parse(request.body))) },
      on: vi.fn(), effect: factory => cleanups.push(factory()), logger: { warn: vi.fn() },
    }
    ctx.reflect = { provide: (name, value) => { ctx[name] = value } }
    await apply(ctx)
    const frozen = await WorkbenchService.prototype.freezeMcpCatalog.call({
      refreshMcpCatalog: ctx.workbenchRuntime.refreshMcpCatalog,
    }, { ownerId: owner }, [], [])
    expect(frozen.tools).toHaveLength(1)
    expect(frozen.tools[0].manifest_version).toBe(tool.manifest_version)
    run = { id: 'new-run', ownerId: owner, status: 'running', mcpTools: frozen.tools }
    await nativeContext.plugin(Prompt)
    await nativeContext.plugin(Tools, { mode: 'native' })
    const tools = nativeContext.get('tools'), agent = { id: 'a', session: { id: 'session' } }
    scope = createScope(nativeContext, agent)
    // Production injects the Tools property; keep the same native scoped service.
    agent.ctx = { get: scope.ctx.get.bind(scope.ctx), tools: scope.ctx.get('tools') }
    ctx.on.mock.calls.find(([event]) => event === 'agent/inbox/claimed')[1]({ agent })
    const recovery = tools.schemas(agent).find(item => item.name.startsWith('resume_mcp_task_'))
    expect(recovery).toBeDefined()
    lost = false
    const result = await tools.execute({ name: recovery.name, arguments: { task_ref: 'old-run:old-call' }, agent,
      callId: 'native-recovery', signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain('recovered-complete')
    expect(methods.filter(method => method === 'tools/call')).toHaveLength(1)
    const requests = ctx.workbenchPlatformClient.json.mock.calls.map(([request]) => request)
      .filter(request => request.route === 'mcp/task').map(request => JSON.parse(request.body))
    expect(requests[0]).toMatchObject({ run_id: 'old-run', admission_run_id: 'new-run', task_ticket: 'ticket' })
    expect(journal.pending(owner)).toEqual([])
  } finally {
    for (const stop of cleanups.reverse()) stop?.()
    scope?.rawDispose()
    await nativeContext.fiber.dispose()
    db.close()
  }
})
