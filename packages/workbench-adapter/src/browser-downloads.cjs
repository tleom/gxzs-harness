const { mkdir, mkdtemp, realpath, stat, unlink, rmdir } = require('node:fs/promises')
const { join, relative, resolve, sep } = require('node:path')

function downloadName(value) {
  let name = String(value || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/g, '')
  if (!name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `download${name ? '-' + name : ''}`
  // Leave room for the filesystem's byte limit even for multibyte names.
  let result = '', bytes = 0
  for (const character of name) {
    bytes += Buffer.byteLength(character)
    if (bytes > 200) break
    result += character
  }
  return result
}

/** Browser-owned temporary downloads become ordinary workspace files only when complete. */
function createBrowserDownloads({ workspace, report }) {
  const pending = new Map()
  let closed = false
  async function save(download) {
    let directory, destination, saved = false
    const name = downloadName(download.suggestedFilename())
    try {
      report({ notice: `正在下载：${name}` })
      // Wait without buffering the file in Node or reserving an incomplete workspace file.
      await download.path()
      if (closed) return
      const root = await realpath(workspace)
      const base = join(root, 'downloads')
      await mkdir(base, { recursive: true })
      const actual = await realpath(base)
      if (actual !== resolve(base)) throw new Error('download_directory_changed')
      directory = await mkdtemp(join(actual, 'download-'))
      destination = join(directory, name)
      await download.saveAs(destination)
      const { size } = await stat(destination)
      saved = true
      if (!closed) report({ notice: '', download: {
        name, path: relative(root, destination).split(sep).join('/'), size,
      } })
    } catch {
      if (!closed) report({ notice: `下载失败：${name}` })
    } finally {
      if (!saved && directory) {
        if (destination) await unlink(destination).catch(() => {})
        await rmdir(directory).catch(() => {})
      }
      // Release the browser's temporary copy as soon as the workspace copy is safe.
      await download.delete().catch(() => {})
    }
  }
  return {
    start(download) {
      if (closed) return download.cancel().catch(() => {})
      const task = save(download).finally(() => pending.delete(download))
      pending.set(download, task)
      return task
    },
    async close() {
      closed = true
      const active = [...pending]
      await Promise.allSettled(active.map(([download]) => download.cancel()))
      await Promise.allSettled(active.map(([, task]) => task))
    },
  }
}

module.exports = { createBrowserDownloads, downloadName }
