import { createHash, createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AssertionVerifier } from '../src/assertion.js'

const key = Buffer.alloc(32, 7).toString('base64')
const now = 1_700_000_000

it.each(['gxzs-1'])('accepts the maintenance signing script for %s', (ownerId) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/sign-request.mjs', import.meta.url))], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GXZS_ASSERTION_ISSUER: 'script-test', GXZS_HOST_OWNER_ID: ownerId, GXZS_ASSERTION_SIGNING_KEY: key },
  })
  expect(result.status, result.stderr).toBe(0)
  expect(new AssertionVerifier({ issuer: 'script-test', signingKey: key }).verify(result.stdout, {
    method: 'GET', target: '/ai/workbench/identity', body: Buffer.alloc(0), contentType: 'application/json', lastEventId: '',
  })).toMatchObject({ ownerId, userId: '1' })
  const [, payload] = result.stdout.split('.')
  expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).not.toHaveProperty('tenant_id')
})

function sign(overrides = {}) {
  const body = overrides.body ?? Buffer.from('{"query":"test"}')
  const claims = {
    iss: 'gxzs-backend', aud: 'agent-workbench', sub: 'gxzs-42',
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
  it.each([
    ['gxzs-42', '42'],
    ['gxzs-9223372036854775807', '9223372036854775807'],
  ])('accepts request-bound assertions for %s', (ownerId, userId) => {
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now })
    const { token, body } = sign({ claims: { sub: ownerId, user_id: userId } })
    expect(verifier.verify(token, request(body))).toEqual({ ownerId, userId, name: '用户' })
  })

  it('rejects assertions with a removed tenant claim', () => {
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now })
    const { token, body } = sign({ claims: { tenant_id: '000000' } })
    expect(() => verifier.verify(token, request(body))).toThrow('身份断言主体无效')
  })

  it.each([
    { user_id: '43' },
    { user_id: 42 },
    { tenant_id: 'different-tenant' },
    { sub: 'gxzs-042', user_id: '042' },
    { sub: 'gxzs-9223372036854775808', user_id: '9223372036854775808' },
    { sub: 'gxzs-42\n' },
  ])('rejects an assertion with an invalid bound user %o', (claims) => {
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now })
    const { token, body } = sign({ claims })
    expect(() => verifier.verify(token, request(body))).toThrow('身份断言主体无效')
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

  it('retains replay protection throughout the inclusive clock-skew acceptance window', () => {
    let clock = now
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => clock })
    const { token, body } = sign()
    verifier.verify(token, request(body))
    for (clock of [now + 60, now + 61, now + 65])
      expect(() => verifier.verify(token, request(body))).toThrow('已被使用')
    clock = now + 66
    expect(() => verifier.verify(token, request(body))).toThrow('已过期')
  })

  it('accepts only a signed integer deadline alongside the current identity', () => {
    const deadline = (now + 110) * 1000
    const verifier = new AssertionVerifier({ issuer: 'gxzs-backend', signingKey: key, now: () => now })
    const { token, body } = sign({ claims: { request_deadline_ms: deadline } })
    expect(verifier.verify(token, request(body)).deadlineMs).toBe(deadline)
    for (const value of ['1700000000000', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const signed = sign({ claims: { request_deadline_ms: value } })
      expect(() => verifier.verify(signed.token, request(signed.body))).toThrow('请求期限无效')
    }
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
