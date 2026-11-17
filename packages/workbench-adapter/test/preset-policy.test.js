import { describe, expect, it } from 'vitest'
import { officePreset } from '../../../profiles/workbench/preset-policy.mjs'

describe('office preset policy', () => {
  it('removes the web plugin without removing adjacent tools or their configuration', () => {
    const source = '- id: read\n  config:\n    enabled: true\n\n- id: tool-web\n  name: web\n  config:\n    fetch: true\n\n- id: present\n  name: present\n'
    expect(officePreset(source)).toBe('- id: read\n  config:\n    enabled: true\n\n- id: present\n  name: present\n')
    expect(officePreset('- id: tool-web\r\n  name: web')).toBe('')
  })
})
