/** Keep all MCP paths inside the platform budget, including clock skew. */
export function mcpDeadline(policy, exec) {
  const budgetMs = Math.ceil((policy?.max_call_seconds ?? 350) * 1000)
  const timeoutMs = Math.max(1, budgetMs - Math.min(5_000, Math.floor(budgetMs / 10)))
  const deadlineMs = Math.min(Number.isSafeInteger(exec.deadlineMs) ? exec.deadlineMs : Infinity, Date.now() + timeoutMs)
  if (deadlineMs <= Date.now()) throw new DOMException('MCP call deadline exceeded', 'TimeoutError')
  return deadlineMs
}
