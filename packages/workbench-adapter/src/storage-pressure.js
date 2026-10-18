import { statfsSync } from 'node:fs'

export function storageStatus(paths, { stat = statfsSync,
  minBytes = Number(process.env.GXZS_STORAGE_MIN_FREE_BYTES ?? 268435456),
  minInodes = Number(process.env.GXZS_STORAGE_MIN_FREE_INODES ?? 1024) } = {}) {
  if (![minBytes, minInodes].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Storage watermarks must be non-negative integers')
  const filesystems = []
  for (const [name, path] of Object.entries(paths)) {
    // Only an intentionally omitted path (for example an in-memory database)
    // is optional. A configured path that disappears or becomes inaccessible
    // must fail admission, including existsSync's otherwise silent EACCES case.
    if (!path) { filesystems.push({ name, status: 'unmounted' }); continue }
    try {
      const info = stat(path)
      const freeBytes = Number(info.bavail) * Number(info.bsize)
      const freeInodes = Number(info.ffree)
      const blocked = freeBytes < minBytes || Number(info.files) > 0 && freeInodes < minInodes
      filesystems.push({ name, status: blocked ? 'pressure' : 'ready', free_bytes: freeBytes,
        ...(Number(info.files) > 0 ? { free_inodes: freeInodes } : {}) })
    } catch { filesystems.push({ name, status: 'unknown' }) }
  }
  return { blocked: filesystems.some(item => ['pressure', 'unknown'].includes(item.status)),
    min_free_bytes: minBytes, min_free_inodes: minInodes, filesystems }
}

export function assertStorageWritable(status) {
  if (status.blocked) throw Object.assign(new Error('工作环境存储空间不足或暂不可用，请整理后重试'),
    { status: 503, code: 'STORAGE_PRESSURE', retry_after: 5 })
}
