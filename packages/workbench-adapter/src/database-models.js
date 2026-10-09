import { httpError } from './http.js'

/** The published database catalog owns visibility, names and defaults.
 * Native routes supply only execution capabilities; they cannot add models. */
const applied = new WeakMap()
const writes = new WeakMap()
const revision = (settings, name) => settings.describe().find(item => item.ns === name)?.revision

async function synchronize(settings, models) {
  if (!settings) return
  const task = (writes.get(settings) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const stamp = JSON.stringify(models)
    const previous = applied.get(settings)
    if (previous?.stamp === stamp && previous.source === revision(settings, 'llm-pi-ai')
      && previous.defaultSource === revision(settings, 'agent-default-model')) return
    const providers = Object.fromEntries(Object.entries(models.providers).filter(([, p]) => p.enabled !== false).map(([id, p]) => {
      const { enabled, name, models: entries, ...connection } = p
      return [id, { ...connection, models: entries.filter((m) => m.enabled !== false).map(({ enabled, ...model }) => model) }]
    }))
    await settings.replace('llm-pi-ai', { providers })
    const slash = models.default.indexOf('/')
    const provider = models.default.slice(0, slash)
    const reasoningEffort = models.providers[provider]?.reasoning
    await settings.replace('agent-default-model', { provider, model: models.default.slice(slash + 1), ...(reasoningEffort ? { reasoningEffort } : {}) })
    applied.set(settings, { stamp, source: revision(settings, 'llm-pi-ai'), defaultSource: revision(settings, 'agent-default-model') })
  })
  writes.set(settings, task)
  return task
}

export async function databaseModelCatalog(platformClient, sessions, owner, settings) {
  const payload = await platformClient.json({ owner, method: 'GET', route: 'workbench/config', timeoutMs: 5000 })
  const config = payload?.data
  if (!config?.enabled || !config.models || typeof config.models.providers !== 'object' || !config.models.providers)
    throw httpError(503, '后台尚未发布模型配置')
  if (typeof config.models.default !== 'string' || config.models.default.indexOf('/') <= 0)
    throw httpError(503, '后台默认模型配置无效')
  const declaredDefault = Object.entries(config.models.providers).some(([id, provider]) =>
    provider?.enabled !== false && Array.isArray(provider?.models) && provider.models.some((model) =>
      model?.enabled !== false && `${id}/${model?.id}` === config.models.default))
  if (!declaredDefault) throw httpError(503, '后台默认模型未启用')
  await synchronize(settings, config.models)
  const native = await sessions.modelCatalog()
  const groups = []
  for (const [id, provider] of Object.entries(config.models.providers)) {
    if (!provider || provider.enabled === false) continue
    if (!Array.isArray(provider.models)) throw httpError(503, '后台模型配置格式无效')
    const routes = native.groups?.find((group) => group.id === id)?.models ?? []
    const models = provider.models.filter((model) => model.enabled !== false).flatMap((model) => {
      if (typeof model.id !== 'string' || !model.id || typeof model.name !== 'string' || !model.name.trim())
        throw httpError(503, '后台模型配置格式无效')
      const route = routes.find((route) => route.id === model.id)
      return route ? [{ ...route, name: model.name, description: model.description || '' }] : []
    })
    if (models.length) groups.push({ id, name: provider.name || id, models })
  }
  const value = config.models.default
  const slash = typeof value === 'string' ? value.indexOf('/') : -1
  const selected = slash > 0 ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : null
  if (!selected || !groups.some((group) => group.id === selected.provider && group.models.some((model) => model.id === selected.model)))
    throw httpError(503, '后台默认模型未启用或尚未配置可用连接')
  return { groups, default: selected }
}

export async function requireDatabaseModel(platformClient, sessions, owner, modelId, settings) {
  const catalog = await databaseModelCatalog(platformClient, sessions, owner, settings)
  const model = catalog.groups.flatMap((group) => group.models.map((model) => ({ ...model, route: `${group.id}/${model.id}` })))
    .find((model) => model.route === modelId)
  if (!model) throw httpError(400, '模型未在后台启用或当前不可用，请重新选择')
  return model
}
