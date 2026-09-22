import { describe, expect, it } from 'vitest'
import { httpError, sendError } from '../src/http.js'

function serialize(error) {
  let status, body
  sendError({ writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } }, error)
  return { status, ...body }
}

describe('public HTTP error contract', () => {
  it.each(['session/queue-item-not-found', 'session/agent-busy', 'session/steer-unavailable'])('preserves native %s as a recoverable conflict', (code) => {
    const result = serialize(Object.assign(new Error('private host details'), { isDSHRemoteError: true, code, details: { token: 'secret' } }))
    expect(result).toMatchObject({ status: 409, code })
    expect(JSON.stringify(result)).not.toContain('private host details')
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('preserves explicit stale-run business codes and maps native validation errors', () => {
    expect(serialize(httpError(409, '目标任务已结束', 'STALE_RUN'))).toEqual({ status: 409, code: 'STALE_RUN', message: '目标任务已结束' })
    expect(serialize(Object.assign(new Error('invalid'), { isDSHRemoteError: true, code: 'gateway/bad-request' })))
      .toMatchObject({ status: 400, code: 'gateway/bad-request' })
  })
  it('does not expose unexpected server messages or invalid status values', () => {
    for (const error of [new Error('/host/private/config token=secret'), Object.assign(new Error('secret'), { status: 999 }),
      Object.assign(new Error('secret'), { isDSHRemoteError: true, code: 'gateway/internal' })]) {
      expect(serialize(error)).toEqual({ status: 500, code: 'INTERNAL_ERROR', message: '工作台请求失败，请稍后重试' })
    }
  })
})
