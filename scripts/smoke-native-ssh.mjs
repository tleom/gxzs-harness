// Real pinned DSH stream protocol; only isolated helper/process fixtures.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import fs from 'node:fs'
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
async function check(name, fn){ const started=Date.now(); await fn(); checks.push(name); console.log(JSON.stringify({check:name,passed:true,elapsed_ms:Date.now()-started})) }
async function drained(){ for(let i=0;i<100 && ssh.bridges.size;i++) await new Promise(r=>setTimeout(r,20)); assert.equal(ssh.bridges.size,0) }
async function remoteBridges(){
 const {stdout}=await execFileAsync('ssh',['-T','-S',ssh.controlPath(),'-o','BatchMode=yes',config.host,'pgrep -af /tmp/dsh-ssh- || true'],{timeout:3000,maxBuffer:65536})
 return stdout.split('\n').filter(line=>line.includes("node -e const net=require('node:net');")).length
}
try {
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
   const processes=Array.from({length:6},(_,index)=>runtime.spawn({argv:['/bin/sh','-c',`printf churn-${batch}-${index}`],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:200}))
   const outputs=processes.map(p=>{const chunks=[];p.stdout.on('data',b=>chunks.push(b));p.stderr.resume();return chunks})
   const results=await Promise.all(processes.map(p=>p.done))
   assert.ok(results.every(result=>result.exitCode===0))
   assert.ok(outputs.every((chunks,index)=>Buffer.concat(chunks).toString()===`churn-${batch}-${index}`))
   await drained()
  }
 })
 await check('abrupt_local_ssh_child_disconnect_reaps_remote_bridge',async()=>{
  const baseline=await remoteBridges()
  const controller=new AbortController()
  const p=runtime.spawn({argv:['/bin/sh','-c','sleep 30'],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:200,signal:controller.signal})
  p.stdout.resume();p.stderr.resume()
  try {
   await p.started
   assert.ok(ssh.bridges.size>=2)
   const victim=[...ssh.bridges][0]
   const disconnectedAt=Date.now()
   victim.child.kill('SIGKILL')
   await Promise.race([victim.closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Local SSH child did not close within three seconds')),3000))])
   const deadline=disconnectedAt+3000
   let remote=await remoteBridges()
   while(remote!==ssh.bridges.size&&Date.now()<deadline){await new Promise(r=>setTimeout(r,50));remote=await remoteBridges()}
   assert.equal(remote,ssh.bridges.size,'Remote bridge outlived its local SSH child for more than three seconds')
   assert.ok(Date.now()-disconnectedAt<3000,'Remote bridge cleanup exceeded three seconds')
  } finally {
   controller.abort()
   await p.done.catch(()=>{})
   await drained()
  }
  assert.equal(await remoteBridges(),baseline)
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
  await Promise.race([p.done.catch(()=>{}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('cancel_exceeded_5s')),5000);t.unref()})]);assert.equal(await p.waitForExit(AbortSignal.timeout(3000)),true);await drained()
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
 await check('dispose_stops_active_streams',async()=>{
  const p=runtime.spawn({argv:['/bin/sh','-c','printf running; sleep 30'],cwd:'/workspace',stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'},graceMs:200})
  p.stdout.on('error',()=>{});p.stderr.on('error',()=>{});p.stderr.resume();await new Promise(r=>p.stdout.once('data',r));const d=Date.now();await Promise.race([ssh.dispose(),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('dispose_exceeded_5s')),5000);t.unref()})]);console.log(JSON.stringify({stage:'dispose_returned',elapsed_ms:Date.now()-d}));await p.done.catch(()=>{});console.log(JSON.stringify({stage:'done_returned',elapsed_ms:Date.now()-d}));assert.equal(ssh.bridges.size,0)
  await assert.rejects(ssh.connectStream({path:hello.root+'/unused',capability:'a'.repeat(64)}))
 })
 console.log(JSON.stringify({checks,passed:checks.length,credentials_printed:false}))
} finally {await ssh.dispose()}
