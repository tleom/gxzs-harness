import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Internal Agent operations share the native screen/PTY without replacing its UI attachment. */
export function sidebarTerminalSource(source) {
  const additions = [
    ['maxTerminals: z.number().step(1).min(1).default(8),', 'maxTerminals: z.number().step(1).min(1).default(3),'],
    ['if (new Set([\n\t\t\t\t...owner.terminals.keys(),\n\t\t\t\t...owner.pending.keys(),\n\t\t\t\t...owner.allocations.keys()\n\t\t\t]).size >= this.config.maxTerminals)',
      'if ([...this.owners.values()].reduce((count, item) => count + new Set([...item.terminals.keys(), ...item.pending.keys(), ...item.allocations.keys()]).size, 0) >= this.config.maxTerminals)'],
    ['\twrite(id, data) {', `\t// GXZS internal Agent input; the controller remains owned by the UI follower.
\twriteFromAgent(data, signal) {
\t\tthis.retention?.invalidate();
\t\treturn this.enqueue(async () => {
\t\t\tsignal.throwIfAborted();
\t\t\tif (this.closing !== void 0 || this.info.state !== "running") throw new Error("Terminal is not running");
\t\t\tawait this.handle.write(data);
\t\t});
\t}
\tinspectForAgent(signal) {
\t\treturn this.enqueue(() => {
\t\t\tsignal.throwIfAborted();
\t\t\tconst buffer = this.screen.buffer.active;
\t\t\tconst start = Math.max(0, buffer.length - 80);
\t\t\tconst lines = [];
\t\t\tfor (let i = start; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
\t\t\tconst text = lines.join("\\n").trimEnd();
\t\t\treturn { info: this.info, screen: text.slice(-24576), truncated: start > 0 || text.length > 24576 };
\t\t});
\t}
\twrite(id, data) {`],
    ['\t\tasync write(agent, id, attachmentId, data) {', `\t\t// Internal only: not exposed as a Typert Remote method.
\t\tasync writeFromAgent(agent, id, data, signal) {
\t\t\tsignal.throwIfAborted();
\t\t\tif (Buffer.byteLength(data, "utf8") > this.config.maxInputBytes) throw new Error("Terminal input exceeds the configured limit");
\t\t\tawait this.terminal(agent, id).writeFromAgent(data, signal);
\t\t}
\t\tinspectForAgent(agent, id, signal) {
\t\t\tsignal.throwIfAborted();
\t\t\treturn this.terminal(agent, id).inspectForAgent(signal);
\t\t}
\t\tasync write(agent, id, attachmentId, data) {`],
  ]
  for (const [before, after] of additions) {
    if (source.includes(after)) continue
    if (source.split(before).length !== 2) throw new Error('DSH terminal contract changed; inspect upstream before upgrading')
    source = source.replace(before, after)
  }
  return source
}

export async function prepareSidebarTerminal(profile) {
  const require = createRequire(join(profile, 'package.json'))
  const manifest = require.resolve('@deepseek-ai/dsh-api-terminal-controller/package.json')
  const metadata = JSON.parse(await readFile(manifest, 'utf8'))
  if (metadata.version !== '0.2.1-alpha.2') throw new Error('Unverified native terminal version')
  const entry = require.resolve('@deepseek-ai/dsh-api-terminal-controller')
  await writeFile(entry, sidebarTerminalSource(await readFile(entry, 'utf8')))
  return dirname(entry)
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await prepareSidebarTerminal(process.argv[2] || fileURLToPath(new URL('../profiles/workbench', import.meta.url)))
