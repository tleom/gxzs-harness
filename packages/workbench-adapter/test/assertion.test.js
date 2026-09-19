import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AssertionVerifier } from '../src/assertion.js'

const key = Buffer.alloc(32, 7).toString('base64')
const now = 1_700_000_000

function sign(overrides = {}) {
  const body = overrides.body ?? Buffer.from('{"query":"test"}')
  const claims = {
    iss: 'gxzs-backend', aud: 'dify-workbench', sub: 'tenant-a:42', tenant_id: 'tenant-a',
    user_id: '42', name: '用户', iat: now, exp: now + 60, jti: 'request-1', method: 'POST',
    target: '/workbench/chats/abc/runs', body_sha256: createHash('sha256').update(body).digest('hex'),
    content_type: 'application/json', last_event_id: '', ...overrides.claims,
  }
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', Buffer.from(key, 'base64')).update(`${header}.${payload}`).digest('base64url')
  return { token: `${header}.${payload}.${signature}`, body }
}

function request(body) {
  return { method: 'POST', target: '/workbench/chats/abc/runs', body, contentType: 'application/json', lastEventId: '' }
}

describe('gateway assertion verifier', () => {
  it('accepts a valid request-bound assertion and derives owner identity', () => {
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now })
    const { token, body } = sign()
    expect(verifier.verify(token, request(body))).toEqual({ ownerId: 'tenant-a:42', tenantId: 'tenant-a', userId: '42', name: '用户' })
  })

  it.each([
    ['method', { method: 'GET' }],
    ['target', { target: '/workbench/other' }],
    ['body_sha256', { body: Buffer.from('changed') }],
    ['content_type', { contentType: 'text/plain' }],
    ['last_event_id', { lastEventId: '1-0' }],
  ])('rejects a request with mismatched %s', (_name, changed) => {
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now })
    const { token, body } = sign()
    expect(() => verifier.verify(token, { ...request(body), ...changed })).toThrow('未绑定当前请求')
  })

  it('rejects replay of the same jti', () => {
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now })
    const { token, body } = sign()
    verifier.verify(token, request(body))
    expect(() => verifier.verify(token, request(body))).toThrow('已被使用')
  })

  it('rejects expired, wrong issuer and tampered assertions', () => {
    const expired = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now + 120 })
    const signed = sign()
    expect(() => expired.verify(signed.token, request(signed.body))).toThrow('已过期')

    const wrongIssuer = new AssertionVerifier({ issuer: 'other', signingKey: key, now: () => now })
    expect(() => wrongIssuer.verify(signed.token, request(signed.body))).toThrow('签发方无效')

    const tampered = `${signed.token.slice(0, -1)}x`
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now })
    expect(() => verifier.verify(tampered, request(signed.body))).toThrow('签名无效')
  })
})
