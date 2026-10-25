import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { inflateRawSync } from 'node:zlib'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileManagerClient } from '/opt/workbench/packages/workbench-file-manager/src/index.js'
import WorkbenchAttachmentStore from '/opt/workbench/packages/workbench-adapter/src/attachment-store.js'
import { admitSandboxAttachments, prepareNativeFiles } from '/opt/workbench/packages/workbench-adapter/src/attachments.js'

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
        const metadata = { operation: 'upload', path: `probe/small-${index}.txt`, size: bytes.length, version: null }
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
  } else if (phase === 'legacy-skill-json') {
    const download = await manager.download('probe/legacy-skill-json.zip')
    const path = join(directory, 'legacy-skill-json.zip'), file = await open(path, 'wx')
    try { for await (const chunk of download.body) await file.write(chunk) }
    finally { await file.close() }
    assert.equal(download.size, 100 * mib)
    const archive = (await readFile(path)).toString('base64')
    const imported = await manager.personalResources({ operation: 'skill_import', name: 'legacy-json-large', archive, version: null })
    assert.equal(imported.id, 'legacy-json-large')
    const asset = await manager.operate({ operation: 'stat', path: 'skills/legacy-json-large/asset.bin' })
    assert.ok(asset.size > 99 * mib)
    const tail = Buffer.from(archive.slice(-4), 'base64')
    assert.equal(tail.length, 1)
    const oversized = archive.slice(0, -4) + Buffer.from([tail[0], 0]).toString('base64')
    await assert.rejects(manager.personalResources({ operation: 'skill_import', name: 'legacy-json-large', archive: oversized,
      version: imported.version }), error => [400, 413].includes(error.status))
    const current = await manager.personalResources({ operation: 'list' })
    assert.equal(current.skills.find(skill => skill.id === imported.id).version, imported.version)
    await manager.personalResources({ operation: 'skill_uninstall', name: imported.id, version: imported.version })
    console.log('PASS legacy skill JSON: exact 100 MiB ZIP installed, 100 MiB plus one decoded byte rejected, previous skill preserved')
  } else if (phase === 'skill-package') {
    const download = await manager.download('probe/skill-package.zip')
    const metadata = { operation: 'skill_inspect', archive: true,
      files: [{ path: 'large-skill.zip', size: download.size }] }
    const header = Buffer.from(JSON.stringify(metadata) + '\n')
    const path = join(directory, 'large-skill-upload'), file = await open(path, 'wx')
    try {
      await file.writeFile(header)
      for await (const chunk of download.body) await file.writeFile(chunk)
    } finally { await file.close() }
    const upload = { path, metadata, size: header.length + download.size, offset: header.length }
    const prepare = async version => {
      const import_id = randomUUID().replaceAll('-', '')
      const staged = await manager.upload('personal-resources', { ...upload,
        metadata: { ...metadata, operation: 'skill_stage', import_id } })
      assert.match(staged.content, /name: streamed-package/)
      const prepared = await manager.personalResources({ operation: 'skill_prepare', import_id,
        name: 'streamed-package', version })
      return { operation: 'skill_import', import_id, name: 'streamed-package', version: prepared.version }
    }
    const install = async version => {
      const request = await prepare(version)
      let result = await manager.personalResources(request)
      // An uncertain observation is not a terminal receipt and must not replay
      // the import. Keep querying the same durable import within this bound.
      for (let i = 0; ['running', 'unknown'].includes(result.status) && i < 600; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        result = await manager.personalResources({ operation: 'skill_import_status', import_id: request.import_id })
      }
      assert.equal(result.status, 'completed', JSON.stringify(result))
      return result
    }
    const first = await install(null)
    const asset = await manager.operate({ operation: 'stat', path: 'skills/streamed-package/asset.bin' })
    assert.equal(asset.size, 256 * mib)
    assert.equal(asset.downloadable, true)
    const second = await install(first.version)
    assert.notEqual(second.version, first.version)
    await assert.rejects(install(first.version), error => error.status === 409)
    const pending = await prepare(second.version)
    const stopped = await manager.personalResources({ operation: 'skill_import_cancel', import_id: pending.import_id })
    assert.equal(stopped.status, 'cancelled')
    await assert.rejects(manager.personalResources(pending), error => error.code === 'SKILL_IMPORT_CANCELLED')
    const active = await prepare(second.version)
    assert.equal((await manager.personalResources(active)).status, 'running')
    let extracting = false
    for (let i = 0; i < 100; i++) {
      const saved = await manager.operate({ operation: 'get', path: `.skill-imports/${active.import_id}/state.json` })
      const receipt = JSON.parse(Buffer.from(saved.data, 'base64').toString())
      if (receipt.phase === 'extracting') { extracting = true; break }
      if (['completed', 'failed', 'cancelled'].includes(receipt.status)) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(extracting, true, 'capture an actual extraction before cancelling')
    const settled = await manager.personalResources({ operation: 'skill_import_cancel', import_id: active.import_id })
    assert.ok(['cancelled', 'completed'].includes(settled.status), JSON.stringify(settled))
    const finalVersion = settled.status === 'completed' ? settled.version : second.version
    console.log(`PASS cancellation during extraction: ${settled.status}; remote process fencing and final receipt confirmed`)
    const resources = await manager.personalResources({ operation: 'list' })
    assert.equal(resources.skills.find(skill => skill.id === 'streamed-package').version, finalVersion)
    await manager.personalResources({ operation: 'skill_uninstall', name: 'streamed-package', version: finalVersion })
    console.log('PASS skill package: one-upload staged imports, 256 MiB assets, atomic replacement, receipts, cancellation and stale-version rejection')
  } else if (phase === 'mixed') {
    const nativeRequire = createRequire('/opt/workbench/profiles/workbench/package.json')
    const { Context } = nativeRequire('@deepseek-ai/cordis')
    const sharp = createRequire(nativeRequire.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
    const ctx = new Context()
    await ctx.plugin(WorkbenchAttachmentStore, { dshHome: directory, imageCompressionConcurrency: 1 })
    const png = await sharp({ create: { width: 48, height: 32, channels: 4, background: '#33669980' } }).png().toBuffer()
    const jpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#336699' } }).jpeg().toBuffer()
    let peakRss = process.memoryUsage().rss
    const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20)
    try {
      await manager.operate({ operation: 'mkdir', path: 'probe/mixed' })
      for (let round = 0; round < 3; round++) {
        const names = ['证据.txt', '照片.png', '说明.pdf', '图像.jpg', 'empty.txt', '图二.png', '数据.bin', '图三.jpg', '记录.csv', '末张.png']
        const originals = names.map((name, i) => name.endsWith('.png') ? png : name.endsWith('.jpg') ? jpeg
          : name === 'empty.txt' ? Buffer.alloc(0) : Buffer.from(`mixed-${round}-${i}-中文证据`))
        const files = await Promise.all(names.map(async (name, i) => {
          const local = join(directory, `mixed-${i}`), bytes = originals[i]
          await writeFile(local, bytes)
          const metadata = { operation: 'upload', path: `probe/mixed/${name}`, version: null, size: bytes.length }
          const uploaded = await manager.upload('files', { path: local, metadata, size: bytes.length, offset: 0 })
          assert.equal(uploaded.version, createHash('sha256').update(bytes).digest('hex'))
          const downloaded = await manager.download(metadata.path), chunks = []
          for await (const chunk of downloaded.body) chunks.push(Buffer.from(chunk))
          assert.deepEqual(Buffer.concat(chunks), bytes)
          return { path: metadata.path, version: uploaded.version }
        }))
        const admitted = await admitSandboxAttachments({ fileManager: manager, workspace: '/workspace', query: '复核附件', files,
          nativeFiles: true, attachmentStore: ctx.attachments })
        assert.equal(admitted.attachments.length, 10)
        assert.equal(admitted.content.filter(item => item.type === 'image').length, 5)
        assert.equal(admitted.content.filter(item => item.type === 'file').length, 5)
        const receipts = await prepareNativeFiles({ uploadStream: async ({ name, data }) => {
          const chunks = []; for await (const chunk of data) chunks.push(Buffer.from(chunk))
          assert.deepEqual(Buffer.concat(chunks), originals[names.indexOf(name)])
          return { receiptId: `receipt-${name}` }
        } }, 'fixture', admitted.content, ctx.attachments)
        assert.equal(receipts.filter(item => item.type === 'file' && item.receiptId).length, 5)
        const archived = await manager.download('probe/mixed'), chunks = []
        for await (const chunk of archived.body) chunks.push(Buffer.from(chunk))
        const zip = Buffer.concat(chunks)
        assert.equal(zip.length, archived.size)
        const end = zip.length - 22
        assert.equal(zip.readUInt32LE(end), 0x06054b50)
        assert.equal(zip.readUInt16LE(end + 10), names.length)
        let offset = zip.readUInt32LE(end + 16)
        for (let i = 0; i < names.length; i++) {
          assert.equal(zip.readUInt32LE(offset), 0x02014b50)
          const nameLength = zip.readUInt16LE(offset + 28), extraLength = zip.readUInt16LE(offset + 30), commentLength = zip.readUInt16LE(offset + 32)
          const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
          const local = zip.readUInt32LE(offset + 42)
          const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
          const bytes = inflateRawSync(zip.subarray(start, start + zip.readUInt32LE(offset + 20)))
          assert.deepEqual(bytes, originals[names.indexOf(name)])
          offset += 46 + nameLength + extraLength + commentLength
        }
        for (const file of files) await manager.operate({ operation: 'delete', ...file })
        console.log(`PASS mixed round ${round + 1}: 10 concurrent uploads, exact downloads, 5 native images + 5 file receipts, ZIP names/content`)
      }
      const folder = await manager.operate({ operation: 'stat', path: 'probe/mixed' })
      await manager.operate({ operation: 'delete', path: 'probe/mixed', version: folder.version })
      console.log(`PASS mixed memory: peak Node RSS ${Math.ceil(peakRss / mib)} MiB in a 512 MiB container`)
    } finally { clearInterval(monitor); await ctx.fiber.dispose() }
  } else if (phase === 'mixed-boundary') {
    const nativeRequire = createRequire('/opt/workbench/profiles/workbench/package.json')
    const { Context } = nativeRequire('@deepseek-ai/cordis')
    const ctx = new Context()
    await ctx.plugin(WorkbenchAttachmentStore, { dshHome: directory, imageCompressionConcurrency: 1 })
    let peakRss = process.memoryUsage().rss
    const monitor = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 20)
    try {
      await manager.operate({ operation: 'mkdir', path: 'probe/boundary' })
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      const sources = []
      for (const [name, size, prefix] of [['file.bin', 100 * mib, Buffer.from('binary')], ['image.png', 20 * mib, png], ['empty.txt', 0, Buffer.alloc(0)]]) {
        const local = join(directory, name), digest = createHash('sha256'), file = await open(local, 'wx')
        try {
          await file.writeFile(prefix); digest.update(prefix)
          const chunk = Buffer.alloc(64 * 1024)
          for (let remaining = size - prefix.length; remaining > 0;) {
            const part = chunk.subarray(0, Math.min(remaining, chunk.length))
            await file.writeFile(part); digest.update(part); remaining -= part.length
          }
        } finally { await file.close() }
        sources.push({ local, name, size, version: digest.digest('hex') })
      }
      const selected = [...Array(4).fill(sources[0]), ...Array(5).fill(sources[1]), sources[2]]
      const files = await Promise.all(selected.map(async (source, index) => {
        const path = `probe/boundary/${index}-${source.name}`
        const metadata = { operation: 'upload', path, size: source.size, version: null }
        const result = await manager.upload('files', { path: source.local, metadata, offset: 0, size: source.size })
        assert.equal(result.version, source.version)
        return { path, version: result.version }
      }))
      const admitted = await admitSandboxAttachments({ fileManager: manager, workspace: '/workspace', query: '边界混合附件', files,
        nativeFiles: true, attachmentStore: ctx.attachments })
      assert.equal(admitted.attachments.length, 10)
      assert.equal(admitted.content.filter(item => item.type === 'image').length, 5)
      const receipts = await prepareNativeFiles({ uploadStream: async ({ name, data }) => {
        const expected = selected[Number(name.split('-')[0])], digest = createHash('sha256')
        let count = 0
        for await (const chunk of data) { count += chunk.length; digest.update(chunk) }
        assert.equal(count, expected.size); assert.equal(digest.digest('hex'), expected.version)
        return { receiptId: `receipt-${name}` }
      } }, 'fixture', admitted.content, ctx.attachments)
      assert.equal(receipts.filter(item => item.type === 'file').length, 5)
      for (const file of files) await manager.operate({ operation: 'delete', ...file })
      const folder = await manager.operate({ operation: 'stat', path: 'probe/boundary' })
      await manager.operate({ operation: 'delete', path: 'probe/boundary', version: folder.version })
      console.log(`PASS mixed boundary: 10 files / 500 MiB, four 100 MiB files + five 20 MiB images + one empty file; streaming receipts exact; peak Node RSS ${Math.ceil(peakRss / mib)} MiB`)
    } finally { clearInterval(monitor); await ctx.fiber.dispose() }
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
