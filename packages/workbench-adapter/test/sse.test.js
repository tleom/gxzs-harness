import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchDatabase } from '../src/persistence.js'
import { RunEventBus } from '../src/events.js'
import { streamRunEvents } from '../src/sse.js'

const cleanups = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

function setup() {
  const eventBus = new RunEventBus()
  const database = new WorkbenchDatabase(':memory:', { onEvent: (runId, event) => eventBus.publish(runId, event) })
  cleanups.push(() => database.close())
  const ownerId = 't:1'
  const chat = database.createChat({ ownerId, sessionId: 's', selection: {} })
  const { run } = database.createRun({ ownerId, chatId: chat.id, sessionId: 's', query: 'q', selection: {} })
  const req = new EventEmitter()
  const res = new EventEmitter()
  res.frames = []
  res.ended = false
  res.writeHead = () => {}
  res.write = (frame) => { res.frames.push(frame); return true }
  res.end = () => { res.ended = true }
  const stream = (options = {}) => {
    const finish = streamRunEvents({ database, eventBus, ownerId, runId: run.id, cursor: '0-0', req, res, ...options })
    cleanups.push(finish)
  }
  return { database, eventBus, ownerId, run, req, res, stream }
}

function entries(res) {
  return res.frames.filter((frame) => frame.startsWith('id:') || frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data: ')).slice(6)))
}

describe('durable SSE transport', () => {
  it('replays more than 10000 entries without truncation and yields between pages', async () => {
    const { database, ownerId, run, res, stream } = setup()
    for (let index = 0; index < 10_050; index++) database.appendEvent(ownerId, run.id, { event: 'text', text: String(index) })
    database.transitionRun(ownerId, run.id, 'completed')
    database.appendEvent(ownerId, run.id, { event: 'workbench_end', status: 'completed' })
    stream()
    expect(entries(res).length).toBeLessThan(10_051)
    await expect.poll(() => res.ended).toBe(true)
    expect(entries(res)).toHaveLength(10_051)
    expect(entries(res)[10_049]._id).toBe('10050-0')
    expect(res.ended).toBe(true)
  })

  it('deduplicates an event published during backlog replay', async () => {
    const { database, ownerId, run, res, stream } = setup()
    database.appendEvent(ownerId, run.id, { event: 'first' })
    const write = res.write
    let inserted = false
    res.write = (frame) => {
      write(frame)
      if (!inserted) {
        inserted = true
        database.appendEvent(ownerId, run.id, { event: 'second' })
      }
      return true
    }
    stream()
    await expect.poll(() => entries(res).length).toBe(2)
    expect(entries(res).map((entry) => entry._id)).toEqual(['1-0', '2-0'])
  })

  it('closes when a live terminal event arrives during replay', async () => {
    const { database, ownerId, run, res, stream } = setup()
    database.appendEvent(ownerId, run.id, { event: 'first' })
    const write = res.write
    let completed = false
    res.write = (frame) => {
      write(frame)
      if (!completed) {
        completed = true
        database.transitionRun(ownerId, run.id, 'completed')
        database.appendEvent(ownerId, run.id, { event: 'workbench_end', status: 'completed' })
      }
      return true
    }
    stream()
    await expect.poll(() => res.ended).toBe(true)
    expect(entries(res).at(-1)).toMatchObject({ event: 'workbench_end', status: 'completed' })
    expect(res.ended).toBe(true)
  })

  it('does not stop at an old waiting status after the run has resumed', () => {
    const { database, ownerId, run, res, stream } = setup()
    database.appendEvent(ownerId, run.id, { event: 'workbench_status', status: 'waiting_input' })
    database.appendEvent(ownerId, run.id, { event: 'workbench_status', status: 'running' })
    database.appendEvent(ownerId, run.id, { event: 'text', text: 'after answer' })
    database.transitionRun(ownerId, run.id, 'completed')
    database.appendEvent(ownerId, run.id, { event: 'workbench_end', status: 'completed' })
    stream()
    expect(entries(res).some((entry) => entry.text === 'after answer')).toBe(true)
    expect(entries(res).at(-1)).toMatchObject({ event: 'workbench_end', status: 'completed' })
  })

  it('closes current waiting streams and cleans up disconnected responses', () => {
    const waiting = setup()
    waiting.database.transitionRun(waiting.ownerId, waiting.run.id, 'waiting_input')
    waiting.stream()
    expect(waiting.res.ended).toBe(true)
    expect(waiting.eventBus.listeners.size).toBe(0)

    const running = setup()
    running.stream()
    running.req.emit('close')
    expect(running.eventBus.listeners.size).toBe(0)
    expect(running.res.ended).toBe(true)
  })

  it('stops socket writes under backpressure and resumes from the durable cursor', async () => {
    const { database, ownerId, run, res, stream } = setup()
    database.appendEvent(ownerId, run.id, { event: 'text', text: 'first' })
    const write = res.write
    res.write = (frame) => { write(frame); return false }
    stream()
    for (let i = 0; i < 2000; i++) database.appendEvent(ownerId, run.id, { event: 'text', text: String(i) })
    database.transitionRun(ownerId, run.id, 'completed')
    database.appendEvent(ownerId, run.id, { event: 'workbench_end', status: 'completed' })
    expect(res.frames).toHaveLength(1)
    expect(res.ended).toBe(false)
    res.write = write
    res.emit('drain')
    await expect.poll(() => res.ended).toBe(true)
    expect(entries(res)).toHaveLength(2002)
    expect(new Set(entries(res).map((entry) => entry._id)).size).toBe(2002)
    expect(res.listenerCount('drain')).toBe(0)
  })

  it('disconnects a stalled consumer without losing replayable events', async () => {
    const { database, eventBus, ownerId, run, res, stream } = setup()
    database.appendEvent(ownerId, run.id, { event: 'text', text: 'first' })
    res.write = () => false
    stream({ drainTimeoutMs: 10, heartbeatMs: 2 })
    database.appendEvent(ownerId, run.id, { event: 'text', text: 'second' })
    await expect.poll(() => res.ended).toBe(true)
    expect(eventBus.listeners.size).toBe(0)
    expect(database.eventsAfter(ownerId, run.id, 0, 10)).toHaveLength(2)
    expect(res.listenerCount('drain')).toBe(0)
  })
})
