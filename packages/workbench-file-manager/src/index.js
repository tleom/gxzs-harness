import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { setTimeout as delay } from 'node:timers/promises'

export const name = 'workbench-file-manager'
export const Config = z.object({
  baseUrl: z.string().required(),
  workspaceId: z.string().required(),
  tokenEnv: z.string().default('GXZS_SANDBOX_MANAGER_TOKEN'),
  ownerEnv: z.string().default('GXZS_HOST_OWNER_ID'),
  generationEnv: z.string().default('GXZS_HOST_GENERATION'),
  instanceEnv: z.string().default('GXZS_HOST_INSTANCE_ID'),
  timeoutMs: z.number().default(90_000),
  // A manager directory download allows 50 MiB before base64 encoding.
  maxResponseBytes: z.number().default(72 * 1024 * 1024),
})

const ACTIONS = {
  files: new Set(['list', 'stat', 'manifest', 'get', 'upload', 'delete', 'mkdir']),
  'personal-resources': new Set(['list', 'skill_inspect', 'skill_import', 'skill_update', 'skill_uninstall', 'skill_toggle', 'skill_reorder']),
  'personal-mcp': new Set(['mcp_list', 'mcp_read', 'mcp_save', 'mcp_delete', 'mcp_toggle', 'mcp_reorder', 'mcp_test']),
  'host-settings': new Set(['check']),
}

export class FileManagerClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.workspaceId = validateWorkspaceId(config.workspaceId)
    this.token = process.env[config.tokenEnv]
    if (!this.token) throw new Error(`${config.tokenEnv} is required`)
    this.owner = process.env[config.ownerEnv ?? 'GXZS_HOST_OWNER_ID']
    this.generation = process.env[config.generationEnv ?? 'GXZS_HOST_GENERATION']
    this.instance = process.env[config.instanceEnv ?? 'GXZS_HOST_INSTANCE_ID']
    if (!this.owner || /[\r\n]/.test(this.owner) || !/^\d+$/.test(this.generation ?? '') || !this.instance || /[\r\n]/.test(this.instance))
      throw new Error('sandbox manager owner, generation and instance identity are required')
    const url = new URL(this.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('sandbox manager baseUrl must be an HTTP(S) service base without credentials, query or fragment')
    this.timeoutMs = config.timeoutMs ?? 90_000
    this.maxResponseBytes = config.maxResponseBytes ?? 72 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive integer')
    this.fetch = fetchImpl
  }

  operate(payload, signal) { return this.request('files', payload, signal) }
  personalResources(payload) { return this.request('personal-resources', payload) }
  personalMcp(payload) { return this.request('personal-mcp', payload) }
  async assertSettingsWritable() {
    const result = await this.request('host-settings', { operation: 'check' })
    if (result.writable !== true) throw Object.assign(new Error('工作台正在维护，请稍后保存设置'), { status: 503, code: 'HOST_UPDATING' })
  }

  async request(action, payload, signal) {
    if (!ACTIONS[action]?.has(payload?.operation)) throw new TypeError(action === 'files' ? 'unsupported file operation' : `unsupported ${action} operation`)
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
    const body = JSON.stringify(payload)
    for (let attempt = 0; ; attempt++) {
      requestSignal.throwIfAborted()
      const response = await this.fetch(`${this.baseUrl}/sandboxes/${this.workspaceId}/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json',
          'x-gxzs-owner': this.owner, 'x-gxzs-host-generation': this.generation, 'x-gxzs-host-instance': this.instance },
        body,
        signal: requestSignal,
        redirect: 'error',
      })
      const result = await managerJson(response, this.maxResponseBytes)
      if (response.status === 409 || result.conflict) throw Object.assign(new Error(result.message || '内容已改变，请刷新后重试'), { status: 409, code: 'RESOURCE_CONFLICT' })
      // MANAGER_BUSY is issued before dispatch, so this exact request has not
      // run. Transport failures and other errors may have executed a mutation.
      if (response.status === 503 && result.code === 'MANAGER_BUSY' && attempt < 3) {
        await delay(100 * 2 ** attempt * (0.8 + Math.random() * 0.4), undefined, { signal: requestSignal })
        continue
      }
      if (!response.ok) throw Object.assign(new Error(result.error || '工作台资源操作失败'), {
        status: [400, 401, 403, 404, 413, 429, 503, 504].includes(response.status) ? response.status : 502,
        code: typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.code) ? result.code : undefined,
        request_id: typeof result.request_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(result.request_id) ? result.request_id : undefined,
        retry_after: Number.isInteger(result.retry_after) && result.retry_after >= 0 && result.retry_after <= 60 ? result.retry_after : undefined,
      })
      return result
    }
  }
}

async function managerJson(response, limit) {
  const fail = () => Object.assign(new Error('工作台资源服务响应超过大小限制'), { status: 502, code: 'UPSTREAM_RESPONSE_TOO_LARGE' })
  const declared = response.headers?.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await Promise.resolve(response.body?.cancel()).catch(() => {})
    throw fail()
  }
  let text
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) throw fail()
        chunks.push(value)
      }
      text = Buffer.concat(chunks, size).toString('utf8')
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally { reader.releaseLock() }
  } else {
    // Compatibility with injected transports; fetch Responses use the bounded
    // streaming branch above, including responses without Content-Length.
    text = response.text ? await response.text() : JSON.stringify(await response.json())
    if (Buffer.byteLength(text, 'utf8') > limit) throw fail()
  }
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value
  }
  catch { throw Object.assign(new Error('工作台资源服务返回了无效 JSON'), { status: 502, code: 'INVALID_UPSTREAM_RESPONSE' }) }
}

export class WorkbenchFileManager extends Service {
  constructor(ctx, config) {
    super(ctx, 'workbenchFileManager', true)
    this.client = new FileManagerClient(config)
  }
  get workspaceId() { return this.client.workspaceId }
  operate(payload, signal) { return this.client.operate(payload, signal) }
  personalResources(payload) { return this.client.personalResources(payload) }
  personalMcp(payload) { return this.client.personalMcp(payload) }
  assertSettingsWritable() { return this.client.assertSettingsWritable() }
}

export function apply(ctx, config) { return new WorkbenchFileManager(ctx, config) }

function validateWorkspaceId(value) {
  const text = String(value ?? '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new Error('workspaceId must be a UUID')
  return text.toLowerCase()
}
