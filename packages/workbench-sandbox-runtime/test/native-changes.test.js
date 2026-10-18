import {spawnSync} from 'node:child_process'
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {join,resolve,dirname} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {expect,it,vi} from 'vitest'
import {prepareWorkspaceChanges} from '../../../scripts/prepare-workspace-changes.mjs'
import {createChangesIo} from '../src/changes-io.js'

it.each([false,true])('preserves native events and historical comparison with git=%s',async(withGit)=>{
  await prepareWorkspaceChanges(resolve('profiles/workbench'))
  const runtimeRequire=createRequire(new URL('../src/changes.js',import.meta.url))
  const modulePath=join(dirname(runtimeRequire.resolve('@deepseek-ai/dsh-workspace-changes')),'gxzs-sandbox.js')
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
  const remove=io.rm
  let failRemoval=false,removalGate
  io.rm=async(...args)=>{
    if(failRemoval){failRemoval=false;throw Object.assign(new Error('Snapshot cleanup denied'),{code:'EACCES'})}
    if(removalGate)await removalGate.promise
    return remove(...args)
  }
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
    // A fork shares cwd/files, but native comparison captures belong to its own Session.
    const childEvents=[]
    const child={id:'fork',header:{cwd,parentSession:session.id,isSeeded:true},append(type,data){const event={type,data,seq:20+childEvents.length};childEvents.push(event);return event}}
    expect(service.summary(child.id,events[0].seq)).toBeUndefined()
    handlers.get('session/event')(child,{type:'turn/start',data:{turn:2}})
    const childExecution={agent:{session:child},name:'write',arguments:{file_path:'file.txt',content:'fork edit\n'}}
    await handlers.get('tools/pre-execute')(childExecution,async()=>{
      await handlers.get('fs/write-intent')(join(cwd,'file.txt'),childExecution,()=>undefined)
      await writeFile(join(cwd,'file.txt'),'fork edit\n')
    })
    handlers.get('session/event')(child,{type:'tool/result',seq:20,data:{turn:2}})
    await handlers.get('agent/turn-stopping')({agent:{session:child},turn:2})
    expect(service.summary(child.id,childEvents[0].seq)).toMatchObject({total:1,files:[{path:'file.txt'}]})
    const childDiff=await service.diff(child.id,childEvents[0].seq,0,new AbortController().signal)
    expect(childDiff.hunks[0].lines).toEqual(['-later edit','+fork edit'])
    expect((await service.diff(session.id,events[0].seq,0,new AbortController().signal)).hunks[0].lines).toEqual(['-before','+after'])
    const prefix=id=>'dsh-workspace-changes-'+createHash('sha256').update(id).digest('hex')+'-'
    expect((await readdir(tempRoot)).some(name=>name.startsWith(prefix(session.id)))).toBe(true)
    failRemoval=true
    handlers.get('session/disposed')(session)
    await vi.waitFor(()=>expect(warnings).toContain('workspace-changes cleanup failed'))
    expect(service.summary(session.id,events[0].seq)).toBeUndefined()
    removalGate=Promise.withResolvers()
    let deleted=false
    const deleting=service.deleteSessionPermanently(session.id).then(()=>{deleted=true})
    await new Promise(resolve=>setTimeout(resolve,10))
    expect(deleted).toBe(false)
    removalGate.resolve();await deleting;removalGate=undefined
    expect((await readdir(tempRoot)).some(name=>name.startsWith(prefix(session.id)))).toBe(false)
    expect(service.summary(child.id,childEvents[0].seq)).toBeDefined()
    // A new Host has no recorder for a crash residue, but can still erase only its exact identity.
    const cold=join(tempRoot,prefix('cold')+'Abc123')
    await mkdir(cold);await writeFile(join(cold,'private.txt'),'crash residue')
    await service.deleteSessionPermanently('cold')
    expect(await readdir(tempRoot)).not.toContain(cold.split(/[\\/]/).at(-1))
    expect((await readdir(tempRoot)).some(name=>name.startsWith(prefix(child.id)))).toBe(true)
  }finally{
    for(const cleanup of effects)await cleanup()
    await rm(cwd,{recursive:true,force:true})
  }
}, 15000)
