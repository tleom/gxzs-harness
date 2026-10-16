import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlatformClient } from '../src/index.js'

const owner = { ownerId: 'tenant:user' }
const request = { owner, method: 'GET', route: 'mcp/catalog', timeoutMs: 10_000 }
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function create(fetchImpl) {
  vi.stubEnv('TEST_PLATFORM_TOKEN', 'secret')
  vi.stubEnv('GXZS_HOST_GENERATION', '7')
  vi.stubEnv('GXZS_HOST_INSTANCE_ID', 'host-7')
  return new PlatformClient({ baseUrl: 'http://platform/internal', tokenEnv: 'TEST_PLATFORM_TOKEN' }, { fetchImpl })
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('catalog admission pressure', () => {
  it('serializes same-owner reads but fetches each current revision and does not block another owner', async () => {
    const gate = pending()
    const fetchImpl = vi.fn(async (_url, { headers }) => {
      if (fetchImpl.mock.calls.length === 1) await gate.promise
      return new Response(JSON.stringify({ owner: headers['x-gxzs-owner'], revision: fetchImpl.mock.calls.length }))
    })
    const client = create(fetchImpl)
    const first = client.request(request)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    const second = client.request(request)
    const third = await client.request({ ...request, owner: { ownerId: 'tenant:other' } })
    expect(JSON.parse(Buffer.from(third.bytes).toString()).owner).toBe('tenant:other')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    gate.resolve()
    await first
    const latest = await second
    expect(JSON.parse(Buffer.from(latest.bytes).toString()).revision).toBe(3)
    await client.request(request)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    await vi.waitFor(() => expect(client.catalogReads.size).toBe(0))
  })

  it('cancels a queued read without letting later readers bypass an active read', async () => {
    const gate = pending()
    const fetchImpl = vi.fn(async () => { await gate.promise; return new Response('{}') })
    const client = create(fetchImpl)
    const first = client.request(request)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const cancelled = expect(client.request({ ...request, signal: controller.signal })).rejects.toThrow('cancel queued')
    controller.abort(new Error('cancel queued'))
    await cancelled
    const third = client.request(request)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fetchImpl).toHaveBeenCalledOnce()
    gate.resolve()
    await Promise.all([first, third])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(client.catalogReads.size).toBe(0))
  })

  it('includes queue wait in the caller deadline and releases a timed-out queue entry', async () => {
    const gate = pending()
    const fetchImpl = vi.fn(async () => { await gate.promise; return new Response('{}') })
    const client = create(fetchImpl)
    const first = client.request(request)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    await expect(client.request({ ...request, timeoutMs: 20 })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    gate.resolve()
    await first
    await client.request(request)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(client.catalogReads.size).toBe(0))
  })

  it.each([401, 403])('does not retry or reuse a successful catalog after access denial %s', async status => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('{"tools":[]}'))
      .mockResolvedValueOnce(new Response('{}', { status }))
    const client = create(fetchImpl)
    await client.request(request)
    await expect(client.request(request)).rejects.toMatchObject({ status })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(client.catalogReads.size).toBe(0))
  })

  it('honors retry-after without restarting the total deadline', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"retry_after":1}', { status: 503 }))
    const client = create(fetchImpl)
    await expect(client.request({ ...request, timeoutMs: 50 })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(client.catalogReads.size).toBe(0))
  })

  it('retries a transient catalog failure using a fresh response and unchanged identity', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('{"code":"MCP_CATALOG_UNAVAILABLE","retry_after":0}', { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(new Response('{"tools":[{"version":"current"}]}'))
    const result = await create(fetchImpl).request(request)
    expect(JSON.parse(Buffer.from(result.bytes).toString()).tools[0].version).toBe('current')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(new Set(fetchImpl.mock.calls.map(([, value]) => value.signal)).size).toBe(1)
    expect(fetchImpl.mock.calls.every(([, value]) => value.headers['x-gxzs-host-generation'] === '7'
      && value.headers['x-gxzs-host-instance'] === 'host-7' && value.headers['x-gxzs-owner'] === owner.ownerId)).toBe(true)
  })

  it('bounds repeated transient failures and clears the owner queue', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }))
    const client = create(fetchImpl)
    await expect(client.request(request)).rejects.toMatchObject({ upstreamStatus: 503 })
    expect(fetchImpl).toHaveBeenCalledTimes(5)
    await vi.waitFor(() => expect(client.catalogReads.size).toBe(0))
  })

  it('admits 30 owners with four concurrent reads each against 24 busy workspace slots', async () => {
    let active = 0
    let peak = 0
    let refused = 0
    const owners = new Set()
    const fetchImpl = vi.fn(async (_url, { headers }) => {
      const id = headers['x-gxzs-owner']
      expect(owners.has(id)).toBe(false)
      if (active >= 24) { refused++; return new Response('{"retry_after":0}', { status: 503 }) }
      owners.add(id)
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active--
      owners.delete(id)
      return new Response(JSON.stringify({ owner: id }))
    })
    const clients = Array.from({ length: 30 }, () => create(fetchImpl))
    const results = await Promise.all(clients.flatMap((client, i) => Array.from({ length: 4 }, () =>
      client.request({ ...request, owner: { ownerId: `tenant:${i}` } }))))
    expect(results).toHaveLength(120)
    expect(refused).toBeGreaterThan(0)
    expect(peak).toBe(24)
    expect(active).toBe(0)
    expect(fetchImpl.mock.calls.length).toBeLessThan(150)
    await vi.waitFor(() => expect(clients.every(client => client.catalogReads.size === 0)).toBe(true))
  })
})
