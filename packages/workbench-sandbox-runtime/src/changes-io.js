import {captureWorkspaceFile} from './changes-capture.js'

const SOURCE=String.raw`
const fs=require('node:fs/promises');
(async()=>{
  let input='';for await(const chunk of process.stdin)input+=chunk;
  const {operation,args}=JSON.parse(input);
  if(!['copyFile','mkdir','mkdtemp','readdir','readFile','realpath','rm'].includes(operation))throw new Error('Unsupported snapshot operation');
  if(operation==='readFile'){
    const handle=await fs.open(args[0],'r');
    try{
      const max=2*1024*1024;
      const buffer=Buffer.allocUnsafe(max+1);let count=0;
      while(count<buffer.length){const result=await handle.read(buffer,count,buffer.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}
      if(count>max)throw Object.assign(new Error('Snapshot exceeds comparison limit'),{code:'EFBIG'});
      return buffer.subarray(0,count).toString('utf8');
    }finally{await handle.close();}
  }
  return await fs[operation](...args);
})().then(value=>process.stdout.write(JSON.stringify({value})),error=>{
  process.stdout.write(JSON.stringify({error:{message:error.message,code:error.code}}));process.exitCode=1;
});`

/** All native scratch/index/capture paths are interpreted by the sandbox provider. */
export function createChangesIo(subprocess,{node,cwd,home,tempRoot,signal}) {
  const call=async(operation,args,requestSignal)=>{
    const abort=AbortSignal.any([AbortSignal.timeout(30_000),...[signal,requestSignal].filter(Boolean)])
    abort.throwIfAborted()
    const handle=subprocess.spawn({argv:[node,'-e',SOURCE],cwd,signal:abort,graceMs:1000,
      stdio:{stdin:{data:JSON.stringify({operation,args})},stdout:{maxBytes:16*1024*1024},stderr:{maxBytes:4096}}})
    const outcome=await handle.done;abort.throwIfAborted()
    const output=handle.collected.stdout?.readFrom(0)
    if(!output||output.lossy)throw new Error('Snapshot operation response missing or truncated')
    const result=JSON.parse(output.text)
    if(result.error)throw Object.assign(new Error(result.error.message),{code:result.error.code})
    if(outcome.exitCode!==0)throw new Error('Snapshot operation failed')
    return result.value
  }
  return {
    homedir:()=>home,tmpdir:()=>tempRoot,
    realpath:path=>call('realpath',[path]),
    mkdir:(path,options)=>call('mkdir',[path,options]),
    mkdtemp:prefix=>call('mkdtemp',[prefix]),
    readdir:path=>call('readdir',[path]),
    copyFile:(from,to)=>call('copyFile',[from,to]),
    rm:(path,options)=>call('rm',[path,options]),
    readFile:(path,options)=>call('readFile',[path],typeof options==='object'?options.signal:undefined),
    captureFile:(absolute,directory,maxBytes)=>captureWorkspaceFile(subprocess,{node,cwd,absolute,directory,maxBytes,signal}),
  }
}
