// Backport the folded-reply field from DSH 0.2.2 to the pinned Host schema.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../profiles/workbench/node_modules/@deepseek-ai/dsh-client-ui-chat')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (manifest.version !== '0.2.1-rc.2') throw new Error('Review the folded replies backport for the new DSH version')

const file = resolve(root, 'lib/index.js')
const source = await readFile(file, 'utf8')
const anchor = 'collapseTiming: ChatSettingsFields.collapseTiming.volatile(),'
const field = 'foldedReplies: z.union(["all", "final"]).default("final").volatile(),'
if (!source.includes(field)) {
  if (source.split(anchor).length !== 2) throw new Error('DSH chat settings schema anchor changed')
  const staging = file + '.gxzs-chat-settings'
  await writeFile(staging, source.replace(anchor, `${anchor}\n\t${field}`))
  await rename(staging, file)
}
