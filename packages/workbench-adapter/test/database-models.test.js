import { describe, expect, it, vi } from 'vitest'
import { symbols } from '@deepseek-ai/cordis'
import { databaseModelCatalog, requireDatabaseModel } from '../src/database-models.js'

function setup() {
  const model = { id: 'flash', name: 'Database Flash', contextWindow: 1050000, maxTokens: 128000, input: ['text', 'image'], reasoningEfforts: { off: 'none', high: 'high' } }
  const config = { enabled: true, models: { default: 'p/flash', providers: { p: { reasoning: 'off', models: [model] } } } }
  const client = { json: vi.fn(async () => ({ data: config })) }
  const sessions = { modelCatalog: vi.fn(async () => ({ default: { provider: 'other', model: 'builtin' }, groups: [
    { id: 'p', models: [{ ...model, name: 'Native name', reasoning: { efforts: [{ id: 'high' }] } }, { id: 'max', name: 'Native max' }] },
    { id: 'other', models: [{ id: 'builtin' }] },
  ] })) }
  const values = new Map()
  const revisions = new Map()
  const settings = { get: (key) => values.get(key),
    describe: () => [...revisions].map(([ns, revision]) => ({ ns, revision })),
    replace: vi.fn(async (key, value) => { values.set(key, value); revisions.set(key, (revisions.get(key) ?? 0) + 1) }) }
  return { config, client, sessions, settings, model }
}

describe('database model publication', () => {
  it('shares synchronization and capabilities across fresh Cordis service proxies', async () => {
    const { client, sessions, settings } = setup()
    const proxy = target => new Proxy(target, { get: (value, property) => property === symbols.original ? value : value[property] })
    await Promise.all([1, 2].map(() => databaseModelCatalog(client, proxy(sessions), {}, proxy(settings))))
    await databaseModelCatalog(client, proxy(sessions), {}, proxy(settings))
    expect(settings.replace).toHaveBeenCalledTimes(2)
    expect(sessions.modelCatalog).toHaveBeenCalledTimes(1)
    expect(client.json).toHaveBeenCalledTimes(3)
  })
  it('publishes only database models and synchronizes all execution parameters', async () => {
    const { client, sessions, settings, model } = setup()
    const owner = { ownerId: 'tenant:user' }
    const catalog = await databaseModelCatalog(client, sessions, owner, settings)
    expect(catalog.default).toEqual({ provider: 'p', model: 'flash' })
    expect(catalog.groups).toHaveLength(1)
    expect(catalog.groups[0].models).toHaveLength(1)
    expect(catalog.groups[0].models[0].name).toBe('Database Flash')
    expect(settings.get('llm-pi-ai').providers.p.models).toEqual([model])
    expect(settings.get('agent-default-model').reasoningEffort).toBe('off')
    expect(client.json).toHaveBeenCalledWith(expect.objectContaining({ owner, route: 'workbench/config' }))
    await databaseModelCatalog(client, sessions, owner, settings)
    expect(settings.replace).toHaveBeenCalledTimes(2)
    expect(sessions.modelCatalog).toHaveBeenCalledTimes(1)
    expect(client.json).toHaveBeenCalledTimes(2)
    await settings.replace('llm-pi-ai', { providers: {} })
    await databaseModelCatalog(client, sessions, owner, settings)
    expect(settings.get('llm-pi-ai').providers.p.models).toEqual([model])
    expect(sessions.modelCatalog).toHaveBeenCalledTimes(2)
  })
  it('invalidates capabilities after publication changes and retries failed discovery', async () => {
    const { client, sessions, settings, config } = setup()
    await databaseModelCatalog(client, sessions, {}, settings)
    config.models.providers.p.models[0].name = 'Updated'
    sessions.modelCatalog.mockRejectedValueOnce(new Error('discovery unavailable'))
    await expect(databaseModelCatalog(client, sessions, {}, settings)).rejects.toThrow('discovery unavailable')
    await expect(databaseModelCatalog(client, sessions, {}, settings)).resolves.toMatchObject({ groups: [{ models: [{ name: 'Updated' }] }] })
    expect(sessions.modelCatalog).toHaveBeenCalledTimes(3)
    client.json.mockResolvedValue({ data: { enabled: false } })
    await expect(databaseModelCatalog(client, sessions, {}, settings)).rejects.toMatchObject({ status: 503 })
  })
  it('rejects unlisted native models and never falls back on database failure', async () => {
    const { client, sessions } = setup()
    await expect(requireDatabaseModel(client, sessions, {}, 'p/max')).rejects.toMatchObject({ status: 400 })
    client.json.mockRejectedValue(new Error('database unavailable'))
    await expect(databaseModelCatalog(client, sessions, {})).rejects.toThrow('database unavailable')
  })
  it('refreshes native capabilities after the short reuse window', async () => {
    const clock = vi.spyOn(Date, 'now')
    try {
      const { client, sessions, settings } = setup()
      clock.mockReturnValue(1000)
      await databaseModelCatalog(client, sessions, {}, settings)
      clock.mockReturnValue(31_001)
      await databaseModelCatalog(client, sessions, {}, settings)
      expect(sessions.modelCatalog).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })
  it('rejects a disabled or unavailable default', async () => {
    const { config, client, sessions } = setup()
    config.models.providers.p.models[0].enabled = false
    await expect(databaseModelCatalog(client, sessions, {})).rejects.toMatchObject({ status: 503 })
    config.enabled = false
    await expect(databaseModelCatalog(client, sessions, {})).rejects.toMatchObject({ status: 503 })
  })
})
