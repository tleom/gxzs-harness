import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { WorkbenchSchedules } from '../src/schedules.js'

const databases = []
const directories = []
afterEach(() => {
  databases.splice(0).forEach(db => db.close())
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})
function fixture(path = ':memory:') {
  const database = new WorkbenchDatabase(path); databases.push(database)
  const owner = { ownerId: 'owner' }
  const chat = database.createChat({ ownerId: owner.ownerId, sessionId: 'session', selection: {} })
  const create = vi.fn(async (_session, request) => ({ id: 'schedule-one', ...request }))
  const service = { requireChat: (who, id) => database.getChat(who.ownerId, id) }
  const gateway = new WorkbenchSchedules({ native: { create }, database, service })
  const request = { request_key: 'logical-request', title: '提醒', prompt: '内容', every_seconds: 60, notify_enabled: false }
  return { database, owner, chat, create, service, gateway, request }
}
it('reuses the durable result after a lost HTTP response and database reopen', async () => {
  const dir = mkdtempSync(join(process.cwd(), '.schedule-creation-')); directories.push(dir)
  const path = join(dir, 'workbench.sqlite')
  const h = fixture(path)
  const first = await h.gateway.create(h.owner, h.chat.id, h.request)
  databases.pop().close()
  const reopened = new WorkbenchDatabase(path); databases.push(reopened)
  const recovered = new WorkbenchSchedules({ native: { create: h.create }, database: reopened,
    service: { requireChat: (owner, id) => reopened.getChat(owner.ownerId, id) } })
  expect(await recovered.create(h.owner, h.chat.id, h.request)).toEqual(first)
  expect(h.create).toHaveBeenCalledOnce()
  expect(h.create.mock.calls[0][1]).not.toHaveProperty('request_key')
  await expect(recovered.create(h.owner, h.chat.id, { ...h.request, title: '另一个任务' })).rejects.toMatchObject({ status: 409 })
})
it('coalesces simultaneous retries and finishes recording after the response connection closes', async () => {
  const h = fixture()
  let release
  h.create.mockImplementationOnce(async () => new Promise(resolve => { release = resolve }))
  const connection = new AbortController()
  const first = h.gateway.create(h.owner, h.chat.id, h.request, connection.signal)
  connection.abort()
  const second = h.gateway.create(h.owner, h.chat.id, h.request)
  release({ id: 'schedule-one' })
  expect(await first).toEqual(await second)
  expect(h.create).toHaveBeenCalledOnce()
})
it('does not repeat an uncertain native write, including after rebuilding the adapter', async () => {
  const h = fixture()
  h.create.mockRejectedValueOnce(new Error('storage outcome unknown'))
  await expect(h.gateway.create(h.owner, h.chat.id, h.request)).rejects.toThrow('storage outcome unknown')
  const recovered = new WorkbenchSchedules({ native: { create: h.create }, database: h.database, service: h.service })
  await expect(recovered.create(h.owner, h.chat.id, h.request)).rejects.toThrow('创建结果尚未确认')
  expect(h.create).toHaveBeenCalledOnce()
})
it('records definitive native input refusals and permits a corrected logical request', async () => {
  const h = fixture()
  h.create.mockRejectedValueOnce(Object.assign(new Error('invalid'), { name: 'ScheduleInputError', code: 'not_future' }))
  const failed = await h.gateway.create(h.owner, h.chat.id, h.request)
  expect(failed).toMatchObject({ creation_failed: true, code: 'not_future' })
  expect(await h.gateway.create(h.owner, h.chat.id, h.request)).toEqual(failed)
  expect(await h.gateway.create(h.owner, h.chat.id, { ...h.request, request_key: 'corrected' })).toHaveProperty('id')
  expect(h.create).toHaveBeenCalledTimes(2)
})
