import {spawnSync} from 'node:child_process'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {createChangesIo} from '../src/changes-io.js'

it('creates, copies, resolves, reads and cleans scratch data through the provider',async()=>{
  const cwd=await mkdtemp(join(process.cwd(),'.changes-io-test-'))
  const specs=[]
  const runtime={spawn(spec){
    specs.push(spec)
    const result=spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,input:spec.stdio.stdin.data,encoding:'utf8'})
    if(result.error)throw result.error
    return {done:Promise.resolve({exitCode:result.status}),collected:{stdout:{readFrom:()=>({text:result.stdout,lossy:false})}}}
  }}
  const io=createChangesIo(runtime,{node:process.execPath,cwd,home:cwd,tempRoot:cwd})
  try{
    const scratch=await io.mkdtemp(join(cwd,'scratch-'))
    await writeFile(join(cwd,'index'),'snapshot index')
    await io.copyFile(join(cwd,'index'),join(scratch,'index'))
    expect(await io.readFile(join(scratch,'index'),'utf8')).toBe('snapshot index')
    expect(await io.realpath(scratch)).toBe(scratch)
    const captured=await io.captureFile(join(cwd,'index'),join(scratch,'captures'),100)
    expect(await io.readFile(captured.file,'utf8')).toBe('snapshot index')
    await io.rm(scratch,{recursive:true,force:true})
    await expect(io.readFile(captured.file,'utf8')).rejects.toMatchObject({code:'ENOENT'})
    expect(specs.every(spec=>spec.cwd===cwd)).toBe(true)
  }finally{await rm(cwd,{recursive:true,force:true})}
})
