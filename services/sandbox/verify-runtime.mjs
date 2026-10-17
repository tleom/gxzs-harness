import { accessSync, constants, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

const fontRoot = '/usr/local/share/fonts/workbench'
const fontManifest = JSON.parse(readFileSync(`${fontRoot}/manifest.json`, 'utf8'))
const fontFiles = new Map()
for (const item of fontManifest.files) {
  const name = basename(item.asset)
  if (!/^[a-f0-9]{64}\.(ttf|otf|ttc|otc)$/.test(name) || name.split('.')[0] !== item.sha256) {
    throw new Error('Invalid font asset manifest entry')
  }
  if (createHash('sha256').update(readFileSync(`${fontRoot}/${name}`)).digest('hex') !== item.sha256) {
    throw new Error(`Font asset integrity mismatch: ${name}`)
  }
  fontFiles.set(name, item.sha256)
}
const fontGeneration = fontFiles.size
  ? createHash('sha256').update([...fontFiles.keys()].sort().join('\n')).digest('hex') : 'system'
if (fontFiles.size !== fontManifest.uniqueFiles || fontGeneration !== fontManifest.generation) {
  throw new Error('Font asset generation or file count mismatch')
}

const helper = '/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'
const ptc = '/opt/dsh/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js'
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 is required')
for (const file of [helper, ptc, '/usr/bin/rg', '/usr/sbin/sshd', '/opt/office/uno_worker.py', '/usr/bin/Xvnc', '/usr/bin/xrandr',
  '/opt/office/node/node_modules/ws/package.json']) accessSync(file, constants.R_OK)
for (const [command, args] of [
  ['/usr/bin/git', ['--version']],
  ['/usr/bin/rg', ['--version']],
  ['/usr/bin/python3', ['-I', '-c', 'import uno']],
  ['/opt/workbench-mcp/bin/python', ['-I', '-c', 'from mcp.server.mcpserver import MCPServer; import httpx2']],
  [process.execPath, ['--check', helper]],
  [process.execPath, ['--check', ptc]],
]) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) throw new Error(`Runtime validation failed: ${command}: ${result.stderr || result.error}`)
}
console.log(JSON.stringify({ node: process.version, fonts: fontFiles.size, font_generation: fontGeneration,
  helper_sha256: createHash('sha256').update(readFileSync(helper)).digest('hex') }))
