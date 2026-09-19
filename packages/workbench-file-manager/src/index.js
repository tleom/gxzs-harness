import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'workbench-file-manager'
export const Config = z.object({
  baseUrl: z.string().required(),
  workspaceId: z.string().required(),
  tokenEnv: z.string().default('GXZS_SANDBOX_MANAGER_TOKEN'),
  timeoutMs: z.number().default(90_000),
})

const ACTIONS = {
  files: new Set(['list', 'stat', 'manifest', 'get', 'upload', 'delete', 'mkdir']),
  'personal-resources': new Set(['list', 'memory_update', 'skill_inspect', 'skill_import', 'skill_update', 'skill_uninstall', 'skill_toggle', 'skill_pin']),
  'personal-mcp': new Set(['mcp_list', 'mcp_read', 'mcp_save', 'mcp_delete', 'mcp_toggle', 'mcp_pin', 'mcp_test']),
}

export class FileManagerClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.workspaceId = validateWorkspaceId(config.workspaceId)
    this.token = process.env[config.tokenEnv]
    if (!this.token) throw new Error(`${config.tokenEnv} is required`)
    this.timeoutMs = config.timeoutMs
    this.fetch = fetchImpl
  }

  operate(payload) { return this.request('files', payload) }
  personalResources(payload) { return this.request('personal-resources', payload) }
  personalMcp(payload) { return this.request('personal-mcp', payload) }

  async request(action, payload) {
    if (!ACTIONS[action]?.has(payload?.operation)) throw new TypeError(action === 'files' ? 'unsupported file operation' : `unsupported ${action} operation`)
    const response = await this.fetch(`${this.baseUrl}/sandboxes/${this.workspaceId}/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const result = await response.json().catch(() => ({}))
    if (response.status === 409 || result.conflict) throw Object.assign(new Error(result.message || '内容已改变，请刷新后重试'), { status: 409 })
    if (!response.ok) throw Object.assign(new Error(result.error || '工作台资源操作失败'), { status: response.status === 400 ? 400 : 502 })
    return result
  }
}

export class WorkbenchFileManager extends Service {
  constructor(ctx, config) {
    super(ctx, 'workbenchFileManager', true)
    this.client = new FileManagerClient(config)
  }
  get workspaceId() { return this.client.workspaceId }
  operate(payload) { return this.client.operate(payload) }
  personalResources(payload) { return this.client.personalResources(payload) }
  personalMcp(payload) { return this.client.personalMcp(payload) }
}

export function apply(ctx, config) { return new WorkbenchFileManager(ctx, config) }

function validateWorkspaceId(value) {
  const text = String(value ?? '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new Error('workspaceId must be a UUID')
  return text.toLowerCase()
}
