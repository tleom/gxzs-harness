import { describe, expect, it } from 'vitest'
import { httpError, sendError } from '../src/http.js'

function serialize(error) {
  let status, body
  sendError({ writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } }, error)
  return { status, ...body }
}

describe('public HTTP error contract', () => {
  it.each([
    ['MODEL_DOES_NOT_SUPPORT_IMAGES', '所选模型不支持图片输入'],
    ['FILE_NOT_STAGED', '附件上传凭据已失效'],
    ['UNKNOWN_REASON', '附件参数无效'],
  ])('projects native attachment reason %s without exposing diagnostic details', (reason, message) => {
    const error = Object.assign(new Error('/host/private/file secret'), {
      isDSHRemoteError: true, code: 'session/attachment-invalid', details: { reason, token: 'secret' },
    })
    const result = serialize(error)
    expect(result).toMatchObject({ status: 400, code: error.code, message: expect.stringContaining(message) })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('/host')
  })
  it.each(['session/queue-item-not-found', 'session/agent-busy', 'session/steer-unavailable', 'settings/conflict'])('preserves native %s as a recoverable conflict', (code) => {
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
  it('preserves bounded resource correlation metadata and rejects invalid values', () => {
    const error = Object.assign(httpError(503, '服务繁忙', 'RESOURCE_BUSY'), { request_id: 'req_123', retry_after: 2 })
    expect(serialize(error)).toEqual({ status: 503, code: 'RESOURCE_BUSY', message: '服务繁忙', request_id: 'req_123', retry_after: 2 })
    expect(serialize(Object.assign(error, { request_id: '/host/private', retry_after: 61 })))
      .toEqual({ status: 503, code: 'RESOURCE_BUSY', message: '服务繁忙' })
  })
})
