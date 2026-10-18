import path from 'node:path'

export function containsWorkspacePath(directory, candidate) {
  const relative = path.posix.relative(directory, candidate)
  return relative === '' || relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative)
}

export function resolveWorkspacePath(workspace, candidate) {
  if (!path.posix.isAbsolute(workspace))
    throw new TypeError('workspace must be an absolute POSIX path')
  if (typeof candidate !== 'string' || candidate.includes('\0'))
    throw Object.assign(new Error('文件路径无效'), { status: 400 })

  const root = path.posix.normalize(workspace)
  const resolved = path.posix.resolve(root, candidate || '.')
  if (resolved !== root && !resolved.startsWith(`${root}/`))
    throw Object.assign(new Error('文件路径超出工作区'), { status: 403 })
  return resolved
}
