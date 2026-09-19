import { describe, expect, it } from 'vitest'
import { resolveWorkspacePath } from '../src/paths.js'

describe('workspace path confinement', () => {
  it('resolves relative and absolute paths inside the workspace', () => {
    expect(resolveWorkspacePath('/workspace', 'case/a.txt')).toBe('/workspace/case/a.txt')
    expect(resolveWorkspacePath('/workspace', '/workspace/case/a.txt')).toBe('/workspace/case/a.txt')
  })

  it.each(['../etc/passwd', '/etc/passwd', '/workspace-other/file', 'a/../../../etc'])('rejects escape path %s', (value) => {
    expect(() => resolveWorkspacePath('/workspace', value)).toThrow('文件路径超出工作区')
  })
})
