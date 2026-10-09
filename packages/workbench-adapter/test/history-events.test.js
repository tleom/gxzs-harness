import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { streamHistoryEvents } from '../src/history-events.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function response() {
  const res = new EventEmitter()
  res.headersSent = false
  res.writeHead = vi.fn(() => { res.headersSent = true })
  res.write = vi.fn(() => true)
  res.end = vi.fn(() => { res.writableEnded = true })
  return res
}
it('forwards native snapshots and deltas, and releases the pending follower on disconnect', async () => {
  const res = response(), disposed = vi.fn()
  let signal
  const service = { async *followHistory(owner, chatId, value) {
    signal = value
    expect(owner.ownerId).toBe('owner'); expect(chatId).toBe('chat')
    try {
      yield { event:'workbench_history',value:{type:'snapshot',cursor:19} }
      yield { event:'workbench_history',value:{type:'assistant-stream',frame:{revision:2}} }
      await new Promise(resolve=>value.addEventListener('abort',resolve,{once:true}))
    } finally { disposed() }
  } }
  const running=streamHistoryEvents({service,owner:{ownerId:'owner'},chatId:'chat',res})
  await tick()
  expect(res.write.mock.calls.map(([text])=>JSON.parse(text.slice(6)))).toEqual([
    {event:'workbench_history',value:{type:'snapshot',cursor:19}},
    {event:'workbench_history',value:{type:'assistant-stream',frame:{revision:2}}},
  ])
  res.emit('close'); await running
  expect(signal.aborted).toBe(true)
  expect(disposed).toHaveBeenCalledOnce()
  expect(res.listenerCount('close')).toBe(0)
})
it('does not request more native frames until a blocked socket drains', async () => {
  const res=response(), next=vi.fn()
  res.write.mockReturnValueOnce(false)
  const service={ async *followHistory() {
    yield {event:'workbench_history',value:{type:'snapshot'}}
    next()
    yield {event:'workbench_history',value:{type:'event'}}
  } }
  const running=streamHistoryEvents({service,res})
  await tick(); expect(next).not.toHaveBeenCalled()
  res.emit('drain'); await running
  expect(next).toHaveBeenCalledOnce()
  expect(res.end).toHaveBeenCalledOnce()
  expect(res.listenerCount('drain')).toBe(0)
})
it('aborts and disposes a slow reader when its drain deadline expires', async () => {
  const res=response(), disposed=vi.fn()
  res.write.mockReturnValue(false)
  let signal
  const service={ async *followHistory(_owner,_id,value) {
    signal=value
    try { yield {event:'workbench_history',value:{type:'snapshot'}} }
    finally { disposed() }
  } }
  const running=streamHistoryEvents({service,res,drainTimeoutMs:10})
  await new Promise(resolve=>setTimeout(resolve,25)); await running
  expect(signal.aborted).toBe(true)
  expect(disposed).toHaveBeenCalledOnce()
  expect(res.listenerCount('drain')).toBe(0)
})
it('preserves authorization errors before writing streaming headers', async () => {
  const res=response(), denied=Object.assign(new Error('missing'),{status:404})
  const service={ async *followHistory() { throw denied } }
  await expect(streamHistoryEvents({service,res})).rejects.toBe(denied)
  expect(res.writeHead).not.toHaveBeenCalled()
  expect(res.listenerCount('close')).toBe(0)
})
it('closes an interrupted native stream without a synthetic completion', async () => {
  const res=response()
  const service={ async *followHistory() {
    yield {event:'workbench_history',value:{type:'snapshot'}}
    throw new Error('native follow lost')
  } }
  await streamHistoryEvents({service,res})
  expect(res.write).toHaveBeenCalledTimes(1)
  expect(res.end).toHaveBeenCalledOnce()
})
