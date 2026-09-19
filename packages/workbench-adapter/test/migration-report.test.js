import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const bundle = {
    source_id: 'batch', owner_id: 't:1', workspace: { id: 'w', tree_version: 'v', files: 2, bytes: 3 },
    chats: [{ id: 'c', runs: [{ id: 'r', events: [{ event: 'x' }, { event: 'y' }] }] }],
  }
  const digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex')
  const report = { source_id: 'batch', owner_id: 't:1', digest, workspace: bundle.workspace, chats: [{ runs: 1, events: 2 }] }
  const root = mkdtempSync(join(tmpdir(), 'gxzs-migration-report-'))
  roots.push(root)
  const bundlePath = join(root, 'bundle.json'); const reportPath = join(root, 'report.json')
  writeFileSync(bundlePath, JSON.stringify(bundle)); writeFileSync(reportPath, JSON.stringify({ data: report }))
  return { report, reportPath, bundlePath }
}

describe('migration cutover verifier', () => {
  it('accepts matching digest and totals', () => {
    const item = fixture()
    const result = spawnSync(process.execPath, [resolve('scripts/verify-migration.mjs'), item.bundlePath, item.reportPath], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, chats: 1, runs: 1, events: 2 })
  })

  it('fails closed when report totals are changed', () => {
    const item = fixture()
    writeFileSync(item.reportPath, JSON.stringify({ ...item.report, chats: [{ runs: 1, events: 1 }] }))
    const result = spawnSync(process.execPath, [resolve('scripts/verify-migration.mjs'), item.bundlePath, item.reportPath], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false })
  })
})
