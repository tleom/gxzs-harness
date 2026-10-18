import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { deadline, withCleanup } from './smoke-deadline.mjs'

describe('smoke deadlines and failure reporting', () => {
  it('preserves and reports the primary failure when cleanup also fails', async () => {
    const primary = new Error('busy PTY assertion')
    const cleanup = new Error('SSH cleanup')
    const reports = []
    await expect(withCleanup(
      () => { throw primary },
      () => { throw cleanup },
      (stage, error) => reports.push([stage, error]),
    )).rejects.toBe(primary)
    expect(reports).toEqual([['primary', primary], ['cleanup', cleanup]])
  })

  it('fails an otherwise successful smoke when cleanup never settles', async () => {
    const reports = []
    await expect(withCleanup(
      () => 'passed',
      () => deadline('cleanup', 10, () => new Promise(() => {})),
      (stage, error) => reports.push([stage, error.message]),
    )).rejects.toThrow('cleanup exceeded 10ms')
    expect(reports).toEqual([['cleanup', 'cleanup exceeded 10ms']])
  })

  it('covers termination itself, before waiting for process completion', async () => {
    let waitedForDone = false
    await expect(deadline('terminate and done', 10, async () => {
      await new Promise(() => {})
      waitedForDone = true
    })).rejects.toThrow('terminate and done exceeded 10ms')
    expect(waitedForDone).toBe(false)
  })

  it('reports an unreferenced pending operation instead of exiting with unsettled await', () => {
    const moduleURL = new URL('./smoke-deadline.mjs', import.meta.url).href
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { deadline } from ${JSON.stringify(moduleURL)};
      try { await deadline('pending', 20, () => new Promise(() => {})); }
      catch (error) { console.log(error.message); }
      await deadline('completed', 5000, () => 'ok');
    `], { encoding: 'utf8', timeout: 2000 })
    expect(output.trim()).toBe('pending exceeded 20ms')
  })
})
