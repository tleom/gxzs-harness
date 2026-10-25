const { constants } = require('node:fs')
const { copyFile, mkdir, realpath, stat } = require('node:fs/promises')
const { extname, join, relative, resolve, sep } = require('node:path')

function downloadName(value) {
  let name = String(value || '').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/g, '')
  if (!name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `download${name ? '-' + name : ''}`
  // Leave room for the filesystem's byte limit even for multibyte names.
  const extension = Buffer.byteLength(extname(name)) <= 40 ? extname(name) : ''
  const stem = extension ? name.slice(0, -extension.length) : name
  let result = '', bytes = Buffer.byteLength(extension)
  for (const character of stem) {
    bytes += Buffer.byteLength(character)
    if (bytes > 200) break
    result += character
  }
  return result + extension
}

/** Browser-owned temporary downloads become ordinary workspace files only when complete. */
function createBrowserDownloads({ workspace, directory = workspace, report }) {
  const pending = new Map()
  let closed = false
  async function save(download) {
    const name = downloadName(download.suggestedFilename())
    try {
      report({ notice: `正在下载：${name}` })
      // Wait without buffering the file in Node or reserving an incomplete workspace file.
      const source = await download.path()
      if (closed) return
      const root = await realpath(workspace)
      const cwd = await realpath(directory)
      if (cwd !== root && !cwd.startsWith(root + sep)) throw new Error('download_directory_outside_workspace')
      const base = join(cwd, 'Download')
      await mkdir(base, { recursive: true })
      const actual = await realpath(base)
      if (actual !== resolve(base)) throw new Error('download_directory_changed')
      const extension = extname(name), stem = name.slice(0, name.length - extension.length)
      let destination
      for (let index = 0; ; index++) {
        destination = join(actual, index === 0 ? name : `${stem} (${index})${extension}`)
        try {
          // EXCL reserves the filename across concurrent downloads without overwriting a file or link.
          await copyFile(source, destination, constants.COPYFILE_EXCL)
          break
        } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      const { size } = await stat(destination)
      if (!closed) report({ notice: '', download: {
        name: destination.slice(actual.length + 1), path: relative(root, destination).split(sep).join('/'), size,
      } })
    } catch {
      if (!closed) report({ notice: `下载失败：${name}` })
    } finally {
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
