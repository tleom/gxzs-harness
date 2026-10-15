import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { sessionClientSubmissionIdentity } from '../../../scripts/prepare-session-client.mjs'

it('preserves the public native child submission identity without changing another prompt branch', async () => {
  const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
  const source = await readFile(require.resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8')
  const prepared = sessionClientSubmissionIdentity(source)
  expect(prepared).toContain('requestId: requestId ?? randomUUID(),')
  expect(prepared).not.toMatch(/this\.remote\.subagents\.prompt\(\{\s+requestId: randomUUID\(\),/)
  expect(sessionClientSubmissionIdentity(prepared)).toBe(prepared)
  const replacements = source.replace(/(this\.remote\.subagents\.prompt\(\{\s+requestId: )randomUUID\(\),/, '$1requestId ?? randomUUID(),')
  expect(prepared).toBe(replacements)
})

it('rejects a changed or ambiguous upstream submission contract instead of guessing a new implementation', () => {
  expect(() => sessionClientSubmissionIdentity('unknown bundle')).toThrow('contract changed')
  const branch = 'this.remote.subagents.prompt({ requestId: randomUUID(),'
  expect(() => sessionClientSubmissionIdentity('async prompt(content, mode, signal, requestId) ' + branch + branch)).toThrow('contract changed')
})
