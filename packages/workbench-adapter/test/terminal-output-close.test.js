import { readFile } from 'node:fs/promises'
import { Duplex, PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { terminalOutputCloseSource } from '../../../scripts/prepare-terminal-cleanup.mjs'

const native = new URL('../../../profiles/workbench/node_modules/@deepseek-ai/', import.meta.url)
const providerSource = await readFile(new URL('dsh-subprocess-ssh/lib/index.js', native), 'utf8')
const sessionSource = await readFile(new URL('dsh-terminal-bash/lib/index.js', native), 'utf8')
for (const name of ['dsh-subprocess-ssh', 'dsh-terminal-bash']) {
  const metadata = JSON.parse(await readFile(new URL(`${name}/package.json`, native), 'utf8'))
  if (metadata.version !== '0.2.2-rc.1') throw new Error('Unverified terminal lifecycle fixture version')
}

// Execute the installed provider/session bodies; only RPC ordering, schema validation,
// and unused emulator rendering are doubles. Output is a real Node stream.
const providerStart = providerSource.indexOf('var SshSubprocessRuntime = class')
const providerBody = providerSource.slice(providerStart, providerSource.indexOf('//#endregion', providerStart))
const schema = new Proxy(function () {}, {
  get: (_, key) => key === 'parse' ? value => value : () => schema,
  apply: () => schema,
})
const SshSubprocessRuntime = Function('PassThrough', 'SubprocessRuntime', 'z', 'preparedSchema', 'streamEndpointSchema', 'doneSchema', 'environment', `${providerBody}; return SshSubprocessRuntime`)(
  PassThrough, class { constructor(ctx) { this.ctx = ctx } }, schema, schema, schema, schema, value => value,
)
function sessionClass(source) {
  const body = source.slice(source.indexOf('const CONTROLLED_PROMPT ='), source.indexOf('//#endregion\n//#region lib/types/index.js'))
    .replace('const requireHeadless = createLazyRequire("@xterm/headless", import.meta.url);', '')
  const requireHeadless = () => ({ Terminal: class {
    onData() { return { dispose() {} } }
    write(_data, done) { done() }
    dispose() {}
  } })
  return Function('requireHeadless', `${body}; return LocalPtySession`)(requireHeadless)
}
const LocalPtySession = sessionClass(terminalOutputCloseSource(sessionSource))
async function fixture({ deferDone = false, terminateError, signal } = {}) {
  const outcome = Promise.withResolvers()
  const socket = new Duplex({ read() {}, write(_data, _encoding, next) { next() } })
  const request = vi.fn(async method => {
    if (method === 'process.prepare') return { id: 'fixture', streams: { terminal: {} } }
    if (method === 'process.start') return { pid: 123 }
    if (method === 'process.done') return outcome.promise
    if (method === 'process.terminate') {
      if (terminateError) throw terminateError
      if (!deferDone) outcome.resolve({ outcome: { exitCode: 0, signal: null } })
      return null
    }
    throw new Error(`Unexpected fixture request: ${method}`)
  })
  const runtime = new SshSubprocessRuntime({ effect() {}, ssh: { request, connectStream: async () => socket } })
  const terminal = await runtime.spawnTerminal({ argv: ['/bin/bash'], cwd: '/tmp', cols: 80, rows: 24, graceMs: 200, signal })
  const session = new LocalPtySession(terminal, { cols: 80, rows: 24, maxReadBytes: 4096, scrollbackMaxBytes: 8192, scrollbackLines: 100 })
  return { runtime, terminal, session, socket, outcome, request }
}

it.each([true, false])('closes when output EOF precedes termination acknowledgement: %s', async eofFirst => {
  const { runtime, terminal, session, socket } = await fixture()
  const ended = vi.fn(), closed = vi.fn()
  terminal.output.once('end', ended)
  terminal.output.once('close', closed)
  if (eofFirst) { socket.push(null); await nextTurn() }
  const closing = session.close('test')
  expect(session.close('test')).toBe(closing)
  await closing
  expect(runtime.terminals.size).toBe(0)
  expect(session.status()).toEqual({ kind: 'exited', exitCode: 0, signal: null })
  expect(ended).toHaveBeenCalledTimes(eofFirst ? 1 : 0)
  expect(closed).toHaveBeenCalledOnce()
  terminal.output.off('end', ended)
  for (const event of ['data', 'end', 'error', 'close']) expect(terminal.output.listenerCount(event)).toBe(0)
})

it('waits for process.done after close-only and preserves its exit result', async () => {
  const { terminal, session, outcome } = await fixture({ deferDone: true })
  let completed = false
  const closing = session.close('test').then(() => { completed = true })
  await nextTurn()
  expect(terminal.output.closed).toBe(true)
  expect(completed).toBe(false)
  expect(session.status().kind).toBe('running')
  outcome.resolve({ outcome: { exitCode: 7, signal: null } })
  await closing
  expect(session.status()).toEqual({ kind: 'exited', exitCode: 7, signal: null })
})

it('preserves process.done transport failures after close-only', async () => {
  const { session, outcome, terminal } = await fixture({ deferDone: true })
  const failure = new Error('SSH disconnected')
  const closing = session.close('test')
  const rejected = expect(closing).rejects.toBe(failure)
  await nextTurn()
  outcome.reject(failure)
  await rejected
  expect(terminal.output.listenerCount('close')).toBe(0)
})

it('preserves output errors and fails the active operation', async () => {
  const { session, terminal } = await fixture()
  const failure = new Error('output transport failed')
  const fail = vi.fn()
  session.active = { fail }
  terminal.output.destroy(failure)
  await nextTurn()
  await expect(session.close('test')).rejects.toBe(failure)
  expect(fail).toHaveBeenCalledWith(failure)
  expect(terminal.output.listenerCount('close')).toBe(0)
})

it.each([true, false])('flushes received UTF-8 tail once with EOF first: %s', async eofFirst => {
  const { session, socket } = await fixture()
  socket.push(Buffer.from([0x41, 0xe4, 0xb8]))
  await nextTurn()
  const flush = vi.spyOn(session.sanitizer, 'flush')
  if (eofFirst) { socket.push(null); await nextTurn() }
  await session.close('test')
  expect(session.scrollback.consume().delta).toBe('A\ufffd')
  expect(flush).toHaveBeenCalledOnce()
})

it('still requires successful remote cleanup confirmation', async () => {
  const failure = new Error('remote process is still alive')
  const { session, terminal, outcome } = await fixture({ terminateError: failure })
  await expect(session.close('test')).rejects.toMatchObject({ message: 'PTY cleanup failed (test)', cause: failure })
  expect(terminal.output.destroyed).toBe(false)
  // Close the fixture stream without changing the asserted failed cleanup result.
  terminal.output.destroy()
  outcome.resolve({ outcome: { exitCode: 0, signal: null } })
  await session.completion
})

it('completes provider abort cleanup without manufacturing output EOF', async () => {
  const controller = new AbortController()
  const { terminal, session, runtime } = await fixture({ signal: controller.signal })
  controller.abort(new Error('cancelled'))
  await nextTurn()
  await session.close('cancelled')
  expect(terminal.output.readableEnded).toBe(false)
  expect(runtime.terminals.size).toBe(0)
})

it('patches the pinned lifecycle once and rejects changed anchors', () => {
  const patched = terminalOutputCloseSource(sessionSource)
  expect(sessionSource).toBe(patched)
  expect(terminalOutputCloseSource(patched)).toBe(patched)
  expect(() => terminalOutputCloseSource('new upstream code')).toThrow('contract changed')
})
