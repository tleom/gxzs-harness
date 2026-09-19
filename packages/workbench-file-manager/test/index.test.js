import { describe, expect, it, vi } from 'vitest'
import { FileManagerClient } from '../src/index.js'

const workspaceId = '00000000-0000-4000-8000-000000000001'

function create(fetchImpl) {
  vi.stubEnv('TEST_MANAGER_TOKEN', 'secret')
  return new FileManagerClient({
    baseUrl: 'http://manager.internal:5010/', workspaceId, tokenEnv: 'TEST_MANAGER_TOKEN', timeoutMs: 1000,
  }, { fetchImpl })
}

describe('restricted sandbox-manager file client', () => {
  it('binds every mutation to the configured workspace and bearer token', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ path: 'a.bin', version: 'v1' }) }))
    const manager = create(fetchImpl)
    await expect(manager.operate({ operation: 'upload', path: 'a.bin', version: null, data: 'AA==' })).resolves.toMatchObject({ version: 'v1' })
    expect(fetchImpl).toHaveBeenCalledWith(`http://manager.internal:5010/sandboxes/${workspaceId}/files`, expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer secret' }),
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
