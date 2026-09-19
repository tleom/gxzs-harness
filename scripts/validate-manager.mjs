const baseUrl = process.env.GXZS_SANDBOX_MANAGER_URL?.replace(/\/+$/, '')
const workspaceId = process.env.GXZS_SANDBOX_WORKSPACE_ID
const token = process.env.GXZS_SANDBOX_MANAGER_TOKEN
if (!baseUrl || !workspaceId || !token) throw new Error('GXZS_SANDBOX_MANAGER_URL, GXZS_SANDBOX_WORKSPACE_ID and GXZS_SANDBOX_MANAGER_TOKEN are required')
const prefix = `harness-validation-${Date.now()}`
const call = async (payload) => {
  const response = await fetch(`${baseUrl}/sandboxes/${workspaceId}/files`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000),
  })
  const value = await response.json()
  if (!response.ok || value.error || value.conflict) throw new Error(`${response.status}: ${JSON.stringify(value)}`)
  return value
}
const directory = prefix
const file = `${prefix}/binary.bin`
await call({ operation: 'mkdir', path: directory })
const first = await call({ operation: 'upload', path: file, version: null, data: Buffer.from([0, 255, 1, 2]).toString('base64') })
const stale = await fetch(`${baseUrl}/sandboxes/${workspaceId}/files`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ operation: 'upload', path: file, version: 'stale-version', data: 'AA==' }),
})
const staleValue = await stale.json()
if (!staleValue.conflict) throw new Error(`expected version conflict: ${JSON.stringify(staleValue)}`)
await call({ operation: 'delete', path: file, version: first.version })
const stat = await call({ operation: 'stat', path: file })
if (stat.kind !== 'missing') throw new Error(`expected deleted file: ${JSON.stringify(stat)}`)
const directoryStat = await call({ operation: 'stat', path: directory })
await call({ operation: 'delete', path: directory, version: directoryStat.version })
console.log(JSON.stringify({ ok: true, prefix, conflict: true }))
