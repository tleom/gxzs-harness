import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve('.tmp/config-check')
const home = path.join(root, 'home')
const profileSource = path.resolve('profiles/workbench')
const profileTarget = path.join(home, 'profiles/workbench')
const packages = [
  'workbench-adapter', 'workbench-control-commands', 'workbench-file-manager',
  'workbench-platform-client', 'workbench-sandbox-skills', 'workbench-mcp-tools',
  'workbench-sandbox-runtime',
]
rmSync(root, { recursive: true, force: true })
mkdirSync(path.dirname(profileTarget), { recursive: true })
cpSync(profileSource, profileTarget, {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}node_modules`),
})
cpSync(path.join(profileSource, 'cordis.runtime.patch.yml'), path.join(profileTarget, 'cordis.patch.yml'))
for (const name of packages) {
  cpSync(path.resolve('packages', name), path.join(home, 'packages', name), {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`),
  })
}

const cli = path.resolve('profiles/workbench/node_modules/.bin/dsh')
const result = spawnSync(cli, ['--profile', 'workbench', '--dump-config'], {
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    GXZS_ASSERTION_ISSUER: 'config-check',
    GXZS_HOST_OWNER_ID: 'config-check:1',
    GXZS_HOST_GENERATION: '1',
    GXZS_HOST_INSTANCE_ID: 'config-check-host-1',
    GXZS_SANDBOX_MANAGER_URL: 'http://sandbox-manager.internal:5010',
    GXZS_SANDBOX_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
    GXZS_SANDBOX_MANAGER_TOKEN: 'config-check-token',
    GXZS_SANDBOX_SSH_HOST: 'config-check-sandbox',
    GXZS_SANDBOX_NODE: '/usr/local/bin/node',
    GXZS_SANDBOX_HELPER: '/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js',
    GXZS_SANDBOX_HELPER_HASH: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    GXZS_SANDBOX_WORKSPACE: '/workspace',
    GXZS_PLATFORM_INTERNAL_URL: 'http://platform.internal:8080/internal/workbench',
    GXZS_PLATFORM_INTERNAL_TOKEN: 'config-check-platform-token',
    GXZS_ASSERTION_SIGNING_KEY: Buffer.alloc(32, 1).toString('base64'),
  },
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.status !== 0) process.exit(result.status ?? 1)
if (/mismatch/i.test(result.stderr || '')) throw new Error('DSH patch contains a name mismatch')
if (!(result.stdout || '').includes('@gxzs/dsh-workbench-adapter'))
  throw new Error('workbench adapter row is missing')
if (!(result.stdout || '').includes('@gxzs/dsh-workbench-mcp-tools'))
  throw new Error('workbench MCP proxy row is missing')
if (!(result.stdout || '').includes('@gxzs/dsh-workbench-sandbox-runtime/fs'))
  throw new Error('workbench attachment filesystem mapping row is missing')
