import { expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { taskRecoveryScopes } from '../src/task-recovery.js'

const nativeRequire = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const native = async name => import(pathToFileURL(nativeRequire.resolve(`@deepseek-ai/${name}`)).href)

it('runs resumed results through native structured output, failure and image projection', async () => {
  const [{ Context }, { default: Tools }, { createScope }, { default: Prompt }] = await Promise.all([
    native('cordis'), native('dsh-tools'), native('dsh-scope'), native('dsh-system-prompt'),
  ])
  const ctx = new Context()
  try {
    await ctx.plugin(Prompt)
    await ctx.plugin(Tools, { mode: 'native' })
    const tools = ctx.get('tools')
    const agent = { id: 'a', session: { id: 's' } }, other = { id: 'b' }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    const record = { ref: 'old:call', resourceId: 'global:mcp:reports:make', version: '1', manifestVersion: 'm' }
    const tool = { id: record.resourceId, version: '1', manifest_version: 'm', tool_name: 'make',
      outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } }
    const run = { ownerId: 'owner', status: 'running', mcpTools: [tool] }
    const resume = vi.fn()
    const scopes = taskRecoveryScopes({ workbenchRuntime: { ownerId: 'owner', executionRun: () => run } }, { pending: () => [record] }, resume)
    scopes.sync(agent)
    const name = tools.schemas(agent)[0].name
    expect(tools.schemas(other)).toHaveLength(0)
    const execute = () => tools.execute({ name, arguments: { task_ref: record.ref }, agent,
      callId: 'resume', signal: new AbortController().signal })
    resume.mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }], structuredContent: { count: 'bad' } })
    expect((await execute()).isError).toBe(true)
    resume.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'provider failed' }] })
    expect((await execute()).isError).toBe(true)
    resume.mockResolvedValueOnce({ content: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }], structuredContent: { count: 1 } })
    const image = await execute()
    expect(image.isError).toBe(false)
    expect(JSON.stringify(image.content)).toContain('image unavailable')
    expect(JSON.stringify(image.content)).not.toContain('YWJj')
    scopes.clear()
    expect(tools.schemas(agent)).toHaveLength(0)
    scope.rawDispose()
  } finally { await ctx.fiber.dispose() }
})
