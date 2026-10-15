import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { sessionReferenceScope } from '../../../scripts/prepare-session-references.mjs'

const require = createRequire(new URL('../../../profiles/workbench/package.json', import.meta.url))
const source = await readFile(require.resolve('@deepseek-ai/dsh-session-reference'), 'utf8')
const prepared = sessionReferenceScope(source)
const restored = prepared.replace(/\t\tasync listCandidates[\s\S]*?\t\tasync listSessionCandidates\(header,/,
  '\t\tasync listCandidates(agent,').replace('const targetCwd = header.cwd;', 'const targetCwd = agent.session.header.cwd;')
  .replace('record.header.id !== header.id', 'record.header.id !== agent.id')

it('prepares only the native candidate target and refuses unknown target contracts', () => {
  expect(sessionReferenceScope(prepared)).toBe(prepared)
  expect(restored).toContain('const targetCwd = agent.session.header.cwd;')
  expect(restored).not.toContain('\t\tasync listSessionCandidates(')
  expect(() => sessionReferenceScope(restored.replace('agent.session.header.cwd', 'agent.cwd'))).toThrow('contract changed')
  expect(sessionReferenceScope(restored)).toBe(prepared)
  if (!source.includes('\t\tasync listSessionCandidates(')) expect(restored).toBe(source)
})

it('runs the full prepared native service with a real observed header and unchanged native ranking', async () => {
  const [{ Context }, { Session }] = await Promise.all([
    'cordis', 'dsh-session',
  ].map(name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href)))
  // Dependency URLs make this isolated full published module loadable without
  // writing into the installed library. Only the preparation changes its body.
  const imports = body => body.replace(/^(import .*? from )"([^"]+)";/gm, (_all, prefix, name) =>
    prefix + JSON.stringify(pathToFileURL(require.resolve(name)).href) + ';')
  const taskTemp = fileURLToPath(new URL('../../../../temp/native-reference-preparation/', import.meta.url))
  await mkdir(taskTemp, { recursive: true })
  const file = join(taskTemp, randomUUID() + '.mjs')
  const originalFile = join(taskTemp, randomUUID() + '.mjs')
  await writeFile(file, imports(prepared))
  await writeFile(originalFile, imports(restored))
  const ctx = new Context()
  try {
    const { default: Prepared } = await import(pathToFileURL(file).href)
    const { default: Original } = await import(pathToFileURL(originalFile).href)
    const header=(id,cwd)=>({...Session.create(id).header,cwd})
    const target = Session.create('child', undefined, header('child','/workspace/child'))
    const records = ['child', 'elsewhere', 'same'].map(id => ({
      header: Session.create(id, undefined, header(id,id === 'elsewhere' ? '/workspace/other' : '/workspace/child')).header,
    }))
    ctx.provide('sessionQuery', { listSessions: async () => records })
    const resolver = new Prepared(ctx)
    for (const query of ['', 'SAME', 'child', 'missing']) {
      const actual = await resolver.listSessionCandidates(target.header, query, 2)
      const original = await Original.prototype.listCandidates.call(resolver, { id: target.id, session: target }, query, 2)
      expect(actual).toEqual(original)
    }
    expect((await resolver.listSessionCandidates(target.header)).map(item => item.sessionId)).toEqual(['same', 'elsewhere'])
    await expect(resolver.listSessionCandidates(target.header, '', 0)).rejects.toMatchObject({ code: 'SESSION_REFERENCE_INVALID_REFERENCE' })
    await expect(resolver.listSessionCandidates(target.header, '', 2, AbortSignal.abort(new Error('picker closed')))).rejects.toThrow('cancelled')
  } finally { await ctx.fiber.dispose(); await unlink(file); await unlink(originalFile) }
})
