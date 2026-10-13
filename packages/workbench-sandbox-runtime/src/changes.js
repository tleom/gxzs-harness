import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Config} from '@deepseek-ai/dsh-workspace-changes'
import {createChangesIo} from './changes-io.js'

export {Config}
export const name='workbench-workspace-changes'
export const inject=['subprocess','fs']

export async function apply(ctx,config) {
  const require=createRequire(import.meta.url)
  const entry=require.resolve('@deepseek-ai/dsh-workspace-changes')
  const {createWorkspaceChanges}=await import(pathToFileURL(join(dirname(entry),'gxzs-sandbox.js')).href)
  const signal=AbortSignal.timeout(30_000)
  const node=await ctx.subprocess.resolveExecutable(process.env.GXZS_SANDBOX_NODE || 'node',undefined,signal)
  const cwd=process.env.GXZS_SANDBOX_WORKSPACE || '/workspace'
  const probe=ctx.subprocess.spawn({
    argv:[node,'-e',"process.stdout.write(JSON.stringify({home:require('node:os').homedir(),tempRoot:require('node:os').tmpdir()}))"],
    cwd,signal,graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:16384},stderr:{maxBytes:4096}},
  })
  const result=await probe.done
  signal.throwIfAborted()
  const output=probe.collected.stdout?.readFrom(0)
  if(result.exitCode!==0||!output||output.lossy)throw new Error('Cannot resolve sandbox snapshot directories')
  const paths=JSON.parse(output.text)
  if(typeof paths.home!=='string'||!paths.home.startsWith('/')||typeof paths.tempRoot!=='string'||!paths.tempRoot.startsWith('/'))
    throw new Error('Invalid sandbox snapshot directories')
  const native=createWorkspaceChanges(createChangesIo(ctx.subprocess,{node,cwd,...paths}))
  return native.apply(ctx,config)
}
