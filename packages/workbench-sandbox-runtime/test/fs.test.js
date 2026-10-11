import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import WorkbenchFileSystem from '../src/fs.js'

const contexts = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const hostRoot = path.resolve('owner-home/attachments')
const sandboxRoot = '/srv/dsh/attachments'
function filesystem(config = { attachmentHostRoot: hostRoot }) {
  const ctx = new Context()
  contexts.push(ctx)
  return new WorkbenchFileSystem(ctx, config)
}

it('maps verbatim files and normalized images through the shared owner attachment directory', () => {
  const fs = filesystem()
  for (const parts of [
    ['v1', 'files', 'ab', 'a'.repeat(64), "资料 '副本' (2026).zip"],
    ['v1', 'objects', 'ab', 'a'.repeat(64)],
  ]) expect(fs.processPathFromHostPath(path.join(hostRoot, ...parts))).toBe(`${sandboxRoot}/${parts.join('/')}`)
})

it('exposes no host path when the deployment has not declared an attachment mount', () => {
  expect(filesystem({}).processPathFromHostPath(path.join(hostRoot, 'v1', 'file.txt'))).toBeUndefined()
})

it('keeps host control-plane files, siblings, relative paths and traversal outside the mapping', () => {
  const fs = filesystem()
  for (const value of [
    hostRoot, path.dirname(hostRoot), path.join(path.dirname(hostRoot), 'workbench.sqlite3'),
    path.join(path.dirname(hostRoot), '.credentials.yaml'), path.join(`${hostRoot}-other`, 'file.txt'),
    `v1${path.sep}file.txt`, `${hostRoot}${path.sep}..${path.sep}settings.yaml`,
    `${hostRoot}${path.sep}v1${path.sep}.${path.sep}file.txt`, `${hostRoot}${path.sep}bad\nfile.txt`,
    `${hostRoot}${path.sep}bad\0file.txt`, undefined,
  ]) expect(fs.processPathFromHostPath(value)).toBeUndefined()
})

it('rejects invalid mount roots instead of advertising a broad host mapping', () => {
  for (const attachmentHostRoot of ['relative', path.parse(hostRoot).root, `${hostRoot}\n`])
    expect(() => filesystem({ attachmentHostRoot })).toThrow('host root')
  for (const attachmentSandboxRoot of ['relative', '/', '/srv/dsh/../private', '/srv/dsh/attachments\0'])
    expect(() => filesystem({ attachmentHostRoot: hostRoot, attachmentSandboxRoot })).toThrow('sandbox root')
})
