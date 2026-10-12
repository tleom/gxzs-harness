import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { TaskScheduler } from '../src/scheduler.js'
import { prepareNativeFiles } from '../src/attachments.js'

const databases = []
const schedulers = []
afterEach(() => { schedulers.splice(0).forEach(scheduler => scheduler.close()); databases.splice(0).forEach((db) => db.close()); vi.restoreAllMocks() })
function setup() {
  const diagnostics = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const db = new WorkbenchDatabase(':memory:')
  databases.push(db)
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
  const sessions = { prompt: vi.fn(async () => { agent.status = 'running' }), cancel: vi.fn(), selectModel: vi.fn(async () => {}) }
  let permitted = false
  const platform = { json: vi.fn(async ({ body, route }) => route === 'mcp/cancel' ? ({ data: { fenced: true } }) : ({ data: { state: JSON.parse(body).action === 'release' ? 'done' : permitted ? 'running' : 'waiting' } })) }
  const scheduler = new TaskScheduler({ database: db, sessions, platformClient: platform, ownerId: 't:1', agents: new Map([['s', agent]]) })
  schedulers.push(scheduler)
  const chat = db.createChat({ ownerId: 't:1', sessionId: 's', selection: {} })
  const create = (query) => db.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 's', query, selection: {} }).run
  return { db, sessions, scheduler, platform, create, agent, diagnostics, permit: () => { permitted = true } }
}

it('holds one root ticket for native background children until the last owned execution ends', async () => {
  const { db, scheduler, platform, sessions, agent, create, permit } = setup()
  permit(); const run = create('spawn child')
  await scheduler.enqueue(run, [{ type: 'text', text: run.query }]); await scheduler.tick()
  let children = true
  scheduler.hasOwnedWork = () => children
  db.transitionRun('t:1', run.id, 'completed'); agent.status = 'idle'
  await scheduler.tick()
  expect(scheduler.hasAdmission('s')).toBe(true)
  expect(sessions.prompt).toHaveBeenCalledOnce()
  expect(platform.json.mock.calls.map(([request]) => JSON.parse(request.body).action)).not.toContain('release')
  children = false; await scheduler.tick()
  expect(scheduler.hasAdmission('s')).toBe(false)
  expect(db.submission('t:1', run.id)).toBeUndefined()
  expect(sessions.prompt).toHaveBeenCalledOnce()
})

it.each(['prepare', 'prompt'])('preserves reviewed native attachment rejection during queued %s admission', async stage => {
  const { db, scheduler, sessions, create, permit } = setup()
  const error = Object.assign(new Error('/host/private/config secret'), {
    isDSHRemoteError: true, code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
  })
  if (stage === 'prepare') scheduler.prepareContent = async () => { throw error }
  else sessions.prompt.mockRejectedValue(error)
  permit()
  const run = create('attachment admission')
  await scheduler.enqueue(run, [{ type: 'image', mediaType: 'image/png', data: 'fixture' }])
  await scheduler.tick()
  await vi.waitFor(() => expect(db.getRun('t:1', run.id).status).toBe('failed'))
  expect(db.getRun('t:1', run.id).error).toContain('所选模型不支持图片输入')
  expect(db.getRun('t:1', run.id).errorCode).toBe(error.code)
  expect(JSON.stringify(db.allEvents('t:1', run.id))).not.toContain('secret')
})

it('stages native file receipts only at dispatch and keeps bytes durable', async () => {
  const { db, scheduler, create, sessions, permit } = setup()
  const run = create('read file')
  const content = [{ type: 'file', name: 'evidence.txt', data: Buffer.from('evidence').toString('base64') }]
  const uploadStream = vi.fn(async ({ sessionId, data }) => {
    expect(sessionId).toBe('s')
    const chunks = []
    for await (const chunk of data) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('evidence')
    return { receiptId: 'native-receipt' }
  })
  scheduler.prepareContent = (sessionId, value) => prepareNativeFiles({ uploadStream }, sessionId, value)
  await scheduler.enqueue(run, content)
  await scheduler.tick()
  expect(uploadStream).not.toHaveBeenCalled()
  expect(db.submission('t:1', run.id).content).toEqual(content)
  permit()
  await scheduler.tick()
  expect(sessions.prompt.mock.calls[0][0].content).toEqual([{ type: 'file', receiptId: 'native-receipt' }])
  expect(db.submission('t:1', run.id).content).toEqual(content)
})

it('does not deliver or mark dispatched when cancellation happens during file staging', async () => {
  const { db, scheduler, create, sessions, permit } = setup()
  const run = create('read file')
  scheduler.prepareContent = async (_sessionId, content) => {
    db.transitionRun('t:1', run.id, 'cancelled')
    return content
  }
  permit()
  await scheduler.enqueue(run, [{ type: 'text', text: 'file' }])
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  expect(db.submission('t:1', run.id)?.dispatched ?? false).toBe(false)
})

it('logs only reviewed scheduling metadata and rethrows the original request failure', async () => {
  const { db, scheduler, platform, create, diagnostics } = setup()
  const run = create('private task content')
  db.saveSubmission('t:1', run.id, [])
  const error = Object.assign(new Error('Bearer secret-token /private/path'), {
    status: 403, code: 'PRIVATE_CREDENTIAL_VALUE', body: { token: 'secret-token' }, cause: new Error('nested secret'),
  })
  scheduler.generation = '5'
  platform.json.mockRejectedValueOnce(error)
  await expect(scheduler.request(run, 'renew')).rejects.toBe(error)
  const record = JSON.parse(diagnostics.mock.calls[0][0])
  expect(record).toEqual({ event: 'workbench_scheduler', operation: 'request_failed', reason: 'request_failed',
    action: 'renew', status: 403, code: null, state: null, generation: 5, run_hash: expect.stringMatching(/^[a-f0-9]{12}$/) })
  const output = JSON.stringify(diagnostics.mock.calls)
  for (const sensitive of ['secret', 'Bearer', '/private', 'PRIVATE_CREDENTIAL', 'private task', run.id, 't:1'])
    expect(output).not.toContain(sensitive)
  expect(db.submission('t:1', run.id).dispatched).toBe(false)
})

it('identifies renewal rejection without changing native cancel and remote fence behavior', async () => {
  const { db, scheduler, platform, create, diagnostics, sessions, permit } = setup()
  const run = create('work')
  db.saveSubmission('t:1', run.id, [])
  permit(); await scheduler.tick()
  expect(diagnostics).not.toHaveBeenCalled()
  db.transitionRun('t:1', run.id, 'running')
  platform.json.mockResolvedValueOnce({ data: { state: 'done', code: 'PRIVATE_CODE' } })
  await scheduler.tick()
  expect(diagnostics.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    expect.objectContaining({ operation: 'renew_rejected', reason: 'renew_state', action: 'renew', state: 'done', code: null }),
    expect.objectContaining({ operation: 'cancel_execution', reason: 'renew_state', action: 'renew', state: 'done', code: null }),
  ])
  expect(sessions.cancel).toHaveBeenCalledOnce()
  expect(platform.json.mock.calls.some(([value]) => value.route === 'mcp/cancel')).toBe(true)
  expect(db.submission('t:1', run.id).dispatched).toBe(true)
})

it('continues cancel and MCP fencing even when the diagnostic sink throws', async () => {
  const { db, scheduler, platform, create, diagnostics, sessions, permit } = setup()
  const run = create('work')
  db.saveSubmission('t:1', run.id, [])
  permit(); await scheduler.tick()
  db.transitionRun('t:1', run.id, 'running')
  diagnostics.mockImplementation(() => { throw new Error('broken log sink') })
  platform.json.mockResolvedValueOnce({ data: { state: 'done' } })
  await scheduler.tick()
  expect(sessions.cancel).toHaveBeenCalledOnce()
  expect(platform.json.mock.calls.some(([value]) => value.route === 'mcp/cancel')).toBe(true)
  expect(db.submission('t:1', run.id).dispatched).toBe(true)
  expect(db.getRun('t:1', run.id).status).toBe('running')
})

it('filters malformed diagnostic fields and reports distinct dispatcher and unfenced sources', async () => {
  const { scheduler, diagnostics, create } = setup()
  scheduler.generation = 'credential-secret'
  const run = create('private')
  scheduler.diagnostic(run, 'dispatch_failed', 'dispatch_error', { action: 'dispatch', state: 'secret',
    error: { status: '403', code: 'secret', name: 'TimeoutError', message: 'secret', stack: 'secret' } })
  expect(JSON.parse(diagnostics.mock.calls[0][0])).toMatchObject({ operation: 'dispatch_failed', reason: 'dispatch_error',
    status: null, code: 'TIMEOUT', state: null, generation: null })
  await scheduler.cancelExecution(run, 'unfenced')
  expect(JSON.parse(diagnostics.mock.calls[1][0])).toMatchObject({ operation: 'cancel_execution', reason: 'unfenced', action: 'cancel' })
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('secret')
})

it('waits for capacity then hands both prompts to one admitted native Session', async () => {
  const { db, sessions, scheduler, create, permit, platform, agent } = setup()
  const first = create('first'), second = create('second')
  db.saveSubmission('t:1', first.id, [{ type: 'text', text: 'first' }])
  db.saveSubmission('t:1', second.id, [{ type: 'text', text: 'second' }])
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  permit()
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(sessions.prompt.mock.calls[0][0]).toMatchObject({ requestId: first.id, mode: 'queue' })
  db.transitionRun('t:1', first.id, 'completed')
  agent.status = 'idle'
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(sessions.prompt.mock.calls[1][0].requestId).toBe(second.id)
  expect(platform.json.mock.calls.map(([r]) => JSON.parse(r.body).action)).toContain('release')
})

it('preserves undispatched work across recovery and never executes cancelled work', async () => {
  const { db, sessions, scheduler, create, permit } = setup()
  const run = create('waiting')
  db.saveSubmission('t:1', run.id, [])
  db.recoverInterrupted()
  expect(db.getRun('t:1', run.id).status).toBe('queued')
  db.transitionRun('t:1', run.id, 'cancelled')
  permit()
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  expect(db.submissions('t:1')).toEqual([])
})

it('does not run on admission outage and retains dispatched execution across one renewal 502', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('work')
  db.saveSubmission('t:1', run.id, [])
  platform.json.mockRejectedValueOnce(new Error('offline'))
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  permit()
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'running')
  platform.json.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 502 }))
  await scheduler.tick()
  expect(sessions.cancel).not.toHaveBeenCalled()
  expect(db.submission('t:1', run.id).dispatched).toBe(true)
  await scheduler.tick()
  expect(scheduler.hasAdmission('s')).toBe(true)
  expect(sessions.cancel).not.toHaveBeenCalled()
})

it('keeps a goal active across a renewal timeout without fencing its tools', async () => {
  const { db, scheduler, create, permit, platform, sessions } = setup()
  const run = create('goal')
  db.saveSubmission('t:1', run.id, [])
  permit(); await scheduler.tick()
  db.transitionRun('t:1', run.id, 'running')
  platform.json.mockRejectedValueOnce(Object.assign(new Error('deadline'), { name: 'TimeoutError' }))
  await scheduler.tick()
  expect(sessions.cancel).not.toHaveBeenCalled()
  expect(db.pendingRunFences('t:1')).toEqual([])
  await scheduler.tick()
  expect(scheduler.hasAdmission('s')).toBe(true)
})

it('uses a new durable ticket for an explicit failed-run retry', async () => {
  const { db, sessions, scheduler, create, permit, platform, agent } = setup()
  const run = create('retry')
  db.saveSubmission('t:1', run.id, [{ type: 'text', text: 'retry' }])
  const previous = db.submission('t:1', run.id).ticketId
  permit()
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'failed')
  agent.status = 'idle'
  await scheduler.tick()
  await expect(scheduler.enqueue(db.getRun('t:1', run.id), [], true)).rejects.toThrow('new run identity')
  const retried = create('retry')
  await scheduler.enqueue(retried, [{ type: 'text', text: 'retry' }])
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(db.submission('t:1', retried.id).ticketId).not.toBe(previous)
  expect(sessions.prompt.mock.calls[1][0].requestId).not.toBe(run.id)
  expect(platform.json.mock.calls.map(([request]) => JSON.parse(request.body)).some((request) => request.action === 'release' && request.ticket_id === previous)).toBe(true)
})

it.each([400, 401, 403, 404, 405, 501])('ends waiting on a permanent admission error (%s)', async (status) => {
  const { db, sessions, scheduler, create, platform } = setup()
  const run = create('work')
  db.saveSubmission('t:1', run.id, [])
  platform.json.mockRejectedValue(Object.assign(new Error('invalid scheduling configuration'), { status }))
  await scheduler.tick()
  await scheduler.tick()
  expect(sessions.prompt).not.toHaveBeenCalled()
  expect(db.getRun('t:1', run.id)).toMatchObject({ status: 'failed' })
  expect(db.allEvents('t:1', run.id).filter(event => event.event === 'workbench_end')).toEqual([
    expect.objectContaining({ status: 'failed', error: expect.stringContaining('任务调度配置异常') }),
  ])
})

it('rechecks cancellation after waiting for a global ticket', async () => {
  const { db, sessions, scheduler, create, platform } = setup()
  const run = create('cancel during acquire')
  db.saveSubmission('t:1', run.id, [])
  let resolve
  platform.json.mockImplementationOnce(() => new Promise((accept) => { resolve = accept }))
  const dispatch = scheduler.tick()
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
  db.transitionRun('t:1', run.id, 'cancelled')
  resolve({ data: { state: 'running' } })
  await dispatch
  expect(sessions.prompt).not.toHaveBeenCalled()
  await scheduler.tick()
  expect(db.submissions('t:1')).toEqual([])
})

it.each(['revoked', 'offline'])('handles terminal-turn goal renewal when %s', async (failure) => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('goal')
  db.saveSubmission('t:1', run.id, [])
  permit()
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'completed')
  scheduler.agents = new Map([['s', { status: 'running' }]])
  if (failure === 'offline') platform.json.mockRejectedValueOnce(new TypeError('offline'))
  else platform.json.mockResolvedValueOnce({ data: { state: 'done' } })
  await scheduler.tick()
  if (failure === 'revoked') expect(sessions.cancel).toHaveBeenCalledWith({ sessionId: 's' })
  else {
    expect(sessions.cancel).not.toHaveBeenCalled()
    await scheduler.tick()
    expect(scheduler.hasAdmission('s')).toBe(true)
  }
  expect(db.submission('t:1', run.id)).toBeDefined()
  expect(db.getRun('t:1', run.id).status).toBe('completed')
})

it('waits for admission recovery before admitting a native goal step', async () => {
  const { db, scheduler, create, platform, agent } = setup()
  const run = create('goal continuation')
  db.bindNativeTurn(run, 1)
  platform.json.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 502 }))
    .mockResolvedValueOnce({ data: { state: 'running' } })
  const next = vi.fn(() => ({ kind: 'continue' }))
  const pending = scheduler.admitNativeStep({ agent: { ...agent, id: 's' }, turn: 1,
    signal: new AbortController().signal }, next)
  await vi.waitFor(() => expect(platform.json).toHaveBeenCalledTimes(1))
  expect(next).not.toHaveBeenCalled()
  await expect(pending).resolves.toEqual({ kind: 'continue' })
  expect(next).toHaveBeenCalledOnce()
})

it('keeps native execution gated until an offline admission wait is aborted', async () => {
  const { db, scheduler, create, platform, agent } = setup()
  const run = create('blocked continuation')
  db.bindNativeTurn(run, 1)
  platform.json.mockRejectedValue(Object.assign(new Error('offline'), { status: 502 }))
  const controller = new AbortController()
  const next = vi.fn()
  const pending = scheduler.admitNativeStep({ agent: { ...agent, id: 's' }, turn: 1,
    signal: controller.signal }, next)
  await vi.waitFor(() => expect(platform.json).toHaveBeenCalledTimes(1))
  controller.abort(new Error('cancelled'))
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(next).not.toHaveBeenCalled()
})

it('holds a queued follow-up until the active session can renew again', async () => {
  const { db, scheduler, create, permit, platform, sessions } = setup()
  const first = create('first')
  db.saveSubmission('t:1', first.id, [])
  permit(); await scheduler.tick()
  const followUp = create('follow-up')
  db.saveSubmission('t:1', followUp.id, [{ type: 'text', text: 'follow-up' }])
  platform.json.mockRejectedValue(Object.assign(new Error('offline'), { status: 502 }))
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(1)
  expect(db.submission('t:1', followUp.id)).toBeDefined()
  expect(sessions.cancel).not.toHaveBeenCalled()
  platform.json.mockReset().mockResolvedValue({ data: { state: 'running' } })
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
  expect(db.submission('t:1', followUp.id)).toBeUndefined()
})

it('releases admission when the native Session is idle without rewriting its turn cache', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('revoked')
  db.saveSubmission('t:1', run.id, [])
  permit()
  await scheduler.tick()
  scheduler.agents = new Map([['s', { status: 'idle' }]])
  platform.json.mockResolvedValueOnce({ data: { state: 'done' } })
  await scheduler.tick()
  expect(sessions.cancel).not.toHaveBeenCalled()
  expect(db.getRun('t:1', run.id).status).toBe('queued')
  await scheduler.tick()
  expect(db.submissions('t:1')).toEqual([])
})

it('releases waiting-input capacity and reacquires before continuing without another prompt', async () => {
  const { db, scheduler, create, permit, platform, sessions } = setup()
  const run = create('question')
  db.saveSubmission('t:1', run.id, [])
  permit()
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'waiting_input')
  await scheduler.tick()
  expect(platform.json.mock.calls.map(([request]) => JSON.parse(request.body))).toContainEqual(expect.objectContaining({ action: 'release', retry: true }))
  expect(scheduler.hasAdmission('s')).toBe(false)
  expect(db.submission('t:1', run.id)?.dispatched).toBe(true)
  db.transitionRun('t:1', run.id, 'running')
  await scheduler.resumeInput(db.getRun('t:1', run.id), new AbortController().signal)
  expect(scheduler.hasAdmission('s')).toBe(true)
  expect(sessions.prompt).toHaveBeenCalledTimes(1)
})

it('reacquires waiting-input capacity when the release response is lost', async () => {
  const { db, scheduler, create, permit, platform, sessions } = setup()
  const run = create('question')
  db.saveSubmission('t:1', run.id, [])
  permit()
  await scheduler.tick()
  expect(scheduler.hasAdmission('s')).toBe(true)
  db.transitionRun('t:1', run.id, 'waiting_input')
  platform.json.mockImplementationOnce(async () => {
    expect(scheduler.hasAdmission('s')).toBe(false)
    throw Object.assign(new Error('release response lost'), { status: 504 })
  })
  await scheduler.tick()
  expect(scheduler.hasAdmission('s')).toBe(false)
  db.transitionRun('t:1', run.id, 'running')
  await scheduler.resumeInput(db.getRun('t:1', run.id), new AbortController().signal)
  expect(platform.json.mock.calls.filter(([request]) => JSON.parse(request.body).action === 'acquire')).toHaveLength(2)
  expect(scheduler.hasAdmission('s')).toBe(true)
  expect(sessions.prompt).toHaveBeenCalledTimes(1)
  expect(sessions.cancel).not.toHaveBeenCalled()
})

it('retries an idle release outage without fencing subsequent prompts', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const run = create('release-outage')
  db.saveSubmission('t:1', run.id, [])
  permit()
  await scheduler.tick()
  scheduler.agents = new Map([['s', { status: 'idle' }]])
  db.transitionRun('t:1', run.id, 'completed')
  platform.json.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 502 }))
  await scheduler.tick()
  expect(sessions.cancel).not.toHaveBeenCalled()
  expect(scheduler.hasPendingFence('s')).toBe(false)
  expect(db.submission('t:1', run.id)?.dispatched).toBe(true)
  await scheduler.tick()
  expect(db.submission('t:1', run.id)).toBeUndefined()
  const next = create('after-outage')
  db.saveSubmission('t:1', next.id, [])
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(2)
})

it('hands follow-ups to the admitted native inbox without another lease', async () => {
  const { db, sessions, scheduler, create, permit, platform } = setup()
  const agent = { status: 'running', inbox: { nextTurn: [], nextStep: [] } }
  scheduler.agents = { get: () => agent }
  const first = create('first')
  db.saveSubmission('t:1', first.id, [])
  permit()
  await scheduler.tick()
  for (let n = 0; n < 5; n++) {
    const run = create(`next-${n}`)
    db.saveSubmission('t:1', run.id, [{ type: 'text', text: run.query }])
  }
  await scheduler.tick()
  expect(sessions.prompt).toHaveBeenCalledTimes(6)
  expect(db.submissions('t:1').map((item) => item.runId)).toEqual([first.id])
  expect(platform.json.mock.calls.filter(([request]) => JSON.parse(request.body).action === 'acquire')).toHaveLength(1)
  db.transitionRun('t:1', first.id, 'completed')
  agent.inbox.nextTurn.push({ id: 'native-message' })
  await scheduler.tick()
  expect(db.submission('t:1', first.id)).toBeDefined()
})

it('rotates only admission tickets across generations and retains the native request identity', async () => {
  const { db, scheduler, create, permit, sessions } = setup()
  const run = create('generation')
  db.saveSubmission('t:1', run.id, [{ type: 'text', text: 'generation' }])
  scheduler.generation = '1'
  await scheduler.request(run, 'acquire')
  const first = db.submission('t:1', run.id).ticketId
  await scheduler.request(run, 'acquire')
  expect(db.submission('t:1', run.id).ticketId).toBe(first)
  scheduler.generation = '2'
  permit()
  await scheduler.tick()
  expect(db.submission('t:1', run.id).ticketId).not.toBe(first)
  expect(sessions.prompt.mock.calls[0][0].requestId).toBe(run.id)
})

it('replaces a legacy ticket only after the manager confirms the old generation is fenced', async () => {
  const { db, scheduler, create, platform } = setup()
  const run = create('legacy')
  db.saveSubmission('t:1', run.id, [])
  const first = db.submission('t:1', run.id).ticketId
  platform.json.mockResolvedValueOnce({ data: { state: 'fenced', code: 'ADMISSION_TICKET_FENCED' } })
    .mockResolvedValueOnce({ data: { state: 'running' } })
  await expect(scheduler.request(run, 'acquire')).resolves.toMatchObject({ state: 'running' })
  expect(db.submission('t:1', run.id).ticketId).not.toBe(first)
})

it('fences remote MCP execution when a running lease is revoked', async () => {
  const { db, scheduler, create, permit, platform, sessions } = setup()
  const run = create('revocation')
  permit()
  await scheduler.enqueue(run, [{ type: 'text', text: 'revocation' }])
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'running')
  platform.json.mockResolvedValueOnce({ data: { state: 'done' } })
  await scheduler.tick()
  expect(sessions.cancel).toHaveBeenCalledWith({ sessionId: 's' })
  expect(platform.json.mock.calls.some(([request]) => request.route === 'mcp/cancel' && JSON.parse(request.body).run_id === run.id)).toBe(true)
  expect(scheduler.hasAdmission('s')).toBe(false)
})

it('retains a recovered execution fence and its ticket while the remote cleanup is unavailable', async () => {
  const { db, scheduler, create, platform } = setup()
  const run = create('interrupted')
  db.saveSubmission('t:1', run.id, [])
  db.dispatchSubmission('t:1', run.id)
  db.transitionRun('t:1', run.id, 'running')
  db.recoverInterrupted()
  scheduler.agents = new Map()
  platform.json.mockRejectedValue(new Error('offline'))
  await scheduler.tick()
  await scheduler.pendingFenceTick
  expect(db.pendingRunFences('t:1').map(value => value.id)).toContain(run.id)
  expect(db.submission('t:1', run.id)).toBeDefined()
  expect(platform.json.mock.calls.every(([request]) => request.route === 'mcp/cancel')).toBe(true)
  platform.json.mockImplementation(async request => request.route === 'mcp/cancel'
    ? ({ data: { fenced: true } }) : ({ data: { state: 'done' } }))
  await scheduler.tick()
  await scheduler.pendingFenceTick
  await scheduler.tick()
  expect(db.pendingRunFences('t:1')).toEqual([])
  expect(db.submission('t:1', run.id)).toBeUndefined()
})

it('retries one durable fence after revocation without recancelling or reopening its confirmation', async () => {
  const { db, scheduler, create, permit, platform, sessions, agent } = setup()
  const run = create('fence recovery')
  permit()
  await scheduler.enqueue(run, [])
  await scheduler.tick()
  db.transitionRun('t:1', run.id, 'running')
  sessions.cancel.mockImplementation(() => { agent.status = 'idle' })
  platform.json.mockClear()
  platform.json.mockImplementation(async request => {
    if (request.route === 'mcp/cancel') throw new Error('temporarily unavailable')
    return { data: { state: 'fenced' } }
  })
  await scheduler.tick()
  await scheduler.pendingFenceTick
  expect(sessions.cancel).toHaveBeenCalledTimes(1)
  expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/cancel')).toHaveLength(1)
  expect(scheduler.unfencedSessions.has('s')).toBe(true)
  expect(db.pendingRunFences('t:1').map(value => value.id)).toEqual([run.id])
  platform.json.mockClear()
  await scheduler.tick()
  await scheduler.pendingFenceTick
  expect(platform.json).toHaveBeenCalledTimes(1)
  expect(platform.json.mock.calls[0][0].route).toBe('mcp/cancel')
  expect(sessions.cancel).toHaveBeenCalledTimes(1)
  expect(db.submission('t:1', run.id)).toBeDefined()
  platform.json.mockClear()
  platform.json.mockImplementation(async request => request.route === 'mcp/cancel'
    ? { data: { fenced: true } } : { data: { state: 'done' } })
  await scheduler.tick()
  await scheduler.pendingFenceTick
  await scheduler.tick()
  expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/cancel')).toHaveLength(1)
  expect(sessions.cancel).toHaveBeenCalledTimes(1)
  expect(scheduler.unfencedSessions.has('s')).toBe(false)
  expect(db.pendingRunFences('t:1')).toEqual([])
  expect(db.submission('t:1', run.id)).toBeUndefined()
})

it('renews another Session while a single background fence is blocked and aborts it on close', async () => {
  const { db, scheduler, create, platform, agent } = setup()
  const stopped = create('stopped fixture')
  db.saveSubmission('t:1', stopped.id, [])
  db.dispatchSubmission('t:1', stopped.id)
  db.transitionRun('t:1', stopped.id, 'running')
  db.requireRunFence('t:1', stopped.id)
  scheduler.unfencedSessions.add('s')
  agent.status = 'idle'
  const chat = db.createChat({ ownerId: 't:1', sessionId: 'other', selection: {} })
  const active = db.createRun({ ownerId: 't:1', chatId: chat.id, sessionId: 'other', query: 'independent fixture', selection: {} }).run
  db.saveSubmission('t:1', active.id, [])
  db.dispatchSubmission('t:1', active.id)
  db.transitionRun('t:1', active.id, 'running')
  scheduler.agents.set('other', { status: 'running' })
  scheduler.leases.set('other', { runId: active.id, checkedAt: Date.now() })
  let fenceSignal
  platform.json.mockImplementation(request => {
    if (request.route !== 'mcp/cancel') return Promise.resolve({ data: { state: 'running' } })
    fenceSignal = request.signal
    return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
  })
  await scheduler.tick()
  const pending = scheduler.pendingFenceTick
  expect(pending).toBeInstanceOf(Promise)
  await scheduler.tick()
  expect(scheduler.pendingFenceTick).toBe(pending)
  expect(platform.json.mock.calls.filter(([request]) => request.route === 'mcp/cancel')).toHaveLength(1)
  expect(platform.json.mock.calls.filter(([request]) => request.route === 'scheduling'
    && JSON.parse(request.body).action === 'renew')).toHaveLength(2)
  expect(scheduler.hasAdmission('other')).toBe(true)
  expect(scheduler.hasAdmission('s')).toBe(false)
  expect(db.submission('t:1', stopped.id)).toBeDefined()
  scheduler.close()
  expect(fenceSignal.aborted).toBe(true)
  await pending
  expect(db.pendingRunFences('t:1').map(run => run.id)).toEqual([stopped.id])
  expect(scheduler.unfencedSessions.has('s')).toBe(true)
})

it('holds restored native inbox admission behind a durable fence without replaying the stopped run', async () => {
  const { db, scheduler, create, platform, agent, sessions } = setup()
  const stopped = create('stopped fixture')
  db.transitionRun('t:1', stopped.id, 'running')
  db.transitionRun('t:1', stopped.id, 'cancelled')
  const run = create('restored inbox fixture')
  db.bindNativeTurn(run, 1)
  scheduler.leases.set('s', { runId: stopped.id, checkedAt: Date.now() })
  expect(scheduler.unfencedSessions.has('s')).toBe(false)
  expect(scheduler.hasAdmission('s')).toBe(false)
  scheduler.leases.clear()
  let confirm
  platform.json.mockImplementation(request => request.route === 'mcp/cancel'
    ? new Promise(resolve => { confirm = resolve }) : Promise.resolve({ data: { state: 'running' } }))
  const next = vi.fn(() => ({ kind: 'continue' }))
  const admission = scheduler.admitNativeStep({ agent: { ...agent, id: 's' }, turn: 1, signal: new AbortController().signal }, next)
  expect(next).not.toHaveBeenCalled()
  expect(platform.json.mock.calls.map(([request]) => request.route)).toEqual(['mcp/cancel'])
  expect(db.getRun('t:1', run.id).status).toBe('queued')
  confirm({ data: { fenced: true } })
  await expect(admission).resolves.toEqual({ kind: 'continue' })
  expect(next).toHaveBeenCalledOnce()
  expect(db.pendingRunFences('t:1')).toEqual([])
  expect(db.getRun('t:1', stopped.id).status).toBe('cancelled')
  expect(db.getRun('t:1', run.id).status).toBe('running')
  expect(sessions.prompt).not.toHaveBeenCalled()
})

it('keeps no-argument cold recovery pending until every durable remote fence is confirmed', async () => {
  const { db, scheduler, create, platform } = setup()
  const run = create('cold recovery fixture')
  db.transitionRun('t:1', run.id, 'running')
  db.recoverInterrupted()
  platform.json.mockRejectedValue(new Error('offline'))
  await expect(scheduler.flushFences()).rejects.toMatchObject({ code: 'CANCEL_UNCONFIRMED' })
  expect(db.pendingRunFences('t:1').map(value => value.id)).toEqual([run.id])
  platform.json.mockResolvedValue({ data: { fenced: true } })
  await expect(scheduler.flushFences()).resolves.toBeUndefined()
  expect(db.pendingRunFences('t:1')).toEqual([])
  expect(db.getRun('t:1', run.id).status).toBe('interrupted')
})
