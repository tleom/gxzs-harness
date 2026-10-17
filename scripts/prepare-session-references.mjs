import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const signature = '\t\tasync listCandidates(agent, query = "", limit = this.config.candidateLimit, signal) {'
const prepared = `${signature}
\t\t\treturn this.listSessionCandidates(agent.session.header, query, limit, signal);
\t\t}
\t\tasync listSessionCandidates(header, query = "", limit = this.config.candidateLimit, signal) {`

/** Expose the existing read-only algorithm for an observed Session header.
 * The ordinary Agent lookup and all prompt/delivery authorities remain native.
 */
export function sessionReferenceScope(source) {
  if (source.includes(prepared)) return source
  const start = source.indexOf(signature)
  const end = source.indexOf('\n\t\t/**', start)
  if (start < 0 || end < start || source.split(signature).length !== 2)
    throw new Error('DSH session reference candidate contract changed')
  const body = source.slice(start, end)
  if (body.split('agent.session.header.cwd').length !== 2 || body.split('record.header.id !== agent.id').length !== 2)
    throw new Error('DSH session reference target contract changed')
  const result = body.replace(signature, prepared)
    .replace('agent.session.header.cwd', 'header.cwd')
    .replace('record.header.id !== agent.id', 'record.header.id !== header.id')
  if (/\bagent\b/.test(result.slice(result.indexOf('async listSessionCandidates'))))
    throw new Error('DSH session reference candidate now requires a live Agent')
  return source.slice(0, start) + result + source.slice(end)
}

export async function prepareSessionReferences(profile) {
  const require = createRequire(join(profile, 'package.json'))
  const metadata = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session-reference/package.json'), 'utf8'))
  if (metadata.version !== '0.2.1-rc.2') throw new Error(`Unverified session reference version: ${metadata.version}`)
  const entry = require.resolve('@deepseek-ai/dsh-session-reference')
  const source = await readFile(entry, 'utf8')
  const result = sessionReferenceScope(source)
  if (result !== source) await writeFile(entry, result)
}
