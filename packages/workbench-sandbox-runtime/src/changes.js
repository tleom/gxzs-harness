import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Config} from '@deepseek-ai/dsh-workspace-changes'
import {createChangesIo} from './changes-io.js'

export {Config}
export const name='workbench-workspace-changes'
export const inject=['subprocess','fs','ssh']
const snapshotPaths = {
  parse(value) {
    const {home,tempRoot} = value ?? {}
    if (typeof home !== 'string' || !home.startsWith('/') || typeof tempRoot !== 'string' || !tempRoot.startsWith('/'))
      throw new Error('Invalid sandbox snapshot directories')
    return {home,tempRoot}
  },
}

async function readSnapshotPaths(ssh, subprocess, node, cwd, signal) {
  try {
    return await ssh.request('workbench.snapshot-paths', {}, snapshotPaths, signal)
  } catch (error) {
    if (error?.message !== 'Unknown SSH helper operation: workbench.snapshot-paths') throw error
  }
  const probe=subprocess.spawn({
    argv:[node,'-e',"process.stdout.write(JSON.stringify({home:require('node:os').homedir(),tempRoot:require('node:os').tmpdir()}))"],
    cwd,signal,graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:16384},stderr:{maxBytes:4096}},
  })
  const result=await probe.done
  signal.throwIfAborted()
  const output=probe.collected.stdout?.readFrom(0)
  if(result.exitCode!==0||!output||output.lossy)throw new Error('Cannot resolve sandbox snapshot directories')
  return snapshotPaths.parse(JSON.parse(output.text))
}

export async function apply(ctx,config) {
  const require=createRequire(import.meta.url)
  const entry=require.resolve('@deepseek-ai/dsh-workspace-changes')
  const {createWorkspaceChanges}=await import(pathToFileURL(join(dirname(entry),'gxzs-sandbox.js')).href)
  const signal=AbortSignal.timeout(30_000)
  const node=await ctx.subprocess.resolveExecutable(process.env.GXZS_SANDBOX_NODE || 'node',undefined,signal)
  const cwd=process.env.GXZS_SANDBOX_WORKSPACE || '/workspace'
  const paths=await readSnapshotPaths(ctx.ssh,ctx.subprocess,node,cwd,signal)
  const native=createWorkspaceChanges(createChangesIo(ctx.subprocess,{node,cwd,...paths}))
  return native.apply(ctx,config)
}
