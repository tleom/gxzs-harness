import { expect, it, vi } from 'vitest'
import { TerminalUplink } from '../src/terminal-uplink.js'

function fixture(options = {}) {
  const controller = new AbortController()
  const input = new TerminalUplink({ maxBytes: 256, signal: controller.signal,
    abort: reason => controller.abort(reason), ...options })
  return { input, controller, iterator: input[Symbol.asyncIterator]() }
}
it('settles accepted input only after native acknowledgements and keeps resize ordered', async () => {
  const { input, iterator, controller } = fixture()
  const accepted = vi.fn()
  const a = input.send({ type: 'write', data: '中文\r' }).then(accepted)
  const b = input.send({ type: 'resize', cols: 80, rows: 24 })
  expect((await iterator.next()).value).toEqual({ type: 'write', data: '中文\r', sequence: 1 })
  expect((await iterator.next()).value).toEqual({ type: 'resize', cols: 80, rows: 24, sequence: 2 })
  expect(accepted).not.toHaveBeenCalled()
  input.acknowledge({ sequence: 1 }); await a
  input.acknowledge({ sequence: 2 }); await b
  expect(input.bytes).toBe(0)
  const pendingRead = iterator.next()
  controller.abort()
  expect(await pendingRead).toEqual({ done: true })
})
it('bounds queued bytes and refuses input without advancing the native sequence', async () => {
  const { input, iterator } = fixture()
  await expect(input.send({ type: 'write', data: 'x'.repeat(256) })).rejects.toMatchObject({ status: 429 })
  const accepted = input.send({ type: 'write', data: 'a' })
  expect((await iterator.next()).value.sequence).toBe(1)
  input.acknowledge({ sequence: 1 }); await accepted
  await iterator.return()
})
it('rejects takeover refusals and drops unacknowledged commands on connection loss', async () => {
  const { input, iterator, controller } = fixture()
  const refused = input.send({ type: 'write', data: 'a' })
  await iterator.next()
  const refusal = expect(refused).rejects.toMatchObject({ status: 409 })
  input.acknowledge({ sequence: 1, refusal: 'read-only' }); await refusal
  const lost = expect(input.send({ type: 'write', data: 'b' })).rejects.toThrow('lost')
  controller.abort(new Error('lost')); await lost
  expect(await iterator.next()).toEqual({ done: true })
  expect(input.queue).toEqual([])
  await expect(input.send({ type: 'write', data: 'c' })).rejects.toThrow('lost')
})
it('ends an unacknowledged attachment within its deadline without resending input', async () => {
  const { input, controller } = fixture({ timeoutMs: 5 })
  await expect(input.send({ type: 'write', data: 'once' })).rejects.toMatchObject({ status: 504 })
  expect(controller.signal.aborted).toBe(true)
  expect(input.sequence).toBe(1)
  expect(input.pending.size).toBe(0)
})
