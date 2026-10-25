import { describe, expect, it, vi } from 'vitest'
import { FileManagerClient, WorkbenchFileManager } from '../src/index.js'

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
  it.each(['copy', 'move'])('forwards %s through the existing owner-bound file channel', async operation => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({path:'b'})))
    await create(fetchImpl).operate({operation,path:'a',destination:'b'})
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({operation,path:'a',destination:'b'})
    expect(fetchImpl.mock.calls[0][1].headers['x-gxzs-owner']).toBe('t:1')
  })
  it('applies published MCP policy and cancellation through the registered service', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const client = create(async () => new Response(JSON.stringify({ value: 'x'.repeat(2048) })))
    const service = Object.assign(Object.create(WorkbenchFileManager.prototype), { client })
    try {
      service.setMcpPolicy({ catalog_timeout_seconds: 180, response_bytes: 1024 })
      await expect(service.personalMcp({ operation: 'mcp_test' })).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' })
      expect(timeout).toHaveBeenCalledWith(180_000)
      service.setMcpPolicy({ catalog_timeout_seconds: 200, response_bytes: 4096 })
      await expect(service.personalMcp({ operation: 'mcp_test' })).resolves.toEqual({ value: 'x'.repeat(2048) })
      expect(timeout).toHaveBeenCalledWith(200_000)
      const controller = new AbortController()
      controller.abort()
      await expect(service.personalMcp({ operation: 'mcp_test' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally { timeout.mockRestore() }
  })
  it('preserves a confirmed conflict even when the caller aborts after the response', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      return new Response(JSON.stringify({ error: 'changed', code: 'RESOURCE_CONFLICT' }), { status: 409 })
    })
    await expect(create(fetchImpl).personalResources({ operation: 'skill_import', import_id: 'd'.repeat(32), version: null }, controller.signal))
      .rejects.toMatchObject({ status: 409, code: 'RESOURCE_CONFLICT' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('keeps the initial personal MCP response budget for an in-flight request', async () => {
    const client = create(async () => {
      client.setMcpPolicy({ catalog_timeout_seconds: 1, response_bytes: 128 })
      return new Response(JSON.stringify({ value: 'x'.repeat(2048) }))
    })
    client.setMcpPolicy({ catalog_timeout_seconds: 3, response_bytes: 4096 })
    await expect(client.personalMcp({ operation: 'mcp_list' })).resolves.toEqual({ value: 'x'.repeat(2048) })
  })

  it('settles an aborted import from a remote receipt without replaying its mutation', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn().mockImplementationOnce(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', id: 'demo', version: 'v1' })))
    await expect(create(fetchImpl).personalResources({ operation: 'skill_import', import_id: 'a'.repeat(32), version: null }, controller.signal))
      .resolves.toMatchObject({ status: 'completed', version: 'v1' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls.map(([, options]) => JSON.parse(options.body).operation)).toEqual(['skill_import', 'skill_import_cancel'])
    expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(false)
  })
  it.each([['cancelled', 'SKILL_IMPORT_CANCELLED'], ['unknown', 'SKILL_IMPORT_UNCERTAIN'], ['failed', 'SKILL_IMPORT_FAILED']])
    ('distinguishes a %s import result', async (status, code) => {
      const manager = create(async () => new Response(JSON.stringify({ status })))
      await expect(manager.personalResources({ operation: 'skill_import', import_id: 'a'.repeat(32), version: null }))
        .rejects.toMatchObject({ code })
    })
  it.each(['PROFILE_UPGRADE_PREPARING', 'FILE_VERSION_CONFLICT'])('preserves %s conflict identity without retrying a mutation', async code => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: '当前状态冲突', code, request_id: 'request-1', retry_after: 5 }), { status: 409 }))
    await expect(create(fetchImpl).operate({ operation: 'delete', path: 'large.bin', version: 'old' }))
      .rejects.toMatchObject({ status: 409, code, request_id: 'request-1', retry_after: 5, message: '当前状态冲突' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('bounds untrusted conflict metadata and retains the legacy fallback', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ conflict: true, code: 'bad\ncode', request_id: 'x'.repeat(129), retry_after: 999 })))
    await expect(create(fetchImpl).operate({ operation: 'delete' }))
      .rejects.toMatchObject({ status: 409, code: 'RESOURCE_CONFLICT', request_id: undefined, retry_after: undefined })
  })
  it('checks the current owner Host lifecycle through a fixed non-model operation and requires explicit acceptance', async () => {
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({writable:true})))
    const manager=create(fetchImpl)
    await manager.assertSettingsWritable()
    expect(fetchImpl).toHaveBeenCalledWith(`http://manager.internal:5010/sandboxes/${workspaceId}/host-settings`,expect.objectContaining({
      body:JSON.stringify({operation:'check'}),headers:expect.objectContaining({'x-gxzs-host-generation':'7','x-gxzs-host-instance':'host-7'}),
    }))
    fetchImpl.mockResolvedValue(new Response('{}'))
    await expect(manager.assertSettingsWritable()).rejects.toMatchObject({status:503,code:'HOST_UPDATING'})
  })
  it('forwards the native caller signal through the service boundary', () => {
    const operate = vi.fn(), signal = new AbortController().signal;
    const payload = { operation: 'list', path: '.' };
    WorkbenchFileManager.prototype.operate.call({ client: { operate } }, payload, signal);
    expect(operate).toHaveBeenCalledWith(payload, signal);
  })
  it('retains temporary capacity errors and safe correlation metadata', async () => {
    const manager = create(async () => new Response(JSON.stringify({error:'资源繁忙',code:'MANAGER_BUSY',request_id:'request-1',retry_after:2}),{status:503}))
    await expect(manager.operate({operation:'list'})).rejects.toMatchObject({status:503,code:'MANAGER_BUSY',request_id:'request-1',retry_after:2})
  })
  it('retries only explicit pre-dispatch capacity rejection with the same body and deadline', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({code:'MANAGER_BUSY'}),{status:503}))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ok:true})))
    await expect(create(fetchImpl).operate({operation:'mkdir',path:'new-chat'})).resolves.toEqual({ok:true})
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const first = fetchImpl.mock.calls[0][1], second = fetchImpl.mock.calls[1][1]
    expect(second.body).toBe(first.body)
    expect(second.signal).toBe(first.signal)
  })
  it.each([new TypeError('connection closed'), {status:503,code:'SANDBOX_UPDATING'}, {status:500,code:'MANAGER_BUSY'}])('does not replay mutations after ambiguous failures or lifecycle errors: %s', async (failure) => {
    const fetchImpl = vi.fn(async () => {
      if (failure instanceof Error) throw failure
      return new Response(JSON.stringify({code:failure.code}),{status:failure.status})
    })
    await expect(create(fetchImpl).operate({operation:'delete',path:'test-only'})).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
  it('stops a busy retry when the caller cancels', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      return new Response(JSON.stringify({code:'MANAGER_BUSY'}),{status:503})
    })
    await expect(create(fetchImpl).operate({operation:'list'},controller.signal)).rejects.toMatchObject({name:'AbortError'})
    expect(fetchImpl).toHaveBeenCalledOnce()
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


it('streams a package from disk and preserves scoped credentials and exact length', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'manager-upload-test-'))
  try {
    const path = join(directory, 'body')
    await writeFile(path, Buffer.from([10, 0, 255, 42]))
    const metadata = { operation: 'upload', path: 'a.bin', size: 3 }
    const fetchImpl = vi.fn(async (_url, options) => {
      const chunks = []
      for await (const chunk of options.body) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      expect(body).toEqual(Buffer.concat([Buffer.from(JSON.stringify(metadata) + '\n'), Buffer.from([0, 255, 42])]))
      expect(Number(options.headers['content-length'])).toBe(body.length)
      expect(options.headers['x-gxzs-host-generation']).toBe('7')
      expect(options.duplex).toBe('half')
      return new Response('{"path":"a.bin","version":"v2"}')
    })
    expect(await create(fetchImpl).upload('files', { path, size: 4, offset: 1, metadata })).toMatchObject({ version: 'v2' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('returns a streamed download and validates its metadata', async () => {
  const metadata = { name: 'a.bin', kind: 'file', size: 3, version: 'a'.repeat(64) }
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0, 255, 42]), { headers: {
    'content-length': '3', 'x-workbench-file': Buffer.from(JSON.stringify(metadata)).toString('base64url'),
  } }))
  const result = await create(fetchImpl).download('a.bin')
  expect(Buffer.from(await new Response(result.body).arrayBuffer())).toEqual(Buffer.from([0, 255, 42]))
  expect(result.version).toBe(metadata.version)
  fetchImpl.mockResolvedValue(new Response('bad', { headers: { 'x-workbench-file': 'invalid' } }))
  await expect(create(fetchImpl).download('a.bin')).rejects.toThrow()
})
