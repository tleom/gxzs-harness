import { expect, it, vi } from 'vitest'
import { WorkbenchJobs } from '../src/jobs.js'

const owner = { ownerId: 'owner' }
const service = { requireChat(who, chatId) {
  if (who.ownerId !== 'owner' || chatId !== 'chat') throw Object.assign(new Error('missing'), { status: 404 })
  return { sessionId: 'session' }
} }
const registry = { get(id, session) { if (id !== 'bash-5' || session !== 'session') throw new Error('foreign') } }
it('carries native rows and non-consuming output frames and releases streams on close', async () => {
  const released = vi.fn()
  const native = {
    list: vi.fn(async function* (_request, signal) { try { yield { type: 'rows', jobs: [{ id: 'bash-5' }] } } finally { released(signal.aborted) } }),
    follow: vi.fn(async function* () { yield { type: 'opened', from: 8 }; yield { type: 'output', chunks: [{ at: 8, text: '中文' }], next: 14 } }),
    kill: vi.fn(() => ({ outcome: 'requested' })),
  }
  const jobs = new WorkbenchJobs({ native, registry, service })
  const abort = new AbortController()
  const stream = jobs.list(owner, 'chat', abort.signal)
  expect((await stream.next()).value.event).toBe('workbench_jobs')
  abort.abort(); await stream.return()
  expect(released).toHaveBeenCalledWith(true)
  const frames = []
  for await (const frame of jobs.follow(owner, 'chat', 'bash-5', '8', new AbortController().signal)) frames.push(frame)
  expect(frames[1]).toEqual({ event: 'workbench_job_output', value: { type: 'output', chunks: [{ at: 8, text: '中文' }], next: 14 } })
  expect(native.follow.mock.calls[0][0]).toEqual({ sessionId: 'session', jobId: 'bash-5', from: 8 })
  expect(await jobs.stop(owner, 'chat', 'bash-5')).toEqual({ outcome: 'requested' })
  expect(native.kill).toHaveBeenCalledWith({ sessionId: 'session', jobId: 'bash-5' })
})
it('fences chat owners and job owners before output or cancellation', async () => {
  const native = { follow: vi.fn(), kill: vi.fn(), list: vi.fn() }
  const jobs = new WorkbenchJobs({ native, registry, service })
  await expect(jobs.list({ ownerId: 'foreign' }, 'chat', new AbortController().signal).next()).rejects.toMatchObject({ status: 404 })
  await expect(jobs.follow(owner, 'chat', 'foreign-1', '0', new AbortController().signal).next()).rejects.toMatchObject({ status: 404 })
  await expect(jobs.stop(owner, 'chat', 'foreign-1')).rejects.toThrow('不属于此对话')
  expect(native.follow).not.toHaveBeenCalled(); expect(native.kill).not.toHaveBeenCalled(); expect(native.list).not.toHaveBeenCalled()
  for (const cursor of ['-1', '1e3', '', '9007199254740992'])
    await expect(jobs.follow(owner, 'chat', 'bash-5', cursor, new AbortController().signal).next()).rejects.toMatchObject({ status: 400 })
})
it('keeps native session identities and verifies descendants before exposing a child roster or cancellation', async () => {
  const subagents = { requireChild: vi.fn(async (_owner, _chat, requested) => {
    if (requested !== 'child') throw Object.assign(new Error('foreign child'), { status: 404 })
    return { id: 'child' }
  }) }
  const native = { list: vi.fn(async function* () { yield { type: 'rows', jobs: [] } }), kill: vi.fn(() => ({ outcome: 'requested' })) }
  const childRegistry = { get: vi.fn((id, session) => { if (id !== 'bash-child' || session !== 'child') throw new Error('foreign job') }) }
  const jobs = new WorkbenchJobs({ native, registry: childRegistry, service, subagents })
  const signal = new AbortController().signal
  await jobs.list(owner, 'chat', signal, 'child').next()
  expect(native.list).toHaveBeenCalledWith({ sessionId: 'child' }, signal)
  expect(await jobs.stop(owner, 'chat', 'bash-child', 'child', signal)).toEqual({ outcome: 'requested' })
  expect(native.kill).toHaveBeenCalledWith({ sessionId: 'child', jobId: 'bash-child' })
  await expect(jobs.list(owner, 'chat', signal, 'foreign').next()).rejects.toMatchObject({ status: 404 })
  await expect(jobs.stop(owner, 'chat', 'bash-root', 'child', signal)).rejects.toMatchObject({ status: 404 })
  expect(native.kill).toHaveBeenCalledOnce()
})
