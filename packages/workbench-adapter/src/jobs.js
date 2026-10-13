import { httpError } from './http.js'

/** Bridge the native job controller; human observation never consumes model output. */
export class WorkbenchJobs {
  constructor({ native, registry, service }) { this.native = native; this.registry = registry; this.service = service }
  session(owner, chatId, jobId) {
    const sessionId = this.service.requireChat(owner, chatId).sessionId
    if (jobId !== undefined) {
      try { this.registry.get(jobId, sessionId) }
      catch { throw httpError(404, '后台任务不存在或不属于此对话') }
    }
    return sessionId
  }
  async *list(owner, chatId, signal) {
    const sessionId = this.session(owner, chatId)
    for await (const value of this.native.list({ sessionId }, signal)) yield { event: 'workbench_jobs', value }
  }
  async *follow(owner, chatId, jobId, from, signal) {
    const sessionId = this.session(owner, chatId, jobId)
    const cursor = from === null || from === undefined ? undefined : Number(from)
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || !/^\d+$/.test(from)))
      throw httpError(400, '任务输出游标无效')
    for await (const value of this.native.follow({ sessionId, jobId, ...(cursor === undefined ? {} : { from: cursor }) }, signal))
      yield { event: 'workbench_job_output', value }
  }
  stop(owner, chatId, jobId) {
    return this.native.kill({ sessionId: this.session(owner, chatId, jobId), jobId })
  }
}
