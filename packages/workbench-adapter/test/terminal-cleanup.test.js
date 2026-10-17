import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { terminalCleanupSource } from '../../../scripts/prepare-terminal-cleanup.mjs'

const source = await readFile(new URL('../../../profiles/workbench/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js', import.meta.url), 'utf8')
function cleanup(patched = true) {
  const text = patched ? terminalCleanupSource(source) : source
  const method = text.slice(text.indexOf('\tasync closeOnce() {'), text.indexOf('\n\tcleanupManagedOwner(owner) {'))
  return Function(`return ({${method}}).closeOnce`)()
}
function fixture() {
  let alive = true, frozen = false
  const signals = []
  const owner = {
    platform: 'linux', rootIdentity: { pid: 42, started: 'identity' },
    inspector: {
      isAlive: () => alive,
      signalProcess: (identity, signal) => { if (!alive) return; signals.push([identity, signal]); frozen = signal === 'SIGSTOP' },
    },
    // A live shell immediately launches another queued command when its child exits.
    stopDescendants: vi.fn(async () => frozen || !alive ? [] : [{ pid: 43 }]),
    stopShell: vi.fn(async () => { alive = false }),
    settleExitIfGone: vi.fn(), dataDisposable: { dispose: vi.fn() }, exitDisposable: { dispose: vi.fn() },
  }
  return { owner, signals, reusePid: () => { alive = false } }
}
it('freezes the exact shell before draining children and confirms full cleanup', async () => {
  const { owner, signals } = fixture()
  await cleanup().call(owner)
  expect(signals).toEqual([[owner.rootIdentity, 'SIGSTOP']])
  expect(owner.stopDescendants).toHaveBeenCalledTimes(2)
  expect(owner.stopShell).toHaveBeenCalledOnce()
  expect(owner.dataDisposable.dispose).toHaveBeenCalledOnce()
})
it('tolerates a shell exiting between the identity check and signal', async () => {
  const { owner } = fixture()
  owner.inspector.signalProcess = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }
  owner.stopDescendants.mockResolvedValue([])
  await cleanup().call(owner)
  expect(owner.stopShell).toHaveBeenCalledOnce()
})
it('resumes the same shell when a surviving descendant prevents cleanup', async () => {
  const { owner, signals } = fixture()
  owner.stopDescendants.mockResolvedValue([{ pid: 43 }])
  await expect(cleanup().call(owner)).rejects.toThrow('surviving pids')
  expect(signals.map(item => item[1])).toEqual(['SIGSTOP', 'SIGCONT'])
  expect(owner.stopShell).not.toHaveBeenCalled()
})
it('never freezes a reused PID or changes non-Linux cleanup', async () => {
  const { owner, signals, reusePid } = fixture()
  reusePid(); await cleanup().call(owner); expect(signals).toEqual([])
  const other = fixture(); other.owner.platform = 'darwin'
  other.owner.stopDescendants.mockResolvedValue([])
  await cleanup().call(other.owner); expect(other.signals).toEqual([])
})
it('patches the pinned published method once and rejects changed anchors', () => {
  const patched = terminalCleanupSource(source)
  expect(terminalCleanupSource(patched)).toBe(patched)
  expect(() => terminalCleanupSource('new upstream code')).toThrow('contract changed')
})
