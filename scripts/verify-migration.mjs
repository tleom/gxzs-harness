import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [bundlePath, reportPath] = process.argv.slice(2)
if (!bundlePath || !reportPath) throw new Error('usage: node verify-migration.mjs <bundle.json> <import-report.json>')
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))
const wrapper = JSON.parse(readFileSync(reportPath, 'utf8'))
const report = wrapper.data ?? wrapper
const digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex')
const expected = {
  source_id: bundle.source_id,
  owner_id: bundle.owner_id,
  digest,
  workspace: {
    id: bundle.workspace.id, tree_version: bundle.workspace.tree_version,
    files: bundle.workspace.files, bytes: bundle.workspace.bytes,
  },
  chats: bundle.chats.length,
  runs: bundle.chats.reduce((total, chat) => total + chat.runs.length, 0),
  events: bundle.chats.reduce((total, chat) => total + chat.runs.reduce((count, run) => count + run.events.length, 0), 0),
}
const actual = {
  source_id: report.source_id,
  owner_id: report.owner_id,
  digest: report.digest,
  workspace: report.workspace,
  chats: report.chats?.length ?? -1,
  runs: report.chats?.reduce((total, chat) => total + chat.runs, 0) ?? -1,
  events: report.chats?.reduce((total, chat) => total + chat.events, 0) ?? -1,
}
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error(JSON.stringify({ ok: false, expected, actual }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, ...actual }))
