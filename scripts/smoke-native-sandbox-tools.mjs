#!/usr/bin/env node
// Requires an owner SSH fixture. Uses real DSH tools, no LLM or MCP service calls.
// Only a newly generated /tmp directory in the sandbox is written or removed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire('/opt/workbench/profiles/workbench/package.json')
const native = async name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { default: LlmRuntime }, { default: SessionStore }, { default: Projections }, { default: SystemPrompt }, { default: ToolRuntime },
  { default: SandboxPolicy }, { default: SshFileSystem }, { default: SshSandbox },
  { default: BashExecutor }, ShellEnv, BashTool, FsTools, SearchTools] = await Promise.all([
  native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'), native('dsh-system-prompt'), native('dsh-tools'),
  native('dsh-sandbox-policy'), native('dsh-fs-ssh'), native('dsh-sandbox-ssh'),
  native('dsh-bash-sandbox'), native('dsh-shell-env'), native('dsh-tool-bash'), native('dsh-tool-fs'), native('dsh-tool-fs-search'),
])
const sourcePath = process.env.GXZS_PROBE_SSH_SOURCE || '/opt/workbench/packages/workbench-sandbox-runtime/src/ssh.js'
const source = fs.readFileSync(sourcePath, 'utf8').replace("from '@deepseek-ai/dsh-ssh'", `from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-ssh')).href)}`)
const { default: WorkbenchSsh } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const { default: WorkbenchSubprocess } = await import('/opt/workbench/packages/workbench-sandbox-runtime/src/subprocess.js')
const directory = `/tmp/gxzs-native-tools-${randomUUID()}`
assert.match(directory, /^\/tmp\/gxzs-native-tools-[0-9a-f-]{36}$/)
assert.equal(fs.existsSync(directory), false)
const ctx = new Context()
let ssh
let created = false
let stage = 'bootstrap'
let failure
let failureType
let failureCode
const checked = []
const plugin = async (stageName, implementation, config) => {
  stage = stageName
  await ctx.plugin(implementation, config)
}
const text = result => (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const execute = async (name, args) => {
  stage = name
  const result = await ctx.tools.execute({ callId: `fixture-${randomUUID()}`, name, arguments: args, signal: AbortSignal.timeout(20_000) })
  assert.notEqual(result.isError, true, `fixture_${name}_failed`)
  checked.push(name)
  return result
}
try {
  await plugin('llm-runtime', LlmRuntime)
  await plugin('session-store', SessionStore)
  await plugin('session-projections', Projections)
  await plugin('system-prompt', SystemPrompt)
  await plugin('tool-runtime', ToolRuntime)
  await plugin('sandbox-policy', SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: directory })
  stage = 'ssh-create'
  ssh = new WorkbenchSsh(ctx, {
    host: process.env.GXZS_SANDBOX_SSH_HOST,
    node: process.env.GXZS_SANDBOX_NODE || '/usr/local/bin/node',
    helper: process.env.GXZS_SANDBOX_HELPER || '/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
    helperHash: process.env.GXZS_SANDBOX_HELPER_HASH,
    workspace: '/workspace', requestTimeoutMs: 10_000,
    maxFrameBytes: 67_108_864, maxPending: 128, leaseMs: 30_000,
  })
  stage = 'ssh-ready'
  await ssh.ready
  await plugin('ssh-filesystem', SshFileSystem)
  await plugin('ssh-sandbox', SshSandbox)
  await plugin('subprocess', WorkbenchSubprocess, { ripgrepExecutable: process.env.GXZS_SANDBOX_RG || '/usr/bin/rg' })
  await plugin('bash-executor', BashExecutor)
  await plugin('shell-env', ShellEnv)
  await plugin('bash-tool', BashTool, { enableRunInBackground: false })
  await plugin('fs-tools', FsTools)
  await plugin('search-tools', SearchTools, { sampleOverCapGlobResults: false })
  await execute('bash', { command: `mkdir -m 700 -- '${directory}'`, description: 'Create isolated tool fixture', workdir: '/tmp', timeoutMs: 10_000 })
  created = true
  const file = `${directory}/fixture.txt`
  await execute('write', { file_path: file, content: 'alpha marker\nfixture-only\n' })
  assert.match(text(await execute('read', { file_path: file })), /alpha marker/)
  await execute('edit', { file_path: file, old_string: 'alpha marker', new_string: 'beta marker' })
  assert.match(text(await execute('read', { file_path: file })), /beta marker/)
  assert.match(text(await execute('glob', { pattern: '*.txt', path: directory })), /fixture\.txt/)
  assert.match(text(await execute('grep', { pattern: 'beta marker', path: directory, include: '*.txt' })), /beta marker/)
  const identity = text(await execute('bash', {
    command: "printf 'fixture-uid='; id -u; awk '/^CapEff:/{print \"fixture-cap=\" $2}' /proc/self/status; test ! -e /var/run/docker.sock && printf 'fixture-no-docker\n'",
    description: 'Verify sandbox identity and isolation', workdir: directory, timeoutMs: 10_000,
  }))
  assert.match(identity, /fixture-uid=1000/)
  assert.match(identity, /fixture-cap=0{16}/)
  assert.match(identity, /fixture-no-docker/)
  assert.equal(fs.existsSync(directory), false, 'Sandbox fixture must remain invisible on the host')
} catch (error) {
  failure = stage
  failureType = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'AssertionError'].includes(error?.name) ? error.name : 'Other'
  failureCode = ['ERR_ASSERTION', 'ENOENT', 'EACCES', 'ECONNREFUSED', 'ETIMEDOUT', 'UNSUPPORTED_SCHEMA'].includes(error?.code) ? error.code : undefined
  process.exitCode = 1
} finally {
  if (created) {
    try {
      await execute('bash', { command: `rm -rf -- '${directory}' && test ! -e '${directory}'`, description: 'Remove isolated tool fixture', workdir: '/tmp', timeoutMs: 10_000 })
    } catch { failure ||= 'cleanup'; process.exitCode = 1 }
  }
  try { await ctx.fiber.dispose() } catch { failure ||= 'context-dispose'; process.exitCode = 1 }
  try { await ssh?.dispose() } catch { failure ||= 'ssh-dispose'; process.exitCode = 1 }
}
console.log(JSON.stringify({ passed: !failure, ...(failure ? { failed_stage: failure, error_type: failureType, error_code: failureCode } : {}),
  native_version: '0.1.6-alpha.2', tools: [...new Set(checked)], sandbox_uid: !failure ? 1000 : undefined,
  host_fixture_absent: !fs.existsSync(directory), fixture_directory_sha256: createHash('sha256').update(directory).digest('hex'),
  fixture_removed: created && !failure, model_calls: 0, mcp_calls: 0 }))
