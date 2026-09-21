import { Service } from '@deepseek-ai/cordis'

export class WorkbenchRuntime extends Service {
  constructor(ctx, database, ownerId) {
    super(ctx, 'workbenchRuntime', true)
    this.database = database
    this.ownerId = ownerId
  }

  authorizeMcp(sessionId, resourceId, version) {
    const run = this.database.activeRunBySession(sessionId)
    if (!run || run.status !== 'running' || run.ownerId !== this.ownerId) return undefined
    const resource = (run.mcpTools ?? []).find((item) => item.id === resourceId && item.version === version)
    return resource ? { runId: run.id, ownerId: run.ownerId, resource } : undefined
  }

  authorizeRunMcp(ownerId, runId, resourceId, version) {
    if (ownerId !== this.ownerId) return false
    const run = this.database.getRun(ownerId, runId)
    if (!run) return false
    return this.authorizeMcp(run.sessionId, resourceId, version)?.runId === runId
  }
}
