// Real pinned DSH stream protocol; only isolated helper/process fixtures.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import fs from 'node:fs'
import { deadline, withCleanup } from './smoke-deadline.mjs'
const require = createRequire('/opt/workbench/profiles/workbench/package.json')
const { Context } = await import(require.resolve('@deepseek-ai/cordis'))
const { default: WorkbenchSubprocess } = await import('/opt/workbench/packages/workbench-sandbox-runtime/src/subprocess.js')
const { z } = await import(require.resolve('zod'))
const source = fs.readFileSync('/opt/workbench/packages/workbench-sandbox-runtime/src/ssh.js', 'utf8').replace("'@deepseek-ai/dsh-ssh'", JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-ssh')).href))
const {default: WorkbenchSsh} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
// Match the deployed profile's handshake budget for twelve fresh SSH channels.
// The independent three/five-second disconnect and cleanup assertions remain strict.
const config = {host:process.env.GXZS_SANDBOX_SSH_HOST,launch:{kind:'node-script',node:'/usr/local/bin/node'},helper:'/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',helperHash:process.env.GXZS_SANDBOX_HELPER_HASH,workspace:'/workspace',requestTimeoutMs:30000,maxFrameBytes:67108864,maxPending:128,leaseMs:30000}
const ctx = new Context(); const ssh = new WorkbenchSsh(ctx,config)
const execFileAsync=promisify(execFile)
const checks=[]
let currentCheck='SSH ready', phase='ready', busyCycle
async function check(name, fn){ currentCheck=name;phase='running';busyCycle=undefined;const started=Date.now();console.log(JSON.stringify({begin:name}));await fn();checks.push(name);console.log(JSON.stringify({check:name,passed:true,elapsed_ms:Date.now()-started})) }
function reportFailure(kind,error){console.log(JSON.stringify({failure:kind,check:currentCheck,phase,busyCycle,error:String(error?.message??error).slice(0,1000),bridges:ssh.bridges?.size,operations:ssh.operations?.size,sockets:ssh.sockets?.size,pending:ssh.rpc?.pending?.size}))}
async function drained(){ for(let i=0;i<100 && ssh.bridges.size;i++) await new Promise(r=>setTimeout(r,20)); assert.equal(ssh.bridges.size,0) }
async function remoteBridges(){
 const {stdout}=await execFileAsync('ssh',['-T','-S',ssh.controlPath(),'-o','BatchMode=yes',config.host,'pgrep -af /tmp/dsh-ssh- || true'],{timeout:3000,maxBuffer:65536})
 return stdout.split('\n').filter(line=>line.includes("node -e const net=require('node:net');")).length
}
await withCleanup(async()=>{
 const hello=await ssh.ready
 const runtime=new WorkbenchSubprocess(ctx, {ripgrepExecutable:'/usr/bin/rg'})
 await check('ordinary_stdout_stderr_and_cleanup',async()=>{
  const p=runtime.spawn({argv:['/bin/sh','-c','printf bridge-ok; printf bridge-error >&2'],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:200})
  let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b)
  assert.equal((await p.done).exitCode,0);assert.equal(await p.waitForExit(),true);assert.equal(out,'bridge-ok');assert.equal(err,'bridge-error');await drained()
 })
 await check('concurrent_streams_exceed_default_ssh_session_limit',async()=>{
  const processes=Array.from({length:4},()=>runtime.spawn({argv:['/bin/sh','-c','read value; printf parallel-ok'],cwd:'/workspace',stdio:{stdin:'pipe',stdout:'pipe',stderr:'pipe'},graceMs:200}))
  const outputs=processes.map(p=>{const chunks=[];p.stdout.on('data',b=>chunks.push(b));p.stderr.resume();return chunks})
  await Promise.all(processes.map(p=>p.started))
  assert.ok(ssh.bridges.size>=12, 'Expected twelve concurrent authenticated stream channels')
  processes.forEach(p=>p.stdin.end('go\n'))
  const outcomes=await Promise.all(processes.map(async p=>{const result=await p.done;assert.equal(await p.waitForExit(),true);return result}))
  assert.ok(outcomes.every(result=>result.exitCode===0))
  assert.ok(outputs.every(chunks=>Buffer.concat(chunks).toString()==='parallel-ok'))
  await drained()
 })
 await check('completed_process_churn_releases_every_bridge',async()=>{
  for(let batch=0;batch<10;batch++){
   // done uses graceMs as its output-drain deadline too. Match bash-local's
   // production 3s budget under CI scheduling; bridge cleanup stays bounded below.
   const processes=Array.from({length:6},(_,index)=>runtime.spawn({argv:['/bin/sh','-c',`printf churn-${batch}-${index}`],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:3000}))
   const outputs=processes.map(p=>{const chunks=[];p.stdout.on('data',b=>chunks.push(b));p.stderr.resume();return chunks})
   const results=await Promise.all(processes.map(p=>p.done))
   assert.ok(results.every(result=>result.exitCode===0))
   assert.deepEqual(outputs.map(chunks=>Buffer.concat(chunks).toString()),processes.map((_,index)=>`churn-${batch}-${index}`))
   await drained()
  }
 })
 await check('abrupt_local_ssh_child_disconnect_reaps_remote_bridge',async()=>{
  const controller=new AbortController()
  const p=runtime.spawn({argv:['/bin/sh','-c','sleep 30'],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:200,signal:controller.signal})
  p.stdout.resume();p.stderr.resume()
  try {
   await p.started
   assert.ok(ssh.bridges.size>=2)
   const victim=[...ssh.bridges][0]
   const disconnectedAt=Date.now()
   victim.child.kill('SIGKILL')
   await deadline('Local SSH child close',3000,()=>victim.closed)
   const closeDeadline=disconnectedAt+3000
   let remote=await remoteBridges()
   while(remote!==ssh.bridges.size&&Date.now()<closeDeadline){await new Promise(r=>setTimeout(r,50));remote=await remoteBridges()}
   assert.equal(remote,ssh.bridges.size,'Remote bridge outlived its local SSH child for more than three seconds')
   assert.ok(Date.now()-disconnectedAt<3000,'Remote bridge cleanup exceeded three seconds')
  } finally {
   controller.abort()
   await p.done.catch(()=>{})
   await drained()
  }
  // Remote bridges from the preceding churn may still be exiting at entry.
  // The cleanup invariant is zero, not that transient pre-check count.
  assert.equal(await remoteBridges(),0)
 })
 await check('invalid_root_path_rejected_before_bridge',async()=>{
  await assert.rejects(ssh.connectStream({path:hello.root+'/../outside',capability:'a'.repeat(64)}),/invalid stream endpoint/);assert.equal(ssh.bridges.size,0)
 })
 await check('missing_socket_fails_and_cleans_up',async()=>{
  await assert.rejects(ssh.connectStream({path:hello.root+'/does-not-exist',capability:'a'.repeat(64)}));await drained()
 })
 await check('wrong_psk_rejected_and_cleans_up',async()=>{
  const prep=await ssh.request('process.prepare',{argv:['/bin/echo','unused'],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:200},z.any())
  try {const endpoint=prep.streams.stdout;await assert.rejects(ssh.connectStream({...endpoint,capability:endpoint.capability==='a'.repeat(64)?'b'.repeat(64):'a'.repeat(64)}));await drained()}
  finally {await ssh.request('process.terminate',{id:prep.id},z.null())}
 })
 await check('cancel_running_process_confirms_exit',async()=>{
  const controller=new AbortController()
  const p=runtime.spawn({argv:['/bin/sh','-c','printf running; sleep 30'],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:200,signal:controller.signal})
  p.stdout.on('error',()=>{});p.stderr.on('error',()=>{})
  const ready=new Promise(r=>p.stdout.once('data',r));p.stderr.resume();await ready;controller.abort()
  await deadline('cancel',5000,()=>p.done.catch(()=>{}));assert.equal(await p.waitForExit(AbortSignal.timeout(3000)),true);await drained()
 })
 // Exercise the configured thin adapter: upstream leaves an open stdin stream
 // after cancellation; WorkbenchSubprocess closes streams at the native done boundary.
 for (const disruption of ['cancel', 'disconnect']) {
  await check(`${disruption}_one_process_preserves_concurrent_siblings`, async () => {
   const controllers = Array.from({length:4}, () => new AbortController())
   const processes = []
   const outputs = []
   try {
    for (let index=0; index<4; index++) {
     const process = runtime.spawn({argv:['/bin/sh','-c',`printf ready-${index}; read value; printf done-${index}`],cwd:'/workspace',stdio:{stdin:'pipe',stdout:'pipe',stderr:'pipe'},graceMs:200,signal:controllers[index].signal})
     processes.push(process)
     outputs[index] = ''
     process.stdout.on('error',()=>{}); process.stderr.on('error',()=>{}); process.stdin.on('error',()=>{})
     process.stdout.on('data', chunk => { outputs[index] += chunk })
     process.stderr.resume()
     // Observe rejection immediately, even when the deliberate disconnect happens before awaiting done.
     void process.done.catch(()=>{})
     await process.started
    }
    if (disruption === 'disconnect') {
     const victim = [...ssh.bridges][0]
     assert.ok(victim, 'Expected the first process stream bridge')
     victim.child.kill('SIGKILL')
     await victim.closed
    }
    controllers[0].abort()
    await processes[0].done.catch(()=>{})
    assert.equal(await processes[0].waitForExit(AbortSignal.timeout(3000)), true)
    for (const process of processes.slice(1)) process.stdin.end('continue\n')
    const results = await Promise.all(processes.slice(1).map(process => process.done))
    assert.ok(results.every(result => result.exitCode === 0), 'Sibling task failed after unrelated disruption')
    for (let index=1; index<4; index++) assert.equal(outputs[index], `ready-${index}done-${index}`, 'Sibling output was lost or crossed streams')
   } finally {
    controllers.forEach(controller => controller.abort())
    await Promise.allSettled(processes.map(process => process.done))
    await drained()
   }
  })
 }
 await check('pty_shell_roundtrip',async()=>{
  const p=await runtime.spawnTerminal({argv:['/bin/bash','--noprofile','--norc'],cwd:'/workspace',rows:24,cols:80,terminalType:'xterm',graceMs:200})
  let out='';p.output.on('data',b=>out+=b);await p.write('printf "pty-bridge-ok\\n"; exit\n');assert.equal((await p.done).exitCode,0);await p.terminate();assert.match(out,/pty-bridge-ok/);await drained()
 })
 await check('closing_busy_pty_stops_queued_commands_without_orphans',async()=>{
  for(let cycle=0;cycle<4;cycle++){
   busyCycle=cycle;phase='spawn'
   const p=await runtime.spawnTerminal({argv:['/bin/sh'],cwd:'/workspace',rows:40,cols:120,terminalType:'xterm',graceMs:200})
   p.output.on('error',()=>{});p.output.resume()
   // A live shell must not launch replacement children while cleanup drains them.
   phase='write'
   for(let index=0;index<100;index++) await p.write(`node -e 'console.log("busy-${cycle}-${index}")'\r`)
   await deadline(`Busy PTY cycle ${cycle} close`,3000,async()=>{
    phase='terminate';await p.terminate();phase='done';await p.done
   })
   phase='drained';await drained()
  }
 })
 await check('closing_backpressured_pty_releases_underlying_ssh_pipes',async()=>{
  const p=await runtime.spawnTerminal({argv:['/bin/sh'],cwd:'/workspace',rows:40,cols:120,terminalType:'xterm',graceMs:200})
  p.output.on('error',()=>{})
  // A hidden/closed terminal may stop consuming output. Fill its buffer before
  // terminating: a destroyed TLS wrapper must also release the child's stdout.
  await p.write(`node -e 'process.stdout.write("x".repeat(1048576))'\r`)
  await deadline('Fill paused PTY output',5000,async()=>{
   while(p.output.readableLength<p.output.readableHighWaterMark) await new Promise(r=>setTimeout(r,20))
  })
  const bridges=[...ssh.bridges]
  assert.ok(bridges.length>0)
  await deadline('Backpressured PTY close',3000,async()=>{await p.terminate();await p.done})
  await drained()
  for(const bridge of bridges) assert.ok(bridge.child.stdio.every(pipe=>!pipe||pipe.destroyed),'SSH child retained an output pipe')
 })
 await check('dispose_stops_active_streams',async()=>{
  const p=runtime.spawn({argv:['/bin/sh','-c','printf running; sleep 30'],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:200})
  p.stdout.on('error',()=>{});p.stderr.on('error',()=>{});p.stderr.resume();await new Promise(r=>p.stdout.once('data',r));const d=Date.now();await deadline('dispose',5000,()=>ssh.dispose());console.log(JSON.stringify({stage:'dispose_returned',elapsed_ms:Date.now()-d}));await p.done.catch(()=>{});console.log(JSON.stringify({stage:'done_returned',elapsed_ms:Date.now()-d}));assert.equal(ssh.bridges.size,0)
  await assert.rejects(ssh.connectStream({path:hello.root+'/unused',capability:'a'.repeat(64)}))
 })
},()=>deadline('Final SSH cleanup',5000,()=>ssh.dispose()),reportFailure)
console.log(JSON.stringify({checks,passed:checks.length,credentials_printed:false}))
