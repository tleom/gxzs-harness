import {spawnSync} from 'node:child_process'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterEach,expect,it,vi} from 'vitest'
import {captureWorkspaceFile} from '../src/changes-capture.js'

const dirs=[]
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true})})
async function fixture(){
  const cwd=await mkdtemp(join(process.cwd(),'.capture-test-'));dirs.push(cwd)
  const runtime={spawn:vi.fn(spec=>{
    const result=spawnSync(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,input:spec.stdio.stdin.data,encoding:'utf8'})
    if(result.error)throw result.error
    return {done:Promise.resolve({exitCode:result.status}),collected:{stdout:{readFrom:()=>({text:result.stdout,lossy:false})}}}
  })}
  const args={node:process.execPath,cwd,absolute:join(cwd,'source'),directory:join(cwd,'snapshots'),maxBytes:16}
  return {runtime,args}
}
it('captures immutable bytes through the subprocess provider',async()=>{
  const {runtime,args}=await fixture()
  await writeFile(args.absolute,'first')
  const first=await captureWorkspaceFile(runtime,args)
  await writeFile(args.absolute,'second')
  const second=await captureWorkspaceFile(runtime,args)
  expect(first.file).not.toBe(second.file)
  expect(await readFile(first.file,'utf8')).toBe('first')
  expect(await readFile(second.file,'utf8')).toBe('second')
  expect(first.binary).toBe(false)
  expect(runtime.spawn.mock.calls[0][0].cwd).toBe(args.cwd)
})
it('distinguishes missing, binary, oversized and non-file sources',async()=>{
  const {runtime,args}=await fixture()
  expect(await captureWorkspaceFile(runtime,args)).toEqual({kind:'absent'})
  await writeFile(args.absolute,Buffer.from([0,1,2]))
  expect(await captureWorkspaceFile(runtime,args)).toMatchObject({kind:'file',binary:true})
  await writeFile(args.absolute,Buffer.alloc(17))
  expect(await captureWorkspaceFile(runtime,args)).toEqual({kind:'oversized'})
  expect(await captureWorkspaceFile(runtime,{...args,absolute:args.cwd})).toBeUndefined()
})
it('rejects invalid bounds and cancellation before spawning',async()=>{
  const {runtime,args}=await fixture()
  await expect(captureWorkspaceFile(runtime,{...args,maxBytes:-1})).rejects.toThrow('byte limit')
  await expect(captureWorkspaceFile(runtime,{...args,signal:AbortSignal.abort()})).rejects.toThrow()
  expect(runtime.spawn).not.toHaveBeenCalled()
})
