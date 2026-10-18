import { expect, it } from 'vitest'
import { storageStatus, assertStorageWritable } from '../src/storage-pressure.js'

it('blocks low bytes and inodes, exposes unknown volumes and resumes after space is freed', () => {
  const paths = { home: '/home', workspace: '/workspace' }
  let info = { bavail: 300, bsize: 1, files: 1000, ffree: 50 }
  const options = { stat: () => info, minBytes: 256, minInodes: 10 }
  expect(storageStatus(paths, options).blocked).toBe(false)
  for (const change of [{ bavail: 255 }, { bavail: 300, ffree: 9 }]) {
    info = { ...info, ...change }
    expect(() => assertStorageWritable(storageStatus(paths, options))).toThrow('存储')
  }
  info = { ...info, ffree: 20 }
  expect(() => assertStorageWritable(storageStatus(paths, options))).not.toThrow()
  expect(storageStatus(paths, { ...options, stat: () => { throw new Error('unavailable') } }).blocked).toBe(true)
  expect(storageStatus({ home: undefined }, options)).toMatchObject({ blocked: false, filesystems: [{ status: 'unmounted' }] })
})

it('fails closed when a configured path is missing or inaccessible', () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const result = storageStatus({ workspace: '/configured' }, {
      stat: () => { throw Object.assign(new Error('unavailable'), { code }) },
    })
    expect(result).toMatchObject({ blocked: true, filesystems: [{ name: 'workspace', status: 'unknown' }] })
    expect(() => assertStorageWritable(result)).toThrow('存储')
  }
})
