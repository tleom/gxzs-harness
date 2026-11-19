import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { userIdForOwner } from '../packages/workbench-adapter/src/assertion.js'

const [method = 'GET', target = '/ai/workbench/identity', bodyFile = '', contentType = 'application/json', lastEventId = ''] = process.argv.slice(2)
const issuer = process.env.GXZS_ASSERTION_ISSUER
const ownerId = process.env.GXZS_HOST_OWNER_ID
const signingKey = process.env.GXZS_ASSERTION_SIGNING_KEY
if (!issuer || !ownerId || !signingKey) throw new Error('GXZS_ASSERTION_ISSUER, GXZS_HOST_OWNER_ID and GXZS_ASSERTION_SIGNING_KEY are required')
const userId = userIdForOwner(ownerId)
if (!userId) throw new Error('GXZS_HOST_OWNER_ID must identify a bound user')
const body = bodyFile ? readFileSync(bodyFile) : Buffer.alloc(0)
const now = Math.floor(Date.now() / 1000)
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
const claims = {
  iss: issuer, aud: 'agent-workbench', sub: ownerId, user_id: userId,
  name: 'live-validation', iat: now, exp: now + 60, jti: randomUUID(), method: method.toUpperCase(),
  target, body_sha256: createHash('sha256').update(body).digest('hex'),
  content_type: contentType, last_event_id: lastEventId,
}
const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
const signature = createHmac('sha256', Buffer.from(signingKey, 'base64')).update(`${header}.${payload}`).digest('base64url')
process.stdout.write(`${header}.${payload}.${signature}`)
