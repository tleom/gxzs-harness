import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const REQUIRED = ['iss', 'aud', 'sub', 'tenant_id', 'user_id', 'iat', 'exp', 'jti', 'method', 'target', 'body_sha256', 'content_type', 'last_event_id']

export class AssertionVerifier {
  constructor({ issuer, audience = 'agent-workbench', signingKey, clockSkewSeconds = 5, replayCache, now = () => Math.floor(Date.now() / 1000) }) {
    this.issuer = issuer
    this.audience = audience
    this.key = decodeKey(signingKey)
    this.clockSkewSeconds = clockSkewSeconds
    this.replayCache = replayCache ?? new ReplayCache()
    this.now = now
  }

  verify(token, request) {
    if (typeof token !== 'string') throw unauthorized('缺少工作台身份断言')
    const parts = token.split('.')
    if (parts.length !== 3) throw unauthorized('工作台身份断言格式无效')
    const [headerPart, payloadPart, signaturePart] = parts
    const header = decodeJson(headerPart)
    const claims = decodeJson(payloadPart)
    if (header.alg !== 'HS256' || header.typ !== 'JWT') throw unauthorized('工作台身份断言算法无效')
    for (const name of REQUIRED) if (!(name in claims)) throw unauthorized('工作台身份断言缺少必要字段')

    const expected = createHmac('sha256', this.key).update(`${headerPart}.${payloadPart}`, 'ascii').digest()
    const actual = decodeBase64Url(signaturePart)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw unauthorized('工作台身份断言签名无效')

    const now = this.now()
    if (claims.iss !== this.issuer || claims.aud !== this.audience) throw unauthorized('工作台身份断言签发方无效')
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now + this.clockSkewSeconds || claims.exp < now - this.clockSkewSeconds)
      throw unauthorized('工作台身份断言已过期')
    if (claims.exp - claims.iat > 60 + this.clockSkewSeconds) throw unauthorized('工作台身份断言有效期无效')

    if (!/^[a-f0-9]{64}$/.test(claims.body_sha256)) throw unauthorized('工作台请求摘要无效')
    const body = request.body ?? Buffer.alloc(0)
    const expectedClaims = {
      method: String(request.method ?? '').toUpperCase(),
      target: request.target,
      ...(request.streaming ? {} : { body_sha256: createHash('sha256').update(body).digest('hex') }),
      content_type: request.contentType ?? '',
      last_event_id: request.lastEventId ?? '',
    }
    for (const [name, value] of Object.entries(expectedClaims))
      if (claims[name] !== value) throw unauthorized(`工作台身份断言未绑定当前请求：${name}`)

    if (claims.sub !== `${claims.tenant_id}:${claims.user_id}`) throw unauthorized('工作台身份断言主体无效')
    if (claims.request_deadline_ms !== undefined && (!Number.isSafeInteger(claims.request_deadline_ms) || claims.request_deadline_ms < 0))
      throw unauthorized('工作台请求期限无效')
    if (this.replayCache.consume(claims.jti, claims.exp + this.clockSkewSeconds, now) === false) throw unauthorized('工作台身份断言已被使用')
    return {
      ...(request.streaming ? { verifyBody: digest => {
        if (digest !== claims.body_sha256) throw unauthorized('工作台身份断言未绑定当前请求：body_sha256')
      } } : {}),
      ownerId: claims.sub,
      tenantId: String(claims.tenant_id),
      userId: String(claims.user_id),
      name: typeof claims.name === 'string' ? claims.name : '',
      ...(claims.request_deadline_ms === undefined ? {} : { deadlineMs: claims.request_deadline_ms }),
    }
  }
}

export class ReplayCache {
  constructor() { this.entries = new Map() }
  consume(jti, expiresAt, now) {
    for (const [key, expiry] of this.entries) if (expiry < now) this.entries.delete(key)
    if (typeof jti !== 'string' || !jti || this.entries.has(jti)) return false
    this.entries.set(jti, expiresAt)
    return true
  }
}

function decodeKey(value) {
  if (typeof value !== 'string') throw new Error('GXZS assertion signing key is not configured')
  const key = Buffer.from(value, 'base64')
  if (key.length < 32) throw new Error('GXZS assertion signing key must decode to at least 32 bytes')
  return key
}

function decodeJson(value) {
  try { return JSON.parse(decodeBase64Url(value).toString('utf8')) }
  catch { throw unauthorized('工作台身份断言格式无效') }
}

function decodeBase64Url(value) {
  try { return Buffer.from(value, 'base64url') }
  catch { throw unauthorized('工作台身份断言格式无效') }
}

function unauthorized(message) { return Object.assign(new Error(message), { status: 401 }) }
