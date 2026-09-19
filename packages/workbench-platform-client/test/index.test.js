import { describe, expect, it, vi } from 'vitest'
import { PlatformClient } from '../src/index.js'

function create(fetchImpl) {
  vi.stubEnv('TEST_PLATFORM_TOKEN', 'secret')
  return new PlatformClient({ baseUrl: 'http://platform/internal/workbench/', tokenEnv: 'TEST_PLATFORM_TOKEN', timeoutMs: 1000 }, { fetchImpl })
}

describe('restricted platform client', () => {
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
      headers: expect.objectContaining({ authorization: 'Bearer secret', 'x-gxzs-owner': 't:1' }), redirect: 'error',
    }))
  })

  it('allows only fixed MCP catalog and call routes', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from('{"tools":[]}') }))
    const client = create(fetchImpl)
    await client.request({ owner: { ownerId: 't:1' }, method: 'GET', route: 'mcp/catalog' })
    await client.request({ owner: { ownerId: 't:1' }, method: 'POST', route: 'mcp/call', contentType: 'application/json', body: Buffer.from('{}') })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://platform/internal/workbench/mcp/catalog', 'http://platform/internal/workbench/mcp/call',
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
