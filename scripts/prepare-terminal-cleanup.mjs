import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stop a verified Linux shell from spawning replacements during descendant cleanup. */
export function terminalCleanupSource(source) {
  const start = '\t\tlet survivors = await this.stopDescendants();'
  const end = '\n\t}\n\tcleanupManagedOwner(owner) {'
  const marker = '// GXZS: freeze the identity-checked shell while draining its children.'
  if (source.includes(marker)) return source
  if (source.split(start).length !== 2 || source.split(end).length !== 2)
    throw new Error('Native terminal cleanup contract changed; review upstream before patching')
  const begin = source.indexOf(start), finish = source.indexOf(end, begin)
  if (finish < begin) throw new Error('Native terminal cleanup boundaries changed')
  const original = source.slice(begin, finish)
  const replacement = `\t\t${marker}
\t\tlet shellFrozen = false;
\t\ttry {
\t\t\tif (this.platform === "linux" && this.rootIdentity !== void 0 && this.inspector.isAlive(this.rootIdentity)) {
\t\t\t\ttry {
\t\t\t\t\tthis.inspector.signalProcess(this.rootIdentity, "SIGSTOP");
\t\t\t\t\tshellFrozen = true;
\t\t\t\t} catch (error) { if (error?.code !== "ESRCH") throw error; }
\t\t\t}
${original.split('\n').map(line => '\t' + line).join('\n')}
\t\t} finally {
\t\t\t// A failed cleanup must remain retryable, not leave the user's shell suspended.
\t\t\tif (shellFrozen) {
\t\t\t\ttry { this.inspector.signalProcess(this.rootIdentity, "SIGCONT"); }
\t\t\t\tcatch (error) { if (error?.code !== "ESRCH") throw error; }
\t\t\t}
\t\t}`
  return source.slice(0, begin) + replacement + source.slice(finish)
}

/** A confirmed remote termination may close the output before its EOF arrives. */
export function terminalOutputCloseSource(source) {
  const additions = [
    ['\t\tterminal.output.once("error", this.onTerminalError);',
      '\t\tterminal.output.once("error", this.onTerminalError);\n\t\tterminal.output.once("close", this.onTerminalClose);'],
    ['\tonTerminalError = (error) => {', `\t// GXZS: settle close-only output while completion still waits for process.done.
\tonTerminalClose = () => {
\t\tif (!this.terminal.output.readableEnded && !this.terminal.output.errored) this.onTerminalEnd();
\t};
\tonTerminalError = (error) => {`],
    ['\t\tthis.terminal.output.off("error", this.onTerminalError);',
      '\t\tthis.terminal.output.off("error", this.onTerminalError);\n\t\tthis.terminal.output.off("close", this.onTerminalClose);'],
  ]
  for (const [before, after] of additions) {
    if (source.includes(after)) continue
    if (source.split(before).length !== 2)
      throw new Error('Native terminal output contract changed; review upstream before patching')
    source = source.replace(before, after)
  }
  return source
}

export async function prepareTerminalCleanup(profile) {
  const require = createRequire(join(profile, 'package.json'))
  for (const [name, patch] of [
    ['@deepseek-ai/dsh-subprocess-local', terminalCleanupSource],
    ['@deepseek-ai/dsh-terminal-bash', terminalOutputCloseSource],
  ]) {
    const metadata = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'))
    if (metadata.version !== '0.2.2-rc.1') throw new Error('Unverified native terminal cleanup version')
    const entry = require.resolve(name)
    await writeFile(entry, patch(await readFile(entry, 'utf8')))
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await prepareTerminalCleanup(process.argv[2] || fileURLToPath(new URL('../profiles/workbench', import.meta.url)))
