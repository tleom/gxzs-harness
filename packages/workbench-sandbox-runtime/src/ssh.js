import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { posix } from 'node:path'
import { connect } from 'node:tls'
import { SshConnection } from '@deepseek-ai/dsh-ssh'

// OpenSSH 9.2 refuses direct-streamlocal forwarding when sshd runs without
// root/privilege separation. Execute this fixed bridge as the same sandbox
// user instead; the helper's per-stream TLS-PSK authentication stays intact.
const BRIDGE = `const net=require('node:net');
const s=net.createConnection({path:process.argv[1],allowHalfOpen:true});
let stopped=false,heartbeat;
const stop=()=>{if(stopped)return;stopped=true;if(heartbeat)clearInterval(heartbeat);process.stdin.unpipe(s);s.unpipe(process.stdout);s.destroy();process.stdin.destroy();if(!process.stdout.destroyed)process.stdout.end()};
const fail=()=>{process.exitCode=1;stop()};
s.on('error',fail);process.stdin.on('error',fail);process.stdout.on('error',fail);process.stderr.on('error',fail);
process.stdin.pipe(s);s.pipe(process.stdout);
let inputEnded=false,outputClosed=false;
const disconnected=()=>{if(inputEnded&&outputClosed)stop()};
process.stdin.on('end',()=>{inputEnded=true;disconnected()});process.stdin.on('close',()=>{inputEnded=true;disconnected()});
process.stdout.on('close',()=>{outputClosed=true;disconnected()});s.on('close',stop);
process.on('SIGHUP',stop);process.on('SIGTERM',stop);
heartbeat=setInterval(()=>{try{process.stderr.write('.',error=>{if(error)fail()})}catch{fail()}},500);heartbeat.unref();`
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

export default class WorkbenchSsh extends SshConnection {
  constructor(ctx, config) {
    super(ctx, config)
    this.bridgeConfig = config
    this.bridgeLifetime = new AbortController()
    this.bridges = new Set()
  }

  connectStream(endpoint, signal) {
    return this.track(this.connectBridge(endpoint, signal))
  }

  async connectBridge(endpoint, signal) {
    const hello = await this.ready
    this.assertOpen()
    const lifetime = AbortSignal.any([this.lifetime.signal, this.bridgeLifetime.signal,
      ...(signal ? [signal] : [])])
    lifetime.throwIfAborted()
    if (!endpoint.path.startsWith(`${hello.root}/`) || posix.normalize(endpoint.path) !== endpoint.path
      || /[:\r\n\0]/u.test(endpoint.path)
      || !/^[0-9a-f]{64}$/u.test(endpoint.capability)) {
      throw new Error('SSH helper returned an invalid stream endpoint')
    }
    // Reuse the pinned connection's verified SSH config, identity and host key,
    // but not its multiplexed transport. A killed mux client leaves its remote
    // channel owned by ControlMaster until the command exits, leaking one
    // sandbox bridge PID per interrupted stream.
    const command = [this.bridgeConfig.node, '-e', BRIDGE, endpoint.path].map(quote).join(' ')
    const child = spawn('ssh', ['-T', '-S', 'none', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5',
      '-o', 'ServerAliveCountMax=3',
      this.bridgeConfig.host, command], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    const raw = Duplex.from({ writable: child.stdin, readable: child.stdout })
    const stream = connect({ socket: raw, ciphers: 'PSK-AES256-GCM-SHA384',
      minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', rejectUnauthorized: true,
      pskCallback: () => ({ psk: Buffer.from(endpoint.capability, 'hex'), identity: 'dsh-stream' }),
      checkServerIdentity: () => undefined })
    const closed = new Promise(resolve => child.once('close', resolve))
    const bridge = { child, stream, closed }
    this.bridges.add(bridge)
    let force
    let stopped = false
    const abort = () => { stream.destroy(new Error('SSH stream cancelled')); stop() }
    const stop = () => {
      if (stopped) return
      stopped = true
      lifetime.removeEventListener('abort', abort)
      raw.destroy()
      child.kill('SIGTERM')
      if (child.exitCode === null && child.signalCode === null) {
        force = setTimeout(() => child.kill('SIGKILL'), 1000)
        force.unref()
      }
    }
    child.on('error', error => stream.destroy(error))
    stream.on('error', stop)
    stream.once('close', stop)
    void closed.then(() => {
      clearTimeout(force)
      this.bridges.delete(bridge)
      stream.destroy()
    })
    lifetime.addEventListener('abort', abort, { once: true })
    if (lifetime.aborted) abort()
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer)
          stream.off('secureConnect', secured)
          stream.off('error', failed)
          stream.off('close', ended)
          error ? reject(error) : resolve()
        }
        const secured = () => finish()
        const failed = error => finish(error)
        const ended = () => finish(new Error('SSH stream closed during authentication'))
        const timer = setTimeout(() => finish(new Error('SSH stream authentication timed out')),
          this.bridgeConfig.requestTimeoutMs ?? 30000)
        stream.once('secureConnect', secured)
        stream.once('error', failed)
        stream.once('close', ended)
      })
      stream.disableRenegotiation()
      stream.pause()
      return stream
    } catch (error) {
      stream.destroy()
      await closed
      throw error
    }
  }

  async dispose() {
    this.bridgeLifetime?.abort()
    // Ask the helper to terminate its processes before waiting for their
    // bridge EOFs. Reversing this order waits for long-running commands.
    await Promise.all([super.dispose(), ...[...this.bridges ?? []].map(bridge => bridge.closed)])
  }
}
