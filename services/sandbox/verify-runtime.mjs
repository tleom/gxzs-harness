import { accessSync, constants, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const helper = '/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'
const ptc = '/opt/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js'
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 is required')
for (const file of [helper, ptc, '/usr/bin/rg', '/usr/sbin/sshd', '/opt/office/uno_worker.py', '/usr/bin/Xvnc', '/usr/bin/xrandr',
  '/opt/office/node/node_modules/ws/package.json']) accessSync(file, constants.R_OK)
for (const [command, args] of [
  ['/usr/bin/rg', ['--version']],
  ['/usr/bin/python3', ['-I', '-c', 'import uno']],
  ['/opt/workbench-mcp/bin/python', ['-I', '-c', 'from mcp.server.mcpserver import MCPServer; import httpx2']],
  [process.execPath, ['--check', helper]],
  [process.execPath, ['--check', ptc]],
]) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) throw new Error(`Runtime validation failed: ${command}: ${result.stderr || result.error}`)
}
console.log(JSON.stringify({ node: process.version, helper_sha256: createHash('sha256').update(readFileSync(helper)).digest('hex') }))
