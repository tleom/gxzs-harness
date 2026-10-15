import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { httpError } from './http.js'

// Background Continue is model-visible control, not a human prompt for titles.
export function runPromptId(message) {
  const source = message?.source
  return ['user', 'workbench-resume'].includes(source?.kind) && typeof source.rpcId === 'string'
    ? source.rpcId : undefined
}

export async function dispatchRunPrompt({ sessions, agents, database }, run, content) {
  if (!run.selection?.silent_resume)
    return sessions.prompt({ requestId: run.id, sessionId: run.sessionId, mode: run.selection?.prompt_mode ?? 'queue', content }, new AbortController().signal)
  const agent = agents.get(run.sessionId)
  if (!agent) throw httpError(409, '会话暂时无法恢复')
  if (database.getRun(run.ownerId, run.id)?.messageId) return { accepted: true }
  agent.followup(createUserMessage({ content, source: { kind: 'workbench-resume', rpcId: run.id } }))
  return { accepted: true }
}
