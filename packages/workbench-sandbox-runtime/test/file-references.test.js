import {PassThrough} from 'node:stream'
import {expect,it,vi} from 'vitest'
import {SandboxReferenceSearch} from '../src/file-references.js'
const options=()=>({root:'/workspace/conversations/example',config:{maxResults:20,maxEntries:50000,excludedDirectories:[]}})
function runtime(){
 const messages=[],stdin=new PassThrough(),stdout=new PassThrough()
 let end
 const done=new Promise(resolve=>{end=resolve})
 stdin.on('data',chunk=>messages.push(JSON.parse(chunk.toString())))
 const spawn=vi.fn(spec=>{spec.signal.addEventListener('abort',()=>end({exitCode:1}),{once:true});return {stdin,stdout,done}})
 return {spawn,messages,stdout,end,reply(id,candidates){stdout.write(JSON.stringify({id,candidates})+'\n')}}
}
it('reuses one process and routes concurrent native candidates by request id',async()=>{
 const provider=runtime(),search=new SandboxReferenceSearch(provider,options())
 try{
  const first=search.list('材料',new AbortController().signal)
  const second=search.list('材料\"; $(echo unsafe)',new AbortController().signal)
  provider.reply(2,[{kind:'file',path:'案件材料.pdf'}]);provider.reply(1,[])
  expect(await first).toEqual([]);expect(await second).toEqual([{kind:'file',path:'案件材料.pdf'}])
  expect(provider.spawn).toHaveBeenCalledTimes(1)
  expect(provider.spawn.mock.calls[0][0].argv).not.toContain(provider.messages[1].query)
  search.invalidate();expect(provider.messages.at(-1)).toEqual({op:'invalidate'})
 }finally{search.dispose();await search.done}
})
it('rejects out-of-workspace paths before spawning',()=>{
 const provider=runtime()
 for(const root of ['/etc','/workspace-other','/workspace/../etc'])expect(()=>new SandboxReferenceSearch(provider,{...options(),root})).toThrow('outside')
 expect(provider.spawn).not.toHaveBeenCalled()
})
it('observes provider termination when pipes are unavailable',async()=>{
 let reject
 const done=new Promise((_,fail)=>{reject=fail})
 const provider={spawn:()=>({done})}
 expect(()=>new SandboxReferenceSearch(provider,options())).toThrow('pipes unavailable')
 reject(new Error('provider failed'))
 await Promise.resolve();await Promise.resolve()
})
it('closes a broken invalidation transport without throwing into tool-result dispatch',async()=>{
 const provider=runtime(),search=new SandboxReferenceSearch(provider,options())
 const rejected=expect(search.list('evidence',new AbortController().signal)).rejects.toThrow('broken pipe')
 vi.spyOn(search.handle.stdin,'write').mockImplementation(()=>{throw new Error('broken pipe')})
 expect(()=>search.invalidate()).not.toThrow()
 await rejected;await search.done
 expect(search.closed).toBe(true)
})
it('cancels a caller without aborting the shared process or another request',async()=>{
 const provider=runtime(),search=new SandboxReferenceSearch(provider,options()),controller=new AbortController()
 try{
  const first=search.list('old',controller.signal);const rejected=expect(first).rejects.toThrow()
  const next=search.list('new',new AbortController().signal)
  controller.abort();await rejected
  expect(provider.messages.at(-1)).toEqual({op:'cancel',id:1})
  expect(provider.spawn.mock.calls[0][0].signal.aborted).toBe(false)
  provider.reply(1,[]);provider.reply(2,[{path:'new.md',kind:'file'}])
  expect(await next).toHaveLength(1)
  expect(()=>search.list('aborted',AbortSignal.abort())).toThrow()
 }finally{search.dispose();await search.done}
})
it('rejects every pending request on disconnect and closes the transport',async()=>{
 const provider=runtime(),search=new SandboxReferenceSearch(provider,options())
 const a=expect(search.list('a',new AbortController().signal)).rejects.toThrow('exited')
 const b=expect(search.list('b',new AbortController().signal)).rejects.toThrow('exited')
 provider.end({exitCode:1});await Promise.all([a,b,search.done]);expect(search.closed).toBe(true)
 expect(provider.spawn.mock.calls[0][0].signal.aborted).toBe(true)
})
it('rejects malformed and oversized replies rather than returning incomplete candidates',async()=>{
 for(const data of ['{broken}\n',JSON.stringify({id:1,candidates:{}})+'\n','a'.repeat(1024*1024+1)]){
  const provider=runtime(),search=new SandboxReferenceSearch(provider,options())
  const rejected=expect(search.list('a',new AbortController().signal)).rejects.toThrow()
  provider.stdout.write(data);await rejected;await search.done;expect(search.closed).toBe(true)
 }
})
it('times out one request while preserving the shared index',async()=>{
 vi.useFakeTimers()
 const provider=runtime(),search=new SandboxReferenceSearch(provider,options())
 try{
  const rejected=expect(search.list('a',new AbortController().signal)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(30000);await rejected
  expect(search.closed).toBe(false);expect(provider.messages.at(-1).op).toBe('cancel')
 }finally{search.dispose();await search.done;vi.useRealTimers()}
})
