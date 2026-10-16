import { describe, expect, it, vi } from 'vitest'
import { PlatformClient } from '../src/index.js'

function create(fetchImpl) {
  vi.stubEnv('TEST_PLATFORM_TOKEN', 'secret')
  vi.stubEnv('GXZS_HOST_GENERATION', '7')
  vi.stubEnv('GXZS_HOST_INSTANCE_ID', 'host-7')
  return new PlatformClient({ baseUrl: 'http://platform/internal/workbench/', tokenEnv: 'TEST_PLATFORM_TOKEN', timeoutMs: 1000 }, { fetchImpl })
}

describe('restricted platform client', () => {
  it('forwards preview cancellation with the same owner and correlation identity', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    const client = create(fetchImpl)
    const signal = new AbortController().signal
    const result = await client.request({ owner: { ownerId: 't:1' }, method: 'DELETE',
      route: 'files/preview', query: '?request_id=12345678-1234-1234-1234-123456789abc', signal })
    expect(result.status).toBe(204)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://platform/internal/workbench/files/preview?request_id=12345678-1234-1234-1234-123456789abc',
      expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ 'x-gxzs-owner': 't:1' }) }))
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'DELETE', route: 'files/arbitrary' }))
      .rejects.toThrow('unsupported platform route')
  })
  it('honors the remaining absolute deadline and sends it to the platform', async () => {
    const fetchImpl = vi.fn(async (_url, { signal }) => {
      signal.throwIfAborted()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const client = create(fetchImpl)
    const deadlineMs = Date.now() + 25
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'mcp/call', timeoutMs: 350_000, deadlineMs }))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fetchImpl.mock.calls[0][1].headers['x-gxzs-deadline-ms']).toBe(String(deadlineMs))
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'mcp/call', deadlineMs: Date.now() - 1 }))
      .rejects.toMatchObject({ status: 504, code: 'DEADLINE_EXCEEDED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('cancels response consumption as soon as the streaming size limit is exceeded', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(10)) }, cancel })
    const client = create(async () => new Response(stream))
    client.maxResponseBytes = 12
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'mcp/catalog' }))
      .rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects an excessive declared response length without reading its body', async () => {
    const cancel = vi.fn()
    const arrayBuffer = vi.fn()
    const client = create(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': '100' }), body: { cancel }, arrayBuffer }))
    client.maxResponseBytes = 12
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'mcp/catalog' }))
      .rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' })
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('revalidates configuration by owner and never returns a cached value on access denial', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"data":{"version":1}}', { headers: { etag: '"v1"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response('{"message":"denied","code":"HOST_REVOKED"}', { status: 403 }))
      .mockResolvedValueOnce(new Response('{"data":{"version":2}}', { headers: { etag: '"v2"' } }))
    const client = create(fetchImpl)
    const request = { owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config' }
    const first = await client.request(request)
    const second = await client.request(request)
    expect(Buffer.from(second.bytes).toString()).toBe(Buffer.from(first.bytes).toString())
    expect(fetchImpl.mock.calls[1][1].headers['if-none-match']).toBe('"v1"')
    await expect(client.request(request)).rejects.toMatchObject({ status: 403, code: 'HOST_REVOKED' })
    await client.request({ ...request, owner: { ownerId: 't:2' } })
    expect(fetchImpl.mock.calls[3][1].headers['if-none-match']).toBeUndefined()
    expect(client.configCache.has('t:1')).toBe(false)
  })
  it('propagates prompt cancellation and a per-request timeout to fetch', async () => {
    const fetchImpl = vi.fn(async (_url, { signal }) => {
      signal.throwIfAborted()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const client = create(fetchImpl)
    const controller = new AbortController()
    const request = client.request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config', signal: controller.signal })
    controller.abort(new Error('turn cancelled'))
    await expect(request).rejects.toThrow('turn cancelled')
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config', timeoutMs: 10 }))
      .rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('recovers transient config reads using current policy and the same request deadline', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"message":"recovering"}', { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(new Response('{"data":{"enabled":false}}'))
    const result = await create(fetchImpl).request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config' })
    expect(JSON.parse(Buffer.from(result.bytes).toString())).toEqual({ data: { enabled: false } })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(new Set(fetchImpl.mock.calls.map(([, options]) => options.signal)).size).toBe(1)
    expect(fetchImpl.mock.calls.every(([, options]) => options.headers['x-gxzs-owner'] === 't:1')).toBe(true)
  })

  it('bounds repeated config failures and never falls back to cached policy', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"data":{"enabled":true}}', { headers: { etag: '"old"' } }))
      .mockImplementation(async () => new Response('{"message":"still unavailable"}', { status: 503 }))
    const client = create(fetchImpl)
    const request = { owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config', timeoutMs: 5000 }
    await client.request(request)
    await expect(client.request(request)).rejects.toMatchObject({ status: 502, upstreamStatus: 503 })
    expect(fetchImpl).toHaveBeenCalledTimes(6)
    expect(client.configCache.has('t:1')).toBe(false)
  })

  it('does not restart the total timeout during config backoff', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }))
    await expect(create(fetchImpl).request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config', timeoutMs: 25 }))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('cancels config backoff without making another request', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }))
    const controller = new AbortController()
    const result = create(fetchImpl).request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config', signal: controller.signal })
    const rejected = expect(result).rejects.toThrow('cancel during backoff')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(new Error('cancel during backoff'))
    await rejected
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 404, 500])('does not retry a nontransient config status %s', async (status) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status }))
    await expect(create(fetchImpl).request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config' })).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('never retries tool calls, even for a transient upstream failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }))
    await expect(create(fetchImpl).request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'mcp/call', body: Buffer.from('{}') }))
      .rejects.toMatchObject({ status: 502 })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not retry oversized configuration responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('oversized', { headers: { 'content-length': '1000' } }))
    const client = create(fetchImpl)
    client.maxResponseBytes = 10
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'workbench/config' }))
      .rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('keeps unconfigured platform features unavailable without blocking the core host', async () => {
    const fetchImpl = vi.fn()
    const client = new PlatformClient({ baseUrl: '', tokenEnv: 'MISSING_TOKEN', timeoutMs: 1000 }, { fetchImpl })
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'audio' })).rejects.toMatchObject({ status: 503 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('forwards fixed preview routes with verified owner identity', async () => {
    const headers = new Headers({ 'content-type': 'application/pdf' })
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, headers, arrayBuffer: async () => Buffer.from('%PDF-').buffer }))
    const client = create(fetchImpl)
    await client.request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'files/preview', query: '?path=a.docx' })
    expect(fetchImpl).toHaveBeenCalledWith('http://platform/internal/workbench/files/preview?path=a.docx', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer secret', 'x-gxzs-owner': 't:1',
        'x-gxzs-host-generation': '7', 'x-gxzs-host-instance': 'host-7' }), redirect: 'error',
    }))
  })

  it('allows only fixed MCP catalog and call routes', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from('{"tools":[]}') }))
    const client = create(fetchImpl)
    await client.request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'mcp/catalog' })
    await client.request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'mcp/call', contentType: 'application/json', body: Buffer.from('{}') })
    await client.request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'mcp/cancel', contentType: 'application/json', body: Buffer.from('{"run_id":"run-1"}') })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://platform/internal/workbench/mcp/catalog', 'http://platform/internal/workbench/mcp/call',
      'http://platform/internal/workbench/mcp/cancel',
    ])
  })

  it('rejects arbitrary internal routes before network access', async () => {
    const fetchImpl = vi.fn()
    const client = create(fetchImpl)
    await expect(client.request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'admin' })).rejects.toThrow('unsupported platform route')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps platform client and server errors without redirects', async () => {
    const response = (status, body) => ({ ok: false, status, headers: new Headers(), arrayBuffer: async () => Buffer.from(JSON.stringify(body)) })
    await expect(create(async () => response(400, { message: 'bad' })).request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'audio' }))
      .rejects.toMatchObject({ status: 400, message: 'bad' })
    await expect(create(async () => response(503, {})).request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'audio' }))
      .rejects.toMatchObject({ status: 502 })
  })
})
