import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

async function files(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...await files(target))
    else if (entry.isFile() && /\.(?:js|cjs)$/.test(target)) result.push(target)
  }
  return result
}

for (const file of await files(path.resolve('packages'))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
