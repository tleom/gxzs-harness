import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('reconnects after overflow without inheriting queued bytes or a failed old delivery', async () => {
  const require = createRequire(import.meta.url), sockets = [], frames = []
  let spawned = false, rejectOld
  const oldDelivery = new Promise((_, reject) => { rejectOld = reject })
  class Socket {
    static OPEN = 1
    readyState = 1
    bufferedAmount = 0
    send = vi.fn()
    close = vi.fn(() => this.onclose?.())
    constructor() { sockets.push(this) }
  }
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => queueMicrotask(() => child.emit('exit')) })
  const modules = {
    'node:child_process': { spawn: () => { spawned = true; return child }, execFile: (_file, _args, _options, done) => done() },
    'node:fs': { existsSync: path => spawned && path.startsWith('/tmp/.X11-unix/'), mkdtempSync: () => '/tmp/display-fixture', rmSync() {} },
    'node:net': {
      createServer: () => Object.assign(new EventEmitter(), { listen: (_port, _host, done) => done(), address: () => ({ port: 12345 }), close: done => done() }),
      connect: () => { const socket = Object.assign(new EventEmitter(), { destroy() {} }); queueMicrotask(() => socket.emit('connect')); return socket },
    },
    '/opt/office/node/node_modules/ws': Socket,
  }
  const module = { exports: {} }
  runInNewContext(readFileSync(new URL('../src/browser-display.cjs', import.meta.url), 'utf8'), {
    require: name => modules[name] ?? require(name), module, Buffer, process, setTimeout, clearTimeout,
  })
  const display = await module.exports.startDisplay({ width: 100, height: 100, onExit() {}, emit: frame => {
    frames.push(frame)
    return frame.connection === 'old' && frame.event === 'data' ? oldDelivery : Promise.resolve()
  } })
  try {
    display.open('old')
    sockets[0].onmessage({ data: Buffer.alloc(8 * 1024 * 1024) })
    await Promise.resolve()
    sockets[0].onmessage({ data: Buffer.alloc(1) })
    expect(sockets[0].close).toHaveBeenCalledOnce()
    display.open('new')
    sockets[1].onmessage({ data: Buffer.alloc(1024 * 1024) })
    await vi.waitFor(() => expect(frames.filter(frame => frame.connection === 'new' && frame.event === 'data')).toHaveLength(16))
    rejectOld(new Error('old channel closed'))
    await new Promise(resolve => setImmediate(resolve))
    expect(sockets[1].close).not.toHaveBeenCalled()
    display.write('new', 'YWJj')
    expect(sockets[1].send).toHaveBeenCalledOnce()
  } finally { await display.stop() }
})
