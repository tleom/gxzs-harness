import { configDefaults, defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'

// Exercise the same patched, pinned package graph installed in the Host image.
const native = createRequire(new URL('./profiles/workbench/package.json', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^@deepseek-ai\//, replacement: '@deepseek-ai/', customResolver: source => native.resolve(source) }],
  },
  test: {
    exclude: [...configDefaults.exclude, '**/.tmp/**'],
  },
})
