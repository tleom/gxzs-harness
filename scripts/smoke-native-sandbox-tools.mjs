#!/usr/bin/env node
// Requires an owner SSH fixture. Uses real DSH tools, no LLM or MCP service calls.
// Only a newly generated /tmp directory in the sandbox is written or removed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire('/opt/workbench/profiles/workbench/package.json')
const nativeVersion = JSON.parse(fs.readFileSync('/opt/workbench/profiles/workbench/node_modules/@deepseek-ai/dsh-ssh/package.json', 'utf8')).version
const native = async name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
const [{ Context }, { default: LlmRuntime }, { default: SessionStore }, { default: Projections }, { default: SystemPrompt }, { default: ToolRuntime },
  { default: SandboxPolicy }, { default: SshFileSystem }, { default: SshSandbox },
  { default: BashExecutor }, ShellEnv, BashTool, FsTools, SearchTools, { default: Jobs }, ToolJobs] = await Promise.all([
  native('cordis'), native('dsh-llm'), native('dsh-session'), native('dsh-session-projection'), native('dsh-system-prompt'), native('dsh-tools'),
  native('dsh-sandbox-policy'), native('dsh-fs-ssh'), native('dsh-sandbox-ssh'),
  native('dsh-bash-sandbox'), native('dsh-shell-env'), native('dsh-tool-bash'), native('dsh-tool-fs'), native('dsh-tool-fs-search'),
  native('dsh-jobs-local'), native('dsh-tool-jobs'),
])
const sourcePath = process.env.GXZS_PROBE_SSH_SOURCE || '/opt/workbench/packages/workbench-sandbox-runtime/src/ssh.js'
const source = fs.readFileSync(sourcePath, 'utf8').replace("from '@deepseek-ai/dsh-ssh'", `from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-ssh')).href)}`)
const { default: WorkbenchSsh } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const { default: WorkbenchSubprocess } = await import('/opt/workbench/packages/workbench-sandbox-runtime/src/subprocess.js')
const directory = `/tmp/gxzs-native-tools-${randomUUID()}`
const sustainedSeconds = Number(process.env.GXZS_SMOKE_LONG_SECONDS ?? 70)
assert.ok(Number.isInteger(sustainedSeconds) && sustainedSeconds >= 10 && sustainedSeconds <= 7200 && sustainedSeconds % 10 === 0,
  'GXZS_SMOKE_LONG_SECONDS must be a multiple of 10 between 10 and 7200')
assert.match(directory, /^\/tmp\/gxzs-native-tools-[0-9a-f-]{36}$/)
assert.equal(fs.existsSync(directory), false)
const ctx = new Context()
ctx.provide('workingDirectory', { ensure: async () => directory, get: () => directory })
let ssh
let created = false
let stage = 'bootstrap'
let failure
let failureType
let failureCode
const checked = []
let sustained
let changes
const plugin = async (stageName, implementation, config) => {
  stage = stageName
  await ctx.plugin(implementation, config)
}
const text = result => (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
const execute = async (name, args) => {
  stage = name
  const result = await ctx.tools.execute({ callId: `fixture-${randomUUID()}`, name, arguments: args, signal: AbortSignal.timeout(Math.max(20_000, (args.timeoutMs ?? args.timeout_ms ?? 0) + 10_000)) })
  if (result.isError) console.log(JSON.stringify({ event: 'fixture_tool_failed', tool: name,
    timed_out: /timeout|timed out/i.test(text(result)), disconnected: /disconnect|socket|connection/i.test(text(result)) }))
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
  await plugin('jobs', Jobs)
  await plugin('tool-jobs', ToolJobs)
  await plugin('bash-tool', BashTool)
  await plugin('fs-tools', FsTools)
  await plugin('search-tools', SearchTools, { sampleOverCapGlobResults: false })
  await execute('bash', { command: `mkdir -m 700 -- '${directory}'`, description: 'Create isolated tool fixture', workdir: '/tmp', timeoutMs: 10_000 })
  created = true
  if (process.argv.includes('--changes-check')) {
    stage = 'native-changes'
    let recorder
    if(process.env.GXZS_PROBE_CHANGES_IO && process.env.GXZS_PROBE_CHANGES_FACTORY){
      const {createChangesIo}=await import(pathToFileURL(process.env.GXZS_PROBE_CHANGES_IO).href)
      const factorySource=fs.readFileSync(process.env.GXZS_PROBE_CHANGES_FACTORY,'utf8').replace(/from "([^"]+)"/g,(match,specifier)=>specifier.startsWith('node:')?match:`from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`)
      const {createWorkspaceChanges}=await import(`data:text/javascript;base64,${Buffer.from(factorySource).toString('base64')}`)
      const io=createChangesIo(ctx.subprocess,{node:process.env.GXZS_SANDBOX_NODE || '/usr/local/bin/node',cwd:directory,home:'/home/dify',tempRoot:'/tmp'})
      recorder=createWorkspaceChanges(io)
    }else{
      // Exercise the installed wrapper and its generated native factory in the built image.
      recorder=await import('/opt/workbench/packages/workbench-sandbox-runtime/src/changes.js')
    }
    const callbacks=new Map(),effects=[],records=[],warnings=[]
    let service
    const session={id:`probe-${randomUUID()}`,header:{cwd:directory},append(type,data){const event={type,data,seq:records.length+1};records.push(event);return event}}
    await recorder.apply({subprocess:ctx.subprocess,fs:ctx.fs,logger:{info(){},warn:message=>warnings.push(message)},on:(name,fn)=>callbacks.set(name,fn),provide:(_,value)=>service=value,effect:fn=>effects.push(fn())},
      {timeoutMs:30000,outputMaxBytes:8388608,maxFiles:500,maxFileBytes:2097152,diffTimeoutMs:100})
    try {
      const source=`${directory}/changes.txt`
      await execute('write',{file_path:source,content:'before\n'})
      callbacks.get('session/event')(session,{type:'turn/start',data:{turn:1}})
      const actor={agent:{session},name:'write',arguments:{file_path:source,content:'after\n'}}
      await callbacks.get('tools/pre-execute')(actor,async()=>{
        await callbacks.get('fs/write-intent')(source,actor,()=>undefined)
        return execute('write',{file_path:source,content:'after\n'})
      })
      callbacks.get('session/event')(session,{type:'tool/result',seq:10,data:{turn:1}})
      await callbacks.get('agent/turn-stopping')({agent:{session},turn:1})
      stage='changes-summary'
      assert.equal(warnings.length,0);assert.equal(records.length,1)
      const summary=service.summary(session.id,records[0].seq)
      assert.equal(summary.total,1);assert.equal(summary.added,1);assert.equal(summary.deleted,1)
      await execute('write',{file_path:source,content:'later\n'})
      stage='changes-diff'
      const diff=await service.diff(session.id,records[0].seq,0,AbortSignal.timeout(30000))
      assert.deepEqual(diff.hunks[0].lines,['-before','+after'])
      assert.equal(fs.existsSync(directory),false)
      changes={recorder_version:nativeVersion,summary:true,historical_diff:true,host_files_absent:true}
    } finally {for(const cleanup of effects)await cleanup()}
  }
  if (process.argv.includes('--long-check')) {
    const started = Date.now()
    const iterations = sustainedSeconds / 10
    console.log(JSON.stringify({ event: 'sustained_probe_started', concurrent_jobs: 2, seconds_per_job: sustainedSeconds, lease_ms: 30000 }))
    await Promise.all(['A', 'B'].map(async label => {
      const result = await execute('bash', { command: `i=0; while test "$i" -lt ${iterations}; do i=$((i + 1)); printf '%s\\n' "$i" >> '${directory}/${label}'; sleep 10; done; test "$(wc -l < '${directory}/${label}')" -eq ${iterations} && printf 'finished-${label}'`,
        description: 'Isolated sustained concurrency probe', workdir: directory, run_in_background: true })
      assert.equal(result.value?.kind, 'background')
      const jobId = result.value.jobId
      let output = ''
      while (true) {
        assert.ok(Date.now() - started < sustainedSeconds * 1000 + 55_000, 'fixture_job_deadline')
        const read = await execute('job_output', { job_id: jobId, wait: true, timeout_ms: 60_000 })
        output += text(read)
        const status = read.value?.job?.status
        console.log(JSON.stringify({ event: 'sustained_job_observed', label, status, elapsed_ms: Date.now() - started }))
        if (status === 'running' || status === 'stopping') continue
        assert.equal(status, 'completed')
        assert.match(output, new RegExp(`finished-${label}`))
        break
      }
    }))
    sustained = { concurrent_jobs: 2, seconds_per_job: sustainedSeconds, elapsed_ms: Date.now() - started }
    assert.ok(sustained.elapsed_ms >= sustainedSeconds * 1000 - 5000 && sustained.elapsed_ms < sustainedSeconds * 1000 + 55_000, 'fixture_jobs_not_concurrent')
  }
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
  native_version: nativeVersion, tools: [...new Set(checked)], sandbox_uid: !failure ? 1000 : undefined,
  ...(sustained ? { sustained } : {}),
  ...(changes ? { changes } : {}),
  host_fixture_absent: !fs.existsSync(directory), fixture_directory_sha256: createHash('sha256').update(directory).digest('hex'),
  fixture_removed: created && !failure, model_calls: 0, mcp_calls: 0 }))
