import { Service } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import z from '@deepseek-ai/schemastery'

export const name = 'workbench-platform-client'
export const Config = z.object({
  baseUrl: z.string().default(''),
  tokenEnv: z.string().default('GXZS_PLATFORM_INTERNAL_TOKEN'),
  timeoutMs: z.number().default(90_000),
  maxResponseBytes: z.number().default(32 * 1024 * 1024),
  generationEnv: z.string().default('GXZS_HOST_GENERATION'),
  instanceEnv: z.string().default('GXZS_HOST_INSTANCE_ID'),
})

const ROUTES = new Set([
  'GET files/preview', 'POST files/preview', 'DELETE files/preview',
  'GET files/shares', 'POST files/shares', 'DELETE files/shares',
  'POST audio',
  'GET mcp/catalog', 'GET mcp/plugins', 'POST mcp/call', 'POST mcp/cancel',
  'GET workbench/config',
  'POST scheduling',
])

function transientConfigRead(error) {
  return [502, 503, 504].includes(error?.upstreamStatus)
    || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN',
      'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
      .includes(error?.cause?.code ?? error?.code)
}

export class PlatformClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '')
    this.token = process.env[config.tokenEnv]
    const generationEnv = config.generationEnv ?? 'GXZS_HOST_GENERATION'
    const instanceEnv = config.instanceEnv ?? 'GXZS_HOST_INSTANCE_ID'
    this.generation = process.env[generationEnv]
    this.instance = process.env[instanceEnv]
    if (this.baseUrl && (!this.token || !/^\d+$/.test(this.generation ?? '') || !this.instance))
      throw new Error(`${config.tokenEnv}, ${generationEnv} and ${instanceEnv} are required`)
    if (this.baseUrl) {
      const url = new URL(this.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('platform baseUrl must be an HTTP(S) service base without credentials, query or fragment')
    }
    this.timeoutMs = config.timeoutMs ?? 90_000
    this.maxResponseBytes = config.maxResponseBytes ?? 32 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error('maxResponseBytes must be a positive integer')
    this.configCache = new Map()
    this.fetch = fetchImpl
  }

  async request({ owner, method, route, query = '', body = Buffer.alloc(0), contentType = '', signal, timeoutMs = this.timeoutMs, deadlineMs }) {
    const key = `${method.toUpperCase()} ${route}`
    if (!ROUTES.has(key)) throw new TypeError('unsupported platform route')
    if (query && !/^\?[^#\r\n]*$/.test(query)) throw new TypeError('invalid platform query')
    if (typeof owner?.ownerId !== 'string' || !owner.ownerId || /[\r\n]/.test(owner.ownerId)) throw new TypeError('invalid platform owner')
    if (!this.baseUrl) throw Object.assign(new Error('平台预览、分享与转写服务尚未配置'), { status: 503 })
    if (deadlineMs !== undefined) {
      if (!Number.isSafeInteger(deadlineMs)) throw new TypeError('deadlineMs must be an epoch millisecond integer')
      timeoutMs = Math.min(timeoutMs, deadlineMs - Date.now())
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Object.assign(new Error('平台请求已超过执行期限'), { status: 504, code: 'DEADLINE_EXCEEDED' })
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(timeoutMs))]) : AbortSignal.timeout(Math.ceil(timeoutMs))
    requestSignal.throwIfAborted()
    const cacheKey = key === 'GET workbench/config' && !query ? owner.ownerId : null
    const cached = cacheKey ? this.configCache.get(cacheKey) : null
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetch(`${this.baseUrl}/${route}${query}`, {
          method: method.toUpperCase(),
          headers: {
            authorization: `Bearer ${this.token}`,
            'x-gxzs-owner': owner.ownerId,
            'x-gxzs-host-generation': this.generation,
            'x-gxzs-host-instance': this.instance,
            ...(deadlineMs === undefined ? {} : { 'x-gxzs-deadline-ms': String(deadlineMs) }),
            ...(cached ? { 'if-none-match': cached.etag } : {}),
            ...(contentType ? { 'content-type': contentType } : {}),
          },
          body: body.length ? body : undefined,
          signal: requestSignal,
          redirect: 'error',
        })
        if (response.status === 304 && cached) return { status: 200, headers: cached.headers, bytes: cached.bytes.slice() }
        const bytes = await readBoundedResponse(response, this.maxResponseBytes, requestSignal)
        if (!response.ok) {
          if (cacheKey) this.configCache.delete(cacheKey)
          let message = '平台服务请求失败'
          let code
          try {
            const payload = JSON.parse(Buffer.from(bytes).toString('utf8'))
            message = payload.message || payload.msg || message
            if (typeof payload.code === 'string' && /^[A-Za-z][A-Za-z0-9_/-]{0,99}$/.test(payload.code)) code = payload.code
          } catch {}
          throw Object.assign(new Error(message), { status: response.status >= 400 && response.status < 500 ? response.status : 502, upstreamStatus: response.status, ...(code ? { code } : {}) })
        }
        const etag = response.headers.get('etag')
        if (cacheKey && etag) {
          // Revalidate on every read: no stale-on-error fallback for credentials,
          // model disablement or published prompt changes.
          if (this.configCache.size >= 16 && !this.configCache.has(cacheKey)) this.configCache.delete(this.configCache.keys().next().value)
          this.configCache.set(cacheKey, { etag, headers: response.headers, bytes: bytes.slice() })
        } else if (cacheKey) this.configCache.delete(cacheKey)
        return { status: response.status, headers: response.headers, bytes }
      } catch (error) {
        requestSignal.throwIfAborted()
        // Re-read current policy only. Never replay tools/mutations or extend
        // the caller's total deadline, and never substitute a stale config.
        if (!cacheKey || attempt >= 4 || !transientConfigRead(error)) throw error
        try { await delay(100 * 2 ** attempt, undefined, { signal: requestSignal }) }
        catch (waitError) { requestSignal.throwIfAborted(); throw waitError }
      }
    }
  }
}

async function readBoundedResponse(response, limit, signal) {
  const fail = () => Object.assign(new Error('平台服务响应超过大小限制'), { status: 502, code: 'UPSTREAM_RESPONSE_TOO_LARGE' })
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    await Promise.resolve(response.body?.cancel()).catch(() => {})
    throw fail()
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    signal.throwIfAborted()
    if (bytes.byteLength > limit) throw fail()
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw fail()
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
}

export class WorkbenchPlatformClient extends Service {
  constructor(ctx, config) {
    super(ctx, 'workbenchPlatformClient', true)
    this.client = new PlatformClient(config)
  }
  request(value) { return this.client.request(value) }
  async json(value) {
    const result = await this.client.request(value)
    try { return JSON.parse(Buffer.from(result.bytes).toString('utf8')) }
    catch { throw Object.assign(new Error('平台服务返回了无效 JSON'), { status: 502 }) }
  }
}

export function apply(ctx, config) { return new WorkbenchPlatformClient(ctx, config) }
