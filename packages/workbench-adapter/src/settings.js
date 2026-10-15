import { httpError } from './http.js'

const FIELDS = {
  subagent: new Set(['maxDepth', 'maxActiveSubagents']),
  'subagent-model-selection-settings': new Set(['enabled', 'allowedModels']),
  'ui-conversation': new Set(['busyEnter']),
}

/** Owner Host transport for native settings; configuration and revisions stay in DSH. */
export class WorkbenchSubagentSettings {
  constructor({ controller, modelCatalog, assertWritable = async () => {} }) {
    Object.assign(this, { controller, modelCatalog, assertWritable })
    this.activeWrites = 0
  }

  provider() {
    const controller = this.controller()
    if (!controller) throw httpError(503, '子智能体设置服务尚未就绪')
    return controller
  }

  describe() {
    const result = this.provider().describe()
    return { ...result, hasDocument: false, namespaces: result.namespaces.filter(row => Object.hasOwn(FIELDS, row.ns)) }
  }

  async mutate(owner, request) {
    const fields = FIELDS[request?.ns]
    if (!Object.hasOwn(FIELDS, request?.ns ?? '') || !Array.isArray(request?.ops) || !request.ops.length
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)
      throw httpError(400, '子智能体设置请求无效')
    for (const op of request.ops) {
      if (!['set', 'unset'].includes(op?.op) || !Array.isArray(op.path) || op.path.length !== 1 || !fields.has(op.path[0]))
        throw httpError(400, '只能修改子智能体设置')
    }
    // Count BEFORE the manager's workspace-lock check. A replacement first
    // marks draining, then samples this count: an earlier accepted write is
    // visible; a later write fails the check before reaching native mutate.
    this.activeWrites++
    try {
      await this.assertWritable(owner)
      const routes = request.ops.findLast(op => op.op === 'set' && op.path[0] === 'allowedModels')?.value
      if (Array.isArray(routes)) {
        const catalog = await this.modelCatalog(owner)
        const current = this.describe().namespaces.find(row => row.ns === request.ns)?.value?.allowedModels ?? []
        const allowed = new Set([...catalog.groups.flatMap(group => group.models.map(model => JSON.stringify([group.id, model.id]))),
          ...current.map(route => JSON.stringify([route.provider, route.model]))])
        if (routes.some(route => !allowed.has(JSON.stringify([route?.provider, route?.model]))))
          throw httpError(400, '所选模型未在后台启用')
      }
      return await this.provider().mutate(request.ns, request.ops, request.expectedRevision)
    } finally {
      this.activeWrites--
    }
  }
}
