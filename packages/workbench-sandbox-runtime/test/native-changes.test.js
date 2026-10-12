import {spawnSync} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {expect,it} from 'vitest'
import {prepareWorkspaceChanges} from '../../../scripts/prepare-workspace-changes.mjs'
import {createChangesIo} from '../src/changes-io.js'

it.each([false,true])('preserves native events and historical comparison with git=%s',async(withGit)=>{
  const modulePath=await prepareWorkspaceChanges(resolve('profiles/workbench'))
  const {createWorkspaceChanges}=await import(/* @vite-ignore */pathToFileURL(modulePath).href)
  const cwd=await mkdtemp(join(process.cwd(),'.native-changes-test-'))
  const tempRoot=join(cwd,'scratch');await mkdir(tempRoot)
  if(withGit){const init=spawnSync('git',['init'],{cwd,encoding:'utf8'});if(init.status!==0)throw new Error(init.stderr)}
  const handlers=new Map(),events=[],warnings=[],effects=[]
  let service
  const subprocess={resolveExecutable:async()=>{if(withGit)return 'git';throw new Error('Git unavailable for non-repository test')},spawn(spec){
    const result=spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,input:spec.stdio.stdin.data,encoding:'utf8',env:{...process.env,...spec.env},maxBuffer:16*1024*1024})
    if(result.error)throw result.error
    return {done:Promise.resolve({exitCode:result.status}),collected:{stdout:{readFrom:()=>({text:result.stdout,lossy:false})}}}
  }}
  const io=createChangesIo(subprocess,{node:process.execPath,cwd,home:cwd,tempRoot})
  const native=createWorkspaceChanges(io)
  const session={id:'session',header:{cwd},append(type,data){const event={type,data,seq:events.length+1};events.push(event);return event}}
  const ctx={subprocess,fs:{processPath:target=>target},logger:{info(){},warn:message=>warnings.push(message)},on:(name,fn)=>handlers.set(name,fn),provide:(_,value)=>service=value,effect:fn=>effects.push(fn())}
  try{
    native.apply(ctx,{timeoutMs:30000,outputMaxBytes:8388608,maxFiles:500,maxFileBytes:2097152,diffTimeoutMs:100})
    await writeFile(join(cwd,'file.txt'),'before\n')
    handlers.get('session/event')(session,{type:'turn/start',data:{turn:1}})
    const execution={agent:{session},name:'write',arguments:{file_path:'file.txt',content:'after\n'}}
    await handlers.get('tools/pre-execute')(execution,async()=>{
      await handlers.get('fs/write-intent')(join(cwd,'file.txt'),execution,()=>undefined)
      await writeFile(join(cwd,'file.txt'),'after\n')
    })
    handlers.get('session/event')(session,{type:'tool/result',seq:10,data:{turn:1}})
    await handlers.get('agent/turn-stopping')({agent:{session},turn:1})
    expect(warnings).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({type:'workspace/changes',data:{turn:1}})
    const summary=service.summary('session',events[0].seq)
    expect(summary).toMatchObject({total:1,added:1,deleted:1,files:[{path:'file.txt'}]})
    await writeFile(join(cwd,'file.txt'),'later edit\n')
    const diff=await service.diff('session',events[0].seq,0,new AbortController().signal)
    expect(diff.kind).toBe('text')
    expect(diff.hunks[0].lines).toEqual(['-before','+after'])
  }finally{
    for(const cleanup of effects)await cleanup()
    await rm(cwd,{recursive:true,force:true})
  }
}, 15000)
