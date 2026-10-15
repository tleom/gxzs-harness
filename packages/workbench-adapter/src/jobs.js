import { httpError } from './http.js'

/** Bridge the native job controller; human observation never consumes model output. */
export class WorkbenchJobs {
  constructor({ native, registry, service, subagents }) { this.native = native; this.registry = registry; this.service = service; this.subagents = subagents }
  async session(owner, chatId, jobId, requested, signal) {
    let sessionId = this.service.requireChat(owner, chatId).sessionId
    if (requested && requested !== sessionId) {
      if (!this.subagents) throw httpError(404, '后台任务会话不属于此对话')
      const child = await this.subagents.requireChild(owner, chatId, requested, signal)
      sessionId = child.id
    }
    if (jobId !== undefined) {
      try { this.registry.get(jobId, sessionId) }
      catch { throw httpError(404, '后台任务不存在或不属于此对话') }
    }
    return sessionId
  }
  async *list(owner, chatId, signal, requested) {
    const sessionId = await this.session(owner, chatId, undefined, requested, signal)
    for await (const value of this.native.list({ sessionId }, signal)) yield { event: 'workbench_jobs', value }
  }
  async *follow(owner, chatId, jobId, from, signal, requested) {
    const sessionId = await this.session(owner, chatId, jobId, requested, signal)
    const cursor = from === null || from === undefined ? undefined : Number(from)
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || !/^\d+$/.test(from)))
      throw httpError(400, '任务输出游标无效')
    for await (const value of this.native.follow({ sessionId, jobId, ...(cursor === undefined ? {} : { from: cursor }) }, signal))
      yield { event: 'workbench_job_output', value }
  }
  async stop(owner, chatId, jobId, requested, signal) {
    return this.native.kill({ sessionId: await this.session(owner, chatId, jobId, requested, signal), jobId })
  }
}
