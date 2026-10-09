import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { officePreset, assistantIdentity } from '../../../profiles/workbench/preset-policy.mjs'

describe('office preset policy', () => {
  it('removes the web plugin without removing adjacent tools or their configuration', () => {
    const source = '- id: read\n  config:\n    enabled: true\n\n- id: tool-web\n  name: web\n  config:\n    fetch: true\n\n- id: present\n  name: present\n'
    expect(officePreset(source)).toBe('- id: read\n  config:\n    enabled: true\n\n- id: present\n  name: present\n')
    expect(officePreset('- id: tool-web\r\n  name: web')).toBe('')
  })
  it('replaces all shipped persona variants while retaining model interpolation', () => {
    expect(officePreset('You are a coding agent powered by the {{model}} model.')).toContain('信·法智办案助手，一个办公 Agent，使用 {{model}} 模型')
    expect(officePreset('You are a coding agent powered by the {{model}} model, running on the DeepSeek Harness.')).not.toContain('DeepSeek Harness')
    expect(officePreset('You are a helpful software engineer assistant.')).toContain(assistantIdentity)
  })
  it('keeps user presets enabled and suppresses the built-in harness identity', () => {
    const patch = readFileSync(new URL('../../../profiles/workbench/cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('includeHarnessIdentity: false')
    expect(patch).toContain('id: agent-preset-registry')
    expect(patch).not.toContain('includeUserRoot: true')
  })
})
