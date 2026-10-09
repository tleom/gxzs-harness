import {posix} from 'node:path'
import LocalFileReferences, {
  DEFAULT_FILE_SEARCH_MAX_RESULTS, DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
} from '@deepseek-ai/dsh-file-reference-local'

// Keep the upstream index in the sandbox. The bridge carries queries and path
// candidates only; grammar, ranking, traversal and stale refresh remain DSH's.
export const SEARCH_SOURCE = String.raw`
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const {createInterface}=require('node:readline');
const resolve=createRequire('/opt/dsh/package.json');
const ready=import(pathToFileURL(resolve.resolve('@deepseek-ai/dsh-file-reference-local')).href)
  .then(({WorkspaceFileSearch})=>new WorkspaceFileSearch(process.cwd(),JSON.parse(process.argv[1])));
const requests=new Map();
let closed=false;
function reply(value){if(!closed)process.stdout.write(JSON.stringify(value)+'\n')}
async function dispatch(message){
  if(message.op==='cancel'){requests.get(message.id)?.abort();return}
  if(message.op==='invalidate'){(await ready).invalidate();return}
  if(message.op!=='list'||typeof message.query!=='string')throw new Error('Invalid reference request');
  const controller=new AbortController();requests.set(message.id,controller);
  try{
    const search=await ready;
    const candidates=await search.list(message.query,controller.signal);
    reply({id:message.id,candidates});
  }catch(error){reply({id:message.id,error:error.message})}
  finally{requests.delete(message.id)}
}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{
  try{
    if(Buffer.byteLength(line)>1024*1024)throw new Error('Reference request too large');
    void dispatch(JSON.parse(line)).catch(error=>{process.stderr.write(error.message);process.exit(1)});
  }catch(error){process.stderr.write(error.message);process.exit(1)}
});
lines.on('close',()=>{
  closed=true;for(const controller of requests.values())controller.abort();
  void ready.then(search=>search.dispose(),()=>{});
});
ready.catch(error=>{process.stderr.write(error.message);process.exit(1)});
`

/** One native index per agent, transported by the existing DSH subprocess. */
export class SandboxReferenceSearch {
  constructor(subprocess,{root,config={},node='/usr/local/bin/node',workspace='/workspace'}) {
    if(typeof root!=='string'||!posix.isAbsolute(root)||
      (posix.resolve(root)!==posix.resolve(workspace)&&!posix.resolve(root).startsWith(`${posix.resolve(workspace)}/`)))
      throw new Error('File reference workspace is outside the owner sandbox')
    this.pending=new Map()
    this.sequence=0
    this.buffer=''
    this.closed=false
    this.lifetime=new AbortController()
    const options={
      maxResults:config.maxResults??DEFAULT_FILE_SEARCH_MAX_RESULTS,
      maxEntries:config.maxEntries??DEFAULT_FILE_SEARCH_MAX_ENTRIES,
      excludedDirectories:config.excludedDirectories??DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
    }
    this.handle=subprocess.spawn({argv:[node,'-e',SEARCH_SOURCE,JSON.stringify(options)],cwd:root,
      signal:this.lifetime.signal,graceMs:1000,
      stdio:{stdin:'pipe',stdout:'pipe',stderr:{maxBytes:4096}}})
    // Observe termination even when the provider cannot expose its pipes.
    this.done=this.handle.done.then(
      ()=>this.dispose(new Error('Sandbox reference process exited')),
      ()=>this.dispose(new Error('Sandbox reference transport disconnected')),
    )
    if(!this.handle.stdin||!this.handle.stdout){this.dispose();throw new Error('Sandbox reference pipes unavailable')}
    this.handle.stdout.setEncoding('utf8')
    this.handle.stdout.on('data',chunk=>this.receive(chunk))
    this.handle.stdout.on('error',()=>this.dispose(new Error('Sandbox reference transport failed')))
    this.handle.stdin.on('error',()=>this.dispose(new Error('Sandbox reference transport failed')))
  }
  send(value) {
    if(this.closed)throw new Error('Sandbox reference search is closed')
    const line=JSON.stringify(value)+'\n'
    if(Buffer.byteLength(line)>1024*1024)throw new Error('File reference request too large')
    this.handle.stdin.write(line)
  }
  receive(chunk) {
    if(this.closed)return
    this.buffer+=chunk
    let newline
    while((newline=this.buffer.indexOf('\n'))>=0) {
      const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1)
      if(Buffer.byteLength(line)>1024*1024){this.dispose(new Error('Sandbox reference response too large'));return}
      try {
        const result=JSON.parse(line)
        const pending=this.pending.get(result.id)
        if(!pending)continue // A cancelled request may already have returned.
        if(result.error)pending.reject(new Error('Sandbox file reference search failed'))
        else if(!Array.isArray(result.candidates))throw new Error('Invalid sandbox file reference response')
        else pending.resolve(result.candidates)
      }catch(error){this.dispose(error);return}
    }
    if(Buffer.byteLength(this.buffer)>1024*1024)this.dispose(new Error('Sandbox reference response too large'))
  }
  list(query,signal) {
    signal.throwIfAborted()
    if(this.closed)return Promise.reject(new Error('Sandbox reference search is closed'))
    if(this.pending.size>=64)return Promise.reject(new Error('Too many file reference requests'))
    const id=++this.sequence
    return new Promise((resolve,reject)=>{
      let timer
      const finish=(callback,value)=>{
        clearTimeout(timer);signal.removeEventListener('abort',cancel);this.pending.delete(id);callback(value)
      }
      const cancel=()=>{
        try{this.send({op:'cancel',id})}catch{}
        finish(reject,signal.reason||new Error('File reference request timed out'))
      }
      this.pending.set(id,{resolve:value=>finish(resolve,value),reject:error=>finish(reject,error)})
      signal.addEventListener('abort',cancel,{once:true})
      timer=setTimeout(cancel,30_000)
      try{this.send({op:'list',id,query})}catch(error){finish(reject,error)}
    })
  }
  invalidate(){
    if(this.closed)return
    try{this.send({op:'invalidate'})}catch(error){this.dispose(error)}
  }
  dispose(error=new Error('Sandbox reference search disposed')) {
    if(this.closed)return
    this.closed=true
    for(const pending of this.pending.values())pending.reject(error)
    this.pending.clear();this.buffer='';this.lifetime.abort(error)
  }
}

// Inherit upstream prompt installation and identity. Mirror its agent/session
// lifecycle for the sandbox-side cache instead of indexing the host cwd.
export default class SandboxFileReferences extends LocalFileReferences {
  static inject=['agents','subprocess']
  constructor(ctx,config) {
    super(ctx,config)
    this.searchConfig=config
    this.remoteSearches=new Map()
    this.stopped=false
    ctx.on('agent/disposed',async({agent})=>{
      const search=this.remoteSearches.get(agent)
      this.remoteSearches.delete(agent)
      search?.dispose()
      await search?.done
    })
    ctx.on('session/event',(session,event)=>{
      if(event.type==='tool/result')this.remoteSearches.get(ctx.agents.get(session.id))?.invalidate()
    })
    ctx.effect(()=>async()=>{
      this.stopped=true
      const searches=[...this.remoteSearches.values()]
      for(const search of searches)search.dispose()
      this.remoteSearches.clear()
      await Promise.all(searches.map(search=>search.done))
    })
  }
  list(agent,query,signal) {
    signal.throwIfAborted()
    if(this.stopped)return Promise.reject(new Error('Sandbox reference service disposed'))
    let search=this.remoteSearches.get(agent)
    if(!search||search.closed) {
      search=new SandboxReferenceSearch(this.ctx.subprocess,{
        root:agent.session.header.cwd,config:this.searchConfig,
        node:process.env.GXZS_SANDBOX_NODE||'/usr/local/bin/node',
        workspace:process.env.GXZS_SANDBOX_WORKSPACE||'/workspace',
      })
      this.remoteSearches.set(agent,search)
    }
    return search.list(query,signal)
  }
}
