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

const previousPrepared = `\tsubmitAdmitted(activation, content, options, parent) {
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

const previousAccepted = `\t\t\tconst accepted = agent.session.snapshotEvents().find((event) => event.type === "user/message"
\t\t\t\t&& agent.session.isOwnSeq(event.seq) && matches(event.data));
\t\t\tif (accepted !== void 0) return accepted.data.id;`
const prepared = previousPrepared.replace(previousAccepted, `\t\t\t// Claim removes pending input before prompt preparation and task admission.
\t\t\t// Its durable insertion remains the receipt, even after cancellation.
\t\t\tfor (const event of agent.session.snapshotEvents()) {
\t\t\t\tif (!agent.session.isOwnSeq(event.seq)) continue;
\t\t\t\tconst messages = event.type === "user/message" ? [event.data]
\t\t\t\t\t: event.type === "agent/inbox/spliced" ? event.data.inserted : [];
\t\t\t\tconst accepted = messages.find(matches);
\t\t\t\tif (accepted !== void 0) return accepted.id;
\t\t\t}`)

const coldOriginal = [
  '\t\t\tthis.assertAdmitting(parent);',
  '\t\t\tthis.authorizeLineage(parent, childId, source.header.parentSession);',
  '\t\t\tconst ownEvents = source.events.slice(source.inheritedEventCount);',
  '\t\t\tconst descriptor = foldSubagentDescriptor(ownEvents);',
  '\t\t\tif (descriptor === void 0 || descriptor.mode !== "continuable") throw new SubagentError(`subagent "${childId}" has no supported continuation state and cannot be resumed; choose a different target`, "NOT_RESUMABLE");',
  '\t\t\tlet activation;',
].join('\n')
const previousColdPrepared = coldOriginal.replace('\t\t\tlet activation;', `\t\t\toptions.signal.throwIfAborted();
\t\t\t// Replaying a consumed prompt needs no new child or completion observer.
\t\t\tif (options.source?.kind === "user" && typeof options.source.rpcId === "string") {
\t\t\t\tconst accepted = source.events.slice(source.inheritedEventCount).find((event) => event.type === "user/message"
\t\t\t\t\t&& event.data.source?.kind === "user" && event.data.source.rpcId === options.source.rpcId);
\t\t\t\tif (accepted !== void 0) return accepted.data.id;
\t\t\t}
\t\t\tlet activation;`)
const coldPrepared = previousColdPrepared.replace(`\t\t\t\tconst accepted = source.events.slice(source.inheritedEventCount).find((event) => event.type === "user/message"
\t\t\t\t\t&& event.data.source?.kind === "user" && event.data.source.rpcId === options.source.rpcId);
\t\t\t\tif (accepted !== void 0) return accepted.data.id;`, `\t\t\t\tconst inbox = source.projections?.values.inbox;
\t\t\t\tif (inbox === void 0) throw new SubagentError("subagent prompt replay requires the registered inbox projection", "SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE");
\t\t\t\tconst pending = [...inbox["next-turn"], ...inbox["next-step"]]
\t\t\t\t\t.some((message) => message.source?.kind === "user" && message.source.rpcId === options.source.rpcId);
\t\t\t\tfor (const event of ownEvents) {
\t\t\t\t\tconst messages = event.type === "user/message" ? [event.data]
\t\t\t\t\t\t: event.type === "agent/inbox/spliced" ? event.data.inserted : [];
\t\t\t\t\tconst accepted = messages.find((message) => message.source?.kind === "user"
\t\t\t\t\t\t&& message.source.rpcId === options.source.rpcId);
\t\t\t\t\tif (accepted !== void 0 && !pending) return accepted.id;
\t\t\t\t}`)
const coldTail = '\t\t\treturn await this.submitMaterialized(activation, content, options, parent);\n\t\t} catch (e_1) {'
const preparedColdTail = `\t\t\tconst messageId = await this.submitMaterialized(activation, content, options, parent);
\t\t\t// A cold replay can reuse durable pending input without inserting it again.
\t\t\trequireLocalActivation(activation).handle.agent.resumePending();
\t\t\treturn messageId;
\t\t} catch (e_1) {`

/** Apply the ordinary native prompt replay rule at the child's locked admission cutoff. */
export function subagentPromptIdentity(source) {
  const versions = [original, previousPrepared,
    previousPrepared.replace('agent.session.isOwnSeq(event.seq)', 'event.seq >= agent.session.firstLiveSeq'), prepared]
  const matches = versions.filter(version => source.includes(version))
  if (matches.length !== 1 || source.split(matches[0]).length !== 2 || !source.includes('async prompt(request, signal)'))
    throw new Error('DSH subagent prompt admission contract changed; inspect upstream before upgrading')
  const hot = source.replace(matches[0], prepared)
  const coldMatches = [coldOriginal, previousColdPrepared, coldPrepared].filter(version => hot.includes(version))
  if (coldMatches.length !== 1 || hot.split(coldMatches[0]).length !== 2)
    throw new Error('DSH cold subagent prompt admission contract changed; inspect upstream before upgrading')
  const cold = hot.replace(coldMatches[0], coldPrepared)
  const tails = [coldTail, preparedColdTail].filter(version => cold.includes(version))
  if (tails.length !== 1 || cold.split(tails[0]).length !== 2)
    throw new Error('DSH cold subagent wake contract changed; inspect upstream before upgrading')
  return cold.replace(tails[0], preparedColdTail)
}

export async function prepareSubagentPrompt(profile) {
  const require = createRequire(join(profile, 'package.json'))
  const metadata = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-subagent/package.json'), 'utf8'))
  if (metadata.version !== '0.2.1-rc.2') throw new Error(`Unverified subagent prompt version: ${metadata.version}`)
  const entry = require.resolve('@deepseek-ai/dsh-subagent')
  const source = await readFile(entry, 'utf8')
  const result = subagentPromptIdentity(source)
  if (result !== source) await writeFile(entry, result)
}
