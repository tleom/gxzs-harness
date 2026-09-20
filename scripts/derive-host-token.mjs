import { createHmac } from 'node:crypto'

const [owner, generationText, instanceId] = process.argv.slice(2)
const generation = Number(generationText)
const encodedKey = process.env.GXZS_PLATFORM_INTERNAL_KEY
if (!owner || !Number.isSafeInteger(generation) || generation < 1 || !instanceId || !encodedKey)
  throw new Error('usage: GXZS_PLATFORM_INTERNAL_KEY=<base64> node scripts/derive-host-token.mjs <owner> <generation> <instance-id>')
const key = Buffer.from(encodedKey, 'base64')
if (key.length < 32) throw new Error('GXZS_PLATFORM_INTERNAL_KEY must decode to at least 32 bytes')
process.stdout.write(createHmac('sha256', key).update(`gxzs-dsh-platform:${owner}:${generation}:${instanceId}`).digest('base64url'))
