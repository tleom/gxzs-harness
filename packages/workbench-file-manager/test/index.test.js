import { describe, expect, it, vi } from 'vitest'
import { FileManagerClient } from '../src/index.js'

const workspaceId = '00000000-0000-4000-8000-000000000001'

function create(fetchImpl) {
  vi.stubEnv('TEST_MANAGER_TOKEN', 'secret')
  vi.stubEnv('GXZS_HOST_OWNER_ID', 't:1')
  vi.stubEnv('GXZS_HOST_GENERATION', '7')
  vi.stubEnv('GXZS_HOST_INSTANCE_ID', 'host-7')
  return new FileManagerClient({
    baseUrl: 'http://manager.internal:5010/', workspaceId, tokenEnv: 'TEST_MANAGER_TOKEN', timeoutMs: 1000,
  }, { fetchImpl })
}

describe('restricted sandbox-manager file client', () => {
  it('retains temporary capacity errors and safe correlation metadata', async () => {
    const manager = create(async () => new Response(JSON.stringify({error:'资源繁忙',code:'MANAGER_BUSY',request_id:'request-1',retry_after:2}),{status:503}))
    await expect(manager.operate({operation:'list'})).rejects.toMatchObject({status:503,code:'MANAGER_BUSY',request_id:'request-1',retry_after:2})
  })
  it('propagates caller cancellation to the authorized read', async () => {
    const controller = new AbortController()
    const manager = create(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true})
    }))
    const reading = manager.operate({operation:'get',path:'test.docx'},controller.signal)
    controller.abort()
    await expect(reading).rejects.toMatchObject({name:'AbortError'})
  })
  it('fails closed when host identity is missing and refuses redirect credentials', () => {
    const manager = create(vi.fn())
    vi.stubEnv('GXZS_HOST_OWNER_ID', '')
    expect(() => new FileManagerClient({ baseUrl: manager.baseUrl, workspaceId, tokenEnv: 'TEST_MANAGER_TOKEN' })).toThrow('identity')
  })

  it('bounds a streamed manager response and rejects malformed JSON', async () => {
    const cancel = vi.fn()
    const manager = create(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(10)) }, cancel })))
    manager.maxResponseBytes = 12
    await expect(manager.operate({ operation: 'list' })).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_RESPONSE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
    await expect(create(async () => new Response('invalid')).operate({ operation: 'list' }))
      .rejects.toMatchObject({ status: 502, code: 'INVALID_UPSTREAM_RESPONSE' })
  })
  it('binds every mutation to the configured workspace and bearer token', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ path: 'a.bin', version: 'v1' }) }))
    const manager = create(fetchImpl)
    await expect(manager.operate({ operation: 'upload', path: 'a.bin', version: null, data: 'AA==' })).resolves.toMatchObject({ version: 'v1' })
    expect(fetchImpl).toHaveBeenCalledWith(`http://manager.internal:5010/sandboxes/${workspaceId}/files`, expect.objectContaining({
      method: 'POST', redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer secret',
        'x-gxzs-owner': 't:1', 'x-gxzs-host-generation': '7', 'x-gxzs-host-instance': 'host-7' }),
    }))
  })

  it('routes personal resources and MCP to fixed manager actions', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    const manager = create(fetchImpl)
    await manager.personalResources({ operation: 'skill_toggle', name: 'demo', enabled: true })
    await manager.personalMcp({ operation: 'mcp_list' })
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `http://manager.internal:5010/sandboxes/${workspaceId}/personal-resources`,
      `http://manager.internal:5010/sandboxes/${workspaceId}/personal-mcp`,
    ])
  })

  it('rejects arbitrary operations before network access', async () => {
    const fetchImpl = vi.fn()
    const manager = create(fetchImpl)
    await expect(manager.operate({ operation: 'shell', path: 'a' })).rejects.toThrow('unsupported file operation')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps manager conflicts and validation errors', async () => {
    const conflict = create(async () => ({ ok: true, status: 200, json: async () => ({ conflict: true, message: 'stale' }) }))
    await expect(conflict.operate({ operation: 'delete', path: 'a', version: 'old' })).rejects.toMatchObject({ status: 409 })
    const invalid = create(async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad path' }) }))
    await expect(invalid.operate({ operation: 'mkdir', path: '../x' })).rejects.toMatchObject({ status: 400 })
  })
})
