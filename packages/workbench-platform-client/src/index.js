import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'workbench-platform-client'
export const Config = z.object({
  baseUrl: z.string().default(''),
  tokenEnv: z.string().default('GXZS_PLATFORM_INTERNAL_TOKEN'),
  timeoutMs: z.number().default(90_000),
  generationEnv: z.string().default('GXZS_HOST_GENERATION'),
  instanceEnv: z.string().default('GXZS_HOST_INSTANCE_ID'),
})

const ROUTES = new Set([
  'GET files/preview', 'POST files/preview',
  'GET files/shares', 'POST files/shares', 'DELETE files/shares',
  'POST audio',
  'GET mcp/catalog', 'POST mcp/call',
  'GET workbench/config',
])

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
    this.timeoutMs = config.timeoutMs
    this.fetch = fetchImpl
  }

  async request({ owner, method, route, query = '', body = Buffer.alloc(0), contentType = '' }) {
    const key = `${method.toUpperCase()} ${route}`
    if (!ROUTES.has(key)) throw new TypeError('unsupported platform route')
    if (!this.baseUrl) throw Object.assign(new Error('平台预览、分享与转写服务尚未配置'), { status: 503 })
    const response = await this.fetch(`${this.baseUrl}/${route}${query}`, {
      method: method.toUpperCase(),
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-gxzs-owner': owner.ownerId,
        'x-gxzs-host-generation': this.generation,
        'x-gxzs-host-instance': this.instance,
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!response.ok) {
      let message = '平台服务请求失败'
      try { message = JSON.parse(Buffer.from(bytes).toString('utf8')).message || message } catch {}
      throw Object.assign(new Error(message), { status: response.status >= 400 && response.status < 500 ? response.status : 502 })
    }
    return { status: response.status, headers: response.headers, bytes }
  }
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
