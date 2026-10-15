import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { TaskScheduler } from '../src/scheduler.js'

it.each(['startup', 'interval', 'enqueue'])('survives a detached %s tick failure and retries without exiting the Host', mode => {
  const source = `
    import { TaskScheduler } from ${JSON.stringify(new URL('../src/scheduler.js', import.meta.url).href)};
    let reads = 0;
    const database = {
      saveSubmission() {}, pendingRunFences: () => [],
      submissions() {
        if (++reads === ${mode === 'interval' ? 2 : 1})
          throw Object.assign(new Error('private database path and secret'), { code: 'SQLITE_BUSY' });
        return [];
      },
    };
    const scheduler = new TaskScheduler({ database, ownerId: 'private-owner' });
    ${mode === 'enqueue' ? "await scheduler.enqueue({ ownerId: 'private-owner', id: 'run' }, []);" : 'scheduler.start();'}
    setTimeout(async () => {
      await scheduler.tick(); scheduler.close();
      console.log(JSON.stringify({ survived: true, reads }));
    }, ${mode === 'interval' ? 1100 : 30});
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 5000,
  })
  expect(child.status, child.stderr).toBe(0)
  expect(child.stdout).toContain('"survived":true')
  expect(child.stderr).toContain('"operation":"tick_failed"')
  expect(child.stderr).not.toMatch(/private|secret/)
})

it('keeps the dispatch barrier until every session worker settles after a snapshot failure', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let release
  const gate = new Promise(resolve => { release = resolve })
  const failure = new Error('injected session snapshot failure')
  const database = {
    pendingRunFences: () => [],
    submissions: () => [{ runId: 'bad' }, { runId: 'slow' }],
    getRun: (_owner, id) => ({ sessionId: id }),
  }
  const scheduler = new TaskScheduler({ database, ownerId: 'owner' })
  scheduler.dispatchItems = vi.fn(async items => {
    if (items[0].runId === 'bad') throw failure
    await gate
  })
  try {
    const first = scheduler.tick()
    const rejected = expect(first).rejects.toBe(failure)
    for (let index = 0; index < 8; index++) await Promise.resolve()
    expect(scheduler.tick()).toBe(first)
    expect(scheduler.dispatchItems).toHaveBeenCalledTimes(2)
    release()
    await rejected
    expect(scheduler.pendingTick).toBeNull()
    expect(warning).toHaveBeenCalledOnce()
  } finally { release(); scheduler.close(); warning.mockRestore() }
})

it('preserves an explicit tick rejection while allowing the next tick to recover', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const failure = Object.assign(new Error('secret storage path'), { code: 'SQLITE_IOERR' })
  const database = { pendingRunFences: () => [], submissions: vi.fn().mockImplementationOnce(() => { throw failure }).mockReturnValue([]) }
  const scheduler = new TaskScheduler({ database, ownerId: 'owner' })
  try {
    await expect(scheduler.tick()).rejects.toBe(failure)
    await scheduler.tick()
    expect(database.submissions).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledOnce()
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/secret|storage|owner/)
  } finally { scheduler.close(); warning.mockRestore() }
})
