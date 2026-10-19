// A private X display per chat browser. Only the signed adapter can carry its pixels.
const { spawn, execFile } = require('node:child_process')
const { existsSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createServer, connect } = require('node:net')
const { promisify } = require('node:util')
const run = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startDisplay({ width, height, emit, onExit }) {
  const WebSocket = require('/opt/office/node/node_modules/ws')
  const home = mkdtempSync(join(tmpdir(), 'workbench-browser-'))
  let display
  do { display = 100 + Math.floor(Math.random() * 50000) }
  while (existsSync(`/tmp/.X${display}-lock`) || existsSync(`/tmp/.X11-unix/X${display}`))
  const port = await availablePort()
  const child = spawn('/usr/bin/Xvnc', [`:${display}`, '-geometry', `${width}x${height}`, '-depth', '24',
    '-websocketPort', String(port), '-interface', '127.0.0.1', '-UseIPv6', '0', '-publicIP', '127.0.0.1',
    '-DisableBasicAuth', '1', '-SecurityTypes', 'None', '-sslOnly', '0', '-rfbport', '0', '-nolisten', 'tcp',
    '-s', '0', '-dpms', '-wr',
    '-FrameRate', '15', '-AcceptSetDesktopSize', '0', '-MaxVideoResolution', '1920x1080',
    '-DLP_ClipAcceptMax', '32768', '-DLP_ClipSendMax', '32768', '-DLP_ClipTypes', 'text/plain',
    '-httpd', '/usr/share/kasmvnc/www'], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] })
  let stopping = false, failure, log = '', relay
  let currentMode
  const size = { width, height }
  child.stderr.on('data', bytes => { log = (log + bytes).slice(-4096) })
  const done = new Promise(resolve => {
    child.once('error', error => { failure = error; resolve() })
    child.once('exit', () => { failure ||= new Error('display_exited'); if (!stopping) onExit(); resolve() })
  })
  const closeRelay = () => {
    const previous = relay
    relay = undefined
    previous?.socket.close()
  }
  const stop = async () => {
    if (stopping) return done
    stopping = true
    closeRelay()
    child.kill('SIGTERM')
    const force = setTimeout(() => child.kill('SIGKILL'), 1000)
    await done
    clearTimeout(force)
    rmSync(home, { recursive: true, force: true })
  }
  try {
    for (let count = 0; count < 100; count++) {
      if (failure) throw new Error(`display_start_failed: ${log.slice(-512)}`)
      if (existsSync(`/tmp/.X11-unix/X${display}`)) {
        const ready = await new Promise(resolve => {
          const socket = connect(port, '127.0.0.1')
          socket.once('connect', () => { socket.destroy(); resolve(true) })
          socket.once('error', () => resolve(false))
        })
        if (ready) break
      }
      if (count === 99) throw new Error('display_start_timeout')
      await delay(100)
    }
  } catch (error) { await stop(); throw error }
  return {
    env: { ...process.env, DISPLAY: `:${display}`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') },
    size,
    stop,
    async resize(width, height) {
      const w = width, h = height, mode = `workbench-${w}x${h}`
      if (currentMode === mode) return
      const randr = args => run('/usr/bin/xrandr', ['--display', `:${display}`, ...args], { timeout: 5000 })
      // RandR must resize the output mode with its framebuffer. --fb alone clips/fails on shrink.
      await randr(['--newmode', mode, String(((w + 24) * (h + 24) * 60 / 1e6).toFixed(3)),
        String(w), String(w + 8), String(w + 16), String(w + 24), String(h), String(h + 8), String(h + 16), String(h + 24)])
      try {
        await randr(['--addmode', 'VNC-0', mode])
        await randr(['--output', 'VNC-0', '--mode', mode])
      } catch (error) {
        await randr(['--delmode', 'VNC-0', mode]).catch(() => {})
        await randr(['--rmmode', mode]).catch(() => {})
        throw error
      }
      const previous = currentMode
      currentMode = mode
      Object.assign(size, { width, height })
      if (previous) {
        await randr(['--delmode', 'VNC-0', previous]).catch(() => {})
        await randr(['--rmmode', previous]).catch(() => {})
      }
    },
    open(connection) {
      closeRelay()
      const socket = new WebSocket(`ws://127.0.0.1:${port}/websockify`, ['binary'], {
        origin: `http://127.0.0.1:${port}`, perMessageDeflate: false, maxPayload: 8 * 1024 * 1024,
      })
      socket.binaryType = 'arraybuffer'
      const current = { socket, connection, pendingBytes: 0, delivery: Promise.resolve() }
      relay = current
      socket.onopen = () => { if (relay === current) void emit({ type: 'display', connection, event: 'open' }) }
      socket.onmessage = event => {
        if (relay !== current) return
        const bytes = Buffer.from(event.data)
        // RFB is ordered: a slow viewer is disconnected, never served partial/dropped deltas.
        if (current.pendingBytes + bytes.length > 8 * 1024 * 1024) { closeRelay(); void emit({ type: 'display', connection, event: 'close' }); return }
        current.pendingBytes += bytes.length
        current.delivery = current.delivery.then(async () => {
          try {
            for (let offset = 0; offset < bytes.length && relay === current; offset += 65536)
              await emit({ type: 'display', connection, event: 'data', data: bytes.subarray(offset, offset + 65536).toString('base64') })
          } finally { current.pendingBytes -= bytes.length }
        }).catch(() => { if (relay === current) closeRelay() })
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => { if (relay === current) { relay = undefined; void emit({ type: 'display', connection, event: 'close' }) } }
    },
    write(connection, data) {
      if (relay?.connection !== connection || relay.socket.readyState !== WebSocket.OPEN) throw new Error('display_not_connected')
      if (relay.socket.bufferedAmount > 1024 * 1024) { closeRelay(); throw new Error('display_input_full') }
      relay.socket.send(Buffer.from(data, 'base64'))
    },
    close(connection) { if (!connection || relay?.connection === connection) closeRelay() },
  }
}

module.exports = { startDisplay, displayAvailable: () => existsSync('/usr/bin/Xvnc') }
