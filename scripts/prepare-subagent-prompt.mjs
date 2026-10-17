import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const original = `\tsubmitAdmitted(activation, content, options, parent) {
\t\tconst message = options.source === void 0 ? createAgentMessage(parent, content) : createUserMessage({
\t\t\tcontent,
\t\t\tsource: options.source
\t\t});
\t\toptions.signal.throwIfAborted();
\t\tthis.assertAdmitting(parent);
\t\tthis.authorizeLineage(parent, activation.childId, activation.parent.id);
\t\tthis.acquireOwnership(parent, activation.childId);
\t\ttry {`

const prepared = `\tsubmitAdmitted(activation, content, options, parent) {
\t\toptions.signal.throwIfAborted();
\t\tthis.assertAdmitting(parent);
\t\tthis.authorizeLineage(parent, activation.childId, activation.parent.id);
\t\tthis.acquireOwnership(parent, activation.childId);
\t\t// gxzs: retain the native prompt identity across queue consumption and reload.
\t\tif (options.source?.kind === "user" && typeof options.source.rpcId === "string") {
\t\t\tconst agent = requireLocalActivation(activation).handle.agent;
\t\t\tconst matches = (message) => message.source?.kind === "user" && message.source.rpcId === options.source.rpcId;
\t\t\tconst queued = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(matches);
\t\t\tif (queued !== void 0) return queued.id;
\t\t\tconst accepted = agent.session.snapshotEvents().find((event) => event.type === "user/message"
\t\t\t\t&& agent.session.isOwnSeq(event.seq) && matches(event.data));
\t\t\tif (accepted !== void 0) return accepted.data.id;
\t\t}
\t\tconst message = options.source === void 0 ? createAgentMessage(parent, content) : createUserMessage({
\t\t\tcontent,
\t\t\tsource: options.source
\t\t});
\t\ttry {`

const coldOriginal = [
  '\t\t\tthis.assertAdmitting(parent);',
  '\t\t\tthis.authorizeLineage(parent, childId, source.header.parentSession);',
  '\t\t\tconst ownEvents = source.events.slice(source.inheritedEventCount);',
  '\t\t\tconst descriptor = foldSubagentDescriptor(ownEvents);',
  '\t\t\tif (descriptor === void 0 || descriptor.mode !== "continuable") throw new SubagentError(`subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`, "NOT_RESUMABLE");',
  '\t\t\tlet activation;',
].join('\n')
const coldPrepared = coldOriginal.replace('\t\t\tlet activation;', `\t\t\toptions.signal.throwIfAborted();
\t\t\t// Replaying a consumed prompt needs no new child or completion observer.
\t\t\tif (options.source?.kind === "user" && typeof options.source.rpcId === "string") {
\t\t\t\tconst accepted = source.events.slice(source.inheritedEventCount).find((event) => event.type === "user/message"
\t\t\t\t\t&& event.data.source?.kind === "user" && event.data.source.rpcId === options.source.rpcId);
\t\t\t\tif (accepted !== void 0) return accepted.data.id;
\t\t\t}
\t\t\tlet activation;`)

/** Apply the ordinary native prompt replay rule at the child's locked admission cutoff. */
export function subagentPromptIdentity(source) {
  const previous = prepared.replace('agent.session.isOwnSeq(event.seq)', 'event.seq >= agent.session.firstLiveSeq')
  const count = source.split(original).length - 1
  const fixed = source.split(prepared).length - 1
  const previousCount = source.split(previous).length - 1
  if (count + fixed + previousCount !== 1 || !source.includes('async prompt(request, signal)'))
    throw new Error('DSH subagent prompt admission contract changed; inspect upstream before upgrading')
  const hot = count ? source.replace(original, prepared) : previousCount ? source.replace(previous, prepared) : source
  const coldCount = hot.split(coldOriginal).length - 1
  const coldFixed = hot.split(coldPrepared).length - 1
  if (coldCount + coldFixed !== 1) throw new Error('DSH cold subagent prompt admission contract changed; inspect upstream before upgrading')
  return coldCount ? hot.replace(coldOriginal, coldPrepared) : hot
}

export async function prepareSubagentPrompt(profile) {
  const require = createRequire(join(profile, 'package.json'))
  const metadata = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-subagent/package.json'), 'utf8'))
  if (metadata.version !== '0.2.1-alpha.5') throw new Error(`Unverified subagent prompt version: ${metadata.version}`)
  const entry = require.resolve('@deepseek-ai/dsh-subagent')
  const source = await readFile(entry, 'utf8')
  const result = subagentPromptIdentity(source)
  if (result !== source) await writeFile(entry, result)
}
