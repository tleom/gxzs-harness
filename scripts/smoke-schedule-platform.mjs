import assert from 'node:assert/strict'

// The bootstrap smoke exercises registration and preferences without running
// the future task. Unexpected actions still fail the platform fixture.
export function createSchedulePlatformFixture() {
  const jobs = new Map()
  let sequence = 0
  let snapshot
  const register = (task, retain = false) => {
    assert.match(task.id, /^[A-Za-z0-9_-]{1,96}$/)
    assert.match(task.sessionId, /^[A-Za-z0-9_-]{1,128}$/)
    assert.match(task.chatId, /^[A-Za-z0-9_-]{1,36}$/)
    assert.ok(typeof task.title === 'string' && task.title.trim() && task.title.length <= 120)
    let job = jobs.get(task.id)
    if (!job) {
      job = { jobId: task.id, sessionId: task.sessionId, chatId: task.chatId, title: task.title,
        notifyEnabled: false, notifyEnabledAt: null, version: 1, deleted: false,
        lastNotifiedRunId: null, lastNotifiedOccurrenceAt: null }
      jobs.set(task.id, job)
    }
    assert.equal(job.sessionId, task.sessionId, 'Job Session binding changed')
    assert.equal(job.chatId, task.chatId, 'Job chat binding changed')
    if (!retain) job.title = task.title
    return job
  }
  return (method, route, body) => {
    if (method !== 'POST') return undefined
    if (route === '/internal/workbench/schedule-wakeups') {
      assert.ok(Number.isSafeInteger(body.sequence) && body.sequence > 0 && body.sequence >= sequence)
      assert.ok(Array.isArray(body.tasks) && body.tasks.length <= 10_000)
      const ids = new Set()
      for (const task of body.tasks) {
        register(task)
        assert.ok(!ids.has(task.id), 'Duplicate wakeup task')
        ids.add(task.id)
        assert.ok(['active', 'inactive'].includes(task.status))
        assert.ok(Number.isSafeInteger(task.scheduledAt) && task.scheduledAt > 0)
        assert.match(task.revision, /^[a-f0-9]{64}$/)
      }
      if (body.sequence === sequence) assert.deepEqual(body.tasks, snapshot, 'Same sequence changed its snapshot')
      sequence = body.sequence
      snapshot = structuredClone(body.tasks)
      return { sequence, complete: true, tasks: body.tasks.map(task => ({
        id: task.id, revision: task.revision, registered: true,
      })) }
    }
    if (route !== '/internal/workbench/jobs') return undefined
    if (['sync', 'recover'].includes(body.action)) {
      assert.ok(Array.isArray(body.tasks) && body.tasks.length <= 200)
      return body.tasks.map(task => ({ ...register(task, body.action === 'recover') }))
    }
    assert.ok(['initialize', 'configure', 'delete'].includes(body.action), 'Unexpected smoke job action')
    const job = register(body.task, body.action === 'initialize')
    if (body.action === 'initialize') {
      assert.ok(Number.isSafeInteger(body.createdAt) && body.createdAt > 0 && body.createdAt <= Date.now() + 60_000)
      if (!job.deleted && job.version === 1)
        Object.assign(job, { notifyEnabled: true, notifyEnabledAt: body.createdAt, version: 2 })
    } else if (body.action === 'configure') {
      assert.equal(job.deleted, false)
      assert.equal(typeof body.notifyEnabled, 'boolean')
      assert.equal(body.expectedVersion, job.version)
      job.notifyEnabledAt = body.notifyEnabled ? (job.notifyEnabled ? job.notifyEnabledAt : Date.now()) : null
      job.notifyEnabled = body.notifyEnabled
      job.version++
    } else {
      if (!job.deleted) job.version++
      Object.assign(job, { deleted: true, notifyEnabled: false })
      return true
    }
    return { ...job }
  }
}
