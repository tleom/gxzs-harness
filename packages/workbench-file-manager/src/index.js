import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { setTimeout as delay } from 'node:timers/promises'
import { managerFetch } from './transport.js'

export const name = 'workbench-file-manager'
export const Config = z.object({
  baseUrl: z.string().required(),
  workspaceId: z.string().required(),
  tokenEnv: z.string().default('GXZS_SANDBOX_MANAGER_TOKEN'),
  ownerEnv: z.string().default('GXZS_HOST_OWNER_ID'),
  generationEnv: z.string().default('GXZS_HOST_GENERATION'),
  instanceEnv: z.string().default('GXZS_HOST_INSTANCE_ID'),
  timeoutMs: z.number().default(90_000),
  // Legacy JSON file reads can encode a 100 MiB file; downloads use a separate stream.
  maxResponseBytes: z.number().default(140 * 1024 * 1024),
})

const ACTIONS = {
  files: new Set(['list', 'stat', 'manifest', 'get', 'upload', 'delete', 'mkdir']),
  'personal-resources': new Set(['list', 'skill_stage', 'skill_inspect', 'skill_prepare', 'skill_import', 'skill_import_cancel', 'skill_import_status', 'skill_update', 'skill_uninstall', 'skill_toggle', 'skill_reorder']),
  'personal-mcp': new Set(['mcp_list', 'mcp_read', 'mcp_save', 'mcp_delete', 'mcp_toggle', 'mcp_reorder', 'mcp_test']),
  'host-settings': new Set(['check']),
}

export class FileManagerClient {
  constructor(config, { fetchImpl = managerFetch } = {}) {
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
    this.maxResponseBytes = config.maxResponseBytes ?? 140 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive integer')
    this.fetch = fetchImpl
  }

  setMcpPolicy(policy) { this.mcpPolicy = Object.freeze({ ...policy }) }

  operate(payload, signal) { return this.request('files', payload, signal) }
  async personalResources(payload, signal) {
    if (payload?.operation !== 'skill_import' || !payload.import_id)
      return this.request('personal-resources', payload, signal)
    let result
    try { result = await this.request('personal-resources', payload, signal) }
    catch (error) {
      if (['RESOURCE_CONFLICT', 'SKILL_IMPORT_FAILED', 'SKILL_IMPORT_CANCELLED'].includes(error.code)
          || error.status && error.status < 500 && !signal?.aborted) throw error
      // The transport may disappear after publication. Settle using the same
      // durable import identity; never replay an uncertain mutation.
      result = await this.request('personal-resources', {
        operation: 'skill_import_cancel', import_id: payload.import_id,
      }).catch(() => ({ status: 'unknown' }))
    }
    if (['completed', 'running'].includes(result.status)) return result
    if (result.conflict || result.status === 'conflict') throw Object.assign(new Error('技能已修改，请重新导入'), { status: 409, code: 'RESOURCE_CONFLICT' })
    if (result.status === 'cancelled') throw Object.assign(new Error('技能导入已停止'), { status: 409, code: 'SKILL_IMPORT_CANCELLED' })
    throw Object.assign(new Error(result.error || '导入结果待确认，请刷新技能列表后重试查询'), {
      status: result.status === 'failed' ? 400 : 503,
      code: result.status === 'failed' ? 'SKILL_IMPORT_FAILED' : 'SKILL_IMPORT_UNCERTAIN',
    })
  }
  personalMcp(payload, signal) { return this.request('personal-mcp', payload, signal) }
  async assertSettingsWritable() {
    const result = await this.request('host-settings', { operation: 'check' })
    if (result.writable !== true) throw Object.assign(new Error('工作台正在维护，请稍后保存设置'), { status: 503, code: 'HOST_UPDATING' })
  }

  async download(path, signal) {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000)
    const response = await this.fetch(`${this.baseUrl}/sandboxes/${this.workspaceId}/files`, {
      method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json',
        'x-gxzs-owner': this.owner, 'x-gxzs-host-generation': this.generation, 'x-gxzs-host-instance': this.instance },
      body: JSON.stringify({ operation: 'download', path }), signal: requestSignal, redirect: 'error',
    })
    if (!response.ok) {
      const result = await managerJson(response, 256 * 1024)
      throw Object.assign(new Error(result.error || '文件下载失败'), { status: response.status, code: result.code })
    }
    try {
      const encoded = response.headers.get('x-workbench-file')
      if (!encoded || encoded.length > 16 * 1024) throw new Error('missing download metadata')
      const metadata = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || !['file', 'directory'].includes(metadata.kind)
        || typeof metadata.name !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.version)
        || Number(response.headers.get('content-length')) !== metadata.size || !response.body) throw new Error('invalid download metadata')
      return { ...metadata, body: response.body }
    } catch {
      await response.body?.cancel().catch(() => {})
      throw Object.assign(new Error('文件下载元数据无效'), { status: 502 })
    }
  }

  async upload(action, upload, signal) {
    if (!['files', 'personal-resources'].includes(action)) throw new TypeError('unsupported upload target')
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000)
    const header = Buffer.from(JSON.stringify(upload.metadata) + '\n')
    const size = header.length + upload.size - upload.offset
    for (let attempt = 0; ; attempt++) {
      requestSignal.throwIfAborted()
      const stream = Readable.from((async function* () {
        yield header
        yield* createReadStream(upload.path, { start: upload.offset, signal: requestSignal })
      })())
      try {
        const response = await this.fetch(`${this.baseUrl}/sandboxes/${this.workspaceId}/${action}`, {
          method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/octet-stream',
            'content-length': String(size), 'x-gxzs-owner': this.owner,
            'x-gxzs-host-generation': this.generation, 'x-gxzs-host-instance': this.instance },
          body: stream, duplex: 'half', signal: requestSignal, redirect: 'error',
        })
        const result = await managerJson(response, 256 * 1024)
        if (response.status === 503 && result.code === 'MANAGER_BUSY' && attempt < 3) {
          await delay(100 * 2 ** attempt, undefined, { signal: requestSignal }); continue
        }
        if (!response.ok || result.conflict) throw Object.assign(new Error(result.message || result.error || '文件上传失败'), {
          status: result.conflict ? 409 : response.status, code: result.code || (result.conflict ? 'RESOURCE_CONFLICT' : 'UPLOAD_FAILED'),
        })
        return result
      } catch (error) {
        if (upload.metadata.operation === 'skill_stage' && upload.metadata.import_id) {
          await this.request('personal-resources', { operation: 'skill_import_cancel',
            import_id: upload.metadata.import_id }).catch(() => {})
        }
        throw error
      } finally { stream.destroy() }
    }
  }

  async request(action, payload, signal) {
    const policy = this.mcpPolicy
    if (!ACTIONS[action]?.has(payload?.operation)) throw new TypeError(action === 'files' ? 'unsupported file operation' : `unsupported ${action} operation`)
    const timeoutMs = action === 'personal-resources' && (payload.import_id || ['skill_stage', 'skill_inspect', 'skill_import'].includes(payload.operation))
      ? ['skill_stage', 'skill_import'].includes(payload.operation) || !payload.import_id ? 600_000 : 10_000
      : Math.ceil(action === 'personal-mcp' ? (policy?.catalog_timeout_seconds ?? this.timeoutMs / 1000) * 1000 : this.timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
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
      const result = await managerJson(response, action === 'personal-mcp' ? policy?.response_bytes ?? this.maxResponseBytes : this.maxResponseBytes)
      const metadata = {
        code: typeof result.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.code) ? result.code : undefined,
        request_id: typeof result.request_id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(result.request_id) ? result.request_id : undefined,
        retry_after: Number.isInteger(result.retry_after) && result.retry_after >= 0 && result.retry_after <= 60 ? result.retry_after : undefined,
      }
      if (response.status === 409 || result.conflict) throw Object.assign(new Error(
        typeof (result.message ?? result.error) === 'string' ? (result.message ?? result.error).slice(0, 2048) : '内容已改变，请刷新后重试'),
      { ...metadata, status: 409, code: metadata.code ?? 'RESOURCE_CONFLICT' })
      // MANAGER_BUSY is issued before dispatch, so this exact request has not
      // run. Transport failures and other errors may have executed a mutation.
      if (response.status === 503 && result.code === 'MANAGER_BUSY' && attempt < (action === 'personal-mcp' ? policy?.control_retry_attempts ?? 3 : 3)) {
        await delay(Math.min(timeoutMs, 100 * 2 ** attempt) * (0.8 + Math.random() * 0.4), undefined, { signal: requestSignal })
        continue
      }
      if (!response.ok) throw Object.assign(new Error(result.error || '工作台资源操作失败'), {
        status: [400, 401, 403, 404, 413, 429, 503, 504].includes(response.status) ? response.status : 502,
        ...metadata,
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
  upload(action, upload, signal) { return this.client.upload(action, upload, signal) }
  download(path, signal) { return this.client.download(path, signal) }
  operate(payload, signal) { return this.client.operate(payload, signal) }
  personalResources(payload, signal) { return this.client.personalResources(payload, signal) }
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
