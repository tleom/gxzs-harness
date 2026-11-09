import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('preserves the public native child submission identity without changing another prompt branch', async () => {
  const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
  const source = await readFile(require.resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8')
  expect(source).toMatch(/this\.remote\.subagents\.prompt\(\{\s+requestId: requestId \?\? randomUUID\(\),/)
  expect(source).not.toMatch(/this\.remote\.subagents\.prompt\(\{\s+requestId: randomUUID\(\),/)
})
