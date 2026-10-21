import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileManagerClient } from '/opt/workbench/packages/workbench-file-manager/src/index.js'

const [workspaceId, phase] = process.argv.slice(2)
const manager = new FileManagerClient({ baseUrl: 'http://127.0.0.1:5010', workspaceId, tokenEnv: 'TEST_MANAGER_TOKEN' })
const directory = await mkdtemp(join(tmpdir(), 'gxzs-stream-smoke-'))
const mib = 1024 * 1024
try {
  if (phase === 'file') {
    for (const count of [3, 4, 5, 10]) {
      await Promise.all(Array.from({ length: count }, async (_, index) => {
        const path = join(directory, `small-${index}`), bytes = Buffer.from(`batch-file-${index}`)
        await writeFile(path, bytes)
        const metadata = { operation: 'upload', path: `probe/small-${index}.txt`, version: null }
        const result = await manager.upload('files', { path, metadata, size: bytes.length, offset: 0 })
        assert.equal(result.version, createHash('sha256').update(bytes).digest('hex'))
        const download = await manager.download(metadata.path), parts = []
        for await (const part of download.body) parts.push(Buffer.from(part))
        assert.deepEqual(Buffer.concat(parts), bytes)
        await manager.operate({ operation: 'delete', path: metadata.path, version: result.version })
      }))
      console.log(`PASS ${count} concurrent small-file uploads/downloads: exact bytes, independent versions, no Host exit`)
    }
    const path = join(directory, 'upload')
    const size = 100 * mib
    const metadata = { operation: 'upload', path: 'probe/large.bin', size, version: null }
    const header = Buffer.from(JSON.stringify(metadata) + '\n')
    const chunk = Buffer.alloc(64 * 1024, 65), hash = createHash('sha256')
    const file = await open(path, 'wx')
    try {
      await file.writeFile(header)
      for (let i = 0; i < size / chunk.length; i++) { await file.writeFile(chunk); hash.update(chunk) }
    } finally { await file.close() }
    const upload = { path, metadata, size: header.length + size, offset: header.length }
    const expected = hash.digest('hex')
    assert.equal((await manager.upload('files', upload)).version, expected)
    const result = await manager.download(metadata.path)
    assert.equal(result.size, size)
    assert.equal(result.version, expected)
    const actual = createHash('sha256')
    let bytes = 0
    for await (const part of result.body) { bytes += part.length; actual.update(part) }
    assert.equal(bytes, size)
    assert.equal(actual.digest('hex'), expected)
    await assert.rejects(manager.upload('files', upload), error => error.status === 409)
    const append = await open(path, 'a'); await append.writeFile('x'); await append.close()
    await assert.rejects(manager.upload('files', { ...upload, size: upload.size + 1,
      metadata: { ...metadata, size: size + 1, path: 'probe/oversize.bin' } }), error => [400, 413].includes(error.status))
    assert.equal((await manager.operate({ operation: 'stat', path: 'probe/oversize.bin' })).kind, 'missing')
    const skill = Buffer.from('---\nname: upload-audit\ndescription: Streaming upload fixture\n---\n# Skill\n')
    const skillMetadata = { operation: 'skill_inspect', archive: false,
      files: [{ path: 'SKILL.md', size: skill.length }] }
    const skillHeader = Buffer.from(JSON.stringify(skillMetadata) + '\n')
    const skillPath = join(directory, 'skill')
    const source = await open(skillPath, 'wx'); await source.writeFile(skillHeader); await source.writeFile(skill); await source.close()
    const packageUpload = { path: skillPath, metadata: skillMetadata, size: skillHeader.length + skill.length, offset: skillHeader.length }
    assert.equal((await manager.upload('personal-resources', packageUpload)).content, skill.toString())
    const imported = await manager.upload('personal-resources', { ...packageUpload,
      metadata: { ...skillMetadata, operation: 'skill_import', name: 'upload-audit', version: null } })
    assert.ok(imported.version)
    await assert.rejects(manager.upload('personal-resources', { ...packageUpload,
      metadata: { ...skillMetadata, operation: 'skill_import', name: 'upload-audit', version: 'stale' } }), error => error.status === 409)
    await manager.personalResources({ operation: 'skill_uninstall', name: 'upload-audit', version: imported.version })
    console.log('PASS streaming files: 100 MiB binary upload/download SHA-256, conflicts, oversize rejection, skill import/version checks')
  } else if (phase === 'directory') {
    const result = await manager.download('probe/stream-dir')
    assert.equal(result.kind, 'directory')
    let bytes = 0
    for await (const chunk of result.body) bytes += chunk.length
    assert.equal(bytes, result.size)
    console.log('PASS directory streaming: exact 1 GiB of source files and over 10000 entries')
  } else if (phase === 'oversize-directory') {
    await assert.rejects(manager.download('probe/stream-dir'), error => error.status === 400)
    console.log('PASS directory streaming: 1 GiB plus one byte rejected')
  } else { throw new Error('Unknown streaming smoke phase') }
} finally { await rm(directory, { recursive: true, force: true }) }
