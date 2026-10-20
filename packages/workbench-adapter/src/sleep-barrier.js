import { timingSafeEqual } from 'node:crypto'
import { httpError } from './http.js'

/** Short, authenticated shutdown handoff. Failed shutdowns automatically reopen admission. */
export class SleepBarrier {
  constructor() { this.requests = 0; this.until = 0 }
  assertAwake() {
    if (this.until > Date.now()) throw Object.assign(httpError(503, '个人工作环境正在休眠，请稍后重试'), { code: 'HOST_IDLE', retry_after: 2 })
  }
  enter() {
    this.assertAwake()
    this.requests++
    let left = false
    return () => { if (!left) { left = true; this.requests-- } }
  }
  async prepare(authorization, readActivity, identity, now = Date.now()) {
    const token = process.env.GXZS_SANDBOX_MANAGER_TOKEN
    const expected = Buffer.from('Bearer ' + (token ?? ''))
    const supplied = Buffer.from(typeof authorization === 'string' ? authorization : '')
    if (!token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw httpError(401, '宿主管理身份无效')
    if (this.requests) throw httpError(409, '工作区仍有操作正在处理')
    // Freeze before awaiting the final catalog: new authenticated writes and native steps cannot cross the handoff.
    this.until = now + 60_000
    try {
      const activity = await readActivity()
      const keys = ['runningAgents', 'pendingMessages', 'runningJobs', 'activeSidebarResources', 'activeSettingsWrites', 'pendingScheduleReports']
      if (activity.protocol !== 2 || activity.status !== 'ready' || keys.some(key => activity[key] !== 0)
        || activity.activeSchedules !== activity.registeredSchedules || this.requests) throw httpError(409, '工作区仍有后台任务或未确认登记')
      return { prepared: true, until: this.until, ...identity }
    } catch (error) { this.until = 0; throw error }
  }
}
