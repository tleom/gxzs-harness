// Add an explicit task executor seam to the pinned native bridge. Keep its
// validation, errors, structured output and attachment projection unchanged.
import { readFile, writeFile, rename, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function patchMcpTasks(root) {
  const info = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  if (info.version !== '0.2.1-rc.2') throw new Error('DSH MCP version changed; review the task executor seam')
  const file = resolve(root, 'lib/index.js')
  let source = await readFile(file, 'utf8')
  const changes = [
    ['if (taskRequired) throw new Error(', 'if (taskRequired && typeof options.taskCall !== "function") throw new Error('],
    ['validate(await options.call(argsObj, exec))', 'validate(await (taskRequired ? options.taskCall : options.call)(argsObj, exec))'],
  ]
  for (const [before, after] of changes) {
    if (source.includes(after)) continue
    if (source.split(before).length !== 2) throw new Error('DSH MCP task seam anchor changed')
    source = source.replace(before, after)
  }
  // Replace the inode so a pnpm content-addressed store is never modified.
  const staging = file + '.gxzs-tasks'
  await writeFile(staging, source)
  await rename(staging, file)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2]) await patchMcpTasks(resolve(process.argv[2]))
  else {
    await patchMcpTasks(resolve(import.meta.dirname, '../profiles/workbench/node_modules/@deepseek-ai/dsh-mcp-client'))
    const workspace = resolve(import.meta.dirname, '../packages/workbench-mcp-tools/node_modules/@deepseek-ai/dsh-mcp-client')
    if (await access(workspace).then(() => true, () => false)) await patchMcpTasks(workspace)
  }
}
