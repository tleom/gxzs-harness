import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeSettingsControllers } from './native-settings-controllers.mjs'

/** Build the carrier's pure display adapter using the standard native registration format. */
export async function prepareWorkbenchClient(profile) {
  const require = createRequire(join(resolve(profile), 'package.json'))
  const directory = dirname(require.resolve('@gxzs/dsh-workbench-adapter'))
  const { build } = require('esbuild')
  const result = await build({ stdin: { contents: `export * from './client/index.js';\n${await nativeSettingsControllers(profile)}`, resolveDir: directory, sourcefile: 'workbench-client.js' },
    external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store'], bundle: true, format: 'cjs',
    platform: 'browser', target: 'es2022', write: false, legalComments: 'none' })
  const output = join(directory, '../lib/client.js')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `window.__ModuleLoader__.load({id:"@gxzs/dsh-workbench-adapter",factory(require){\nconst module={exports:{}};const exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;\n}});\n`, 'utf8')
  return output
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await prepareWorkbenchClient(process.argv[2] || fileURLToPath(new URL('../profiles/workbench/', import.meta.url))))
}
