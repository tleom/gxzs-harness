import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Internal Agent operations share the native screen/PTY without replacing its UI attachment. */
export function sidebarTerminalSource(source) {
  // Keep the native Bash activity integration; set only its default visible prompt.
  source = source.replace('env: { DSH_SESSION_ID: agent.id },',
    'env: { DSH_SESSION_ID: agent.id, PROMPT_COMMAND: "PS1=\'\\\\w\\\\$ \'" },')
  // Migrate both the upstream default and earlier GXZS unlimited installations.
  source = source.replace(/maxTerminals: z\.number\(\)\.step\(1\)\.min\([01]\)\.default\((?:0|3|8)\),/,
    'maxTerminals: z.number().step(1).min(1).max(3).default(3),')
    .replace('if ([...this.owners.values()].reduce((count, item) => count + new Set([...item.terminals.keys(), ...item.pending.keys(), ...item.allocations.keys()]).size, 0) >= this.config.maxTerminals)',
      'if (new Set([\n\t\t\t\t...owner.terminals.keys(),\n\t\t\t\t...owner.pending.keys(),\n\t\t\t\t...owner.allocations.keys()\n\t\t\t]).size >= this.config.maxTerminals)')
  const additions = [
    ['\trename(title) {', `\t// GXZS internal Agent input; the controller remains owned by the UI follower.
\twriteFromAgent(data, signal) {
\t\tthis.retention?.invalidate();
\t\treturn this.enqueue(async () => {
\t\t\tsignal.throwIfAborted();
\t\t\tif (this.exited || this.closing !== void 0 || this.info.state !== "running") throw new Error("Terminal is not running");
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
\trename(title) {`],
    ['\t\trename(agent, id, title) {', `\t\t// Internal only: not exposed as a Typert Remote method.
\t\tasync writeFromAgent(agent, id, data, signal) {
\t\t\tsignal.throwIfAborted();
\t\t\tif (Buffer.byteLength(data, "utf8") > this.config.maxInputBytes) throw new Error("Terminal input exceeds the configured limit");
\t\t\tawait this.terminal(agent, id).writeFromAgent(data, signal);
\t\t}
\t\tinspectForAgent(agent, id, signal) {
\t\t\tsignal.throwIfAborted();
\t\t\treturn this.terminal(agent, id).inspectForAgent(signal);
\t\t}
\t\trename(agent, id, title) {`],
  ]
  source = source.replace('if (this.config.maxTerminals > 0 && new Set([', 'if (new Set([')
  if (!source.includes('maxTerminals: z.number().step(1).min(1).max(3).default(3),') ||
      !source.includes('if (new Set([\n\t\t\t\t...owner.terminals.keys(),\n\t\t\t\t...owner.pending.keys(),\n\t\t\t\t...owner.allocations.keys()\n\t\t\t]).size >= this.config.maxTerminals)'))
    throw new Error('DSH terminal contract changed; inspect upstream before upgrading')
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
  if (metadata.version !== '0.2.1-rc.2') throw new Error('Unverified native terminal version')
  const entry = require.resolve('@deepseek-ai/dsh-api-terminal-controller')
  await writeFile(entry, sidebarTerminalSource(await readFile(entry, 'utf8')))
  return dirname(entry)
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await prepareSidebarTerminal(process.argv[2] || fileURLToPath(new URL('../profiles/workbench', import.meta.url)))
