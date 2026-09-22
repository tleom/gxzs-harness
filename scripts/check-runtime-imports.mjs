// Run from the built image root; verifies the production dependency tree,
// including file: packages whose resolution differs from the dev workspace.
import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.argv[2] ?? '/opt/workbench/packages'
for (const packageName of await readdir(root)) {
  const folder = path.join(root, packageName, 'src')
  for (const file of await readdir(folder)) {
    if (!file.endsWith('.js')) continue
    await import(pathToFileURL(path.join(folder, file)).href)
  }
}
console.log('All production plugin modules imported')
