/** Recognize provider facts, never infer content rejection from arbitrary prose. */
export function runFailure(value) {
  if (!value) return undefined
  const message = typeof value === 'string' ? value : value.message ?? String(value)
  let code = typeof value === 'object' ? value.code : undefined
  let providerMessage = message
  const jsonStart = message.indexOf('{')
  if (jsonStart >= 0 && message.length <= 100_000) {
    try {
      const payload = JSON.parse(message.slice(jsonStart))
      if (payload.error && typeof payload.error === 'object') {
        code = payload.error.code ?? payload.error.type ?? code
        providerMessage = payload.error.message ?? message
      }
    } catch { /* Keep the native error intact when it is not a provider payload. */ }
  }
  if (code === 'data_inspection_failed') {
    const output = /^(?:Output text|模型服务拒绝了本次输出)/i.test(providerMessage)
    return { code, message: output
      ? '模型服务拒绝了本次输出（data_inspection_failed）。本轮已停止；请核实资料和请求，必要时联系模型服务商复核。'
      : '模型服务拒绝了当前输入（data_inspection_failed）。继续会保留相同上下文，可能再次失败。请核实资料，必要时联系模型服务商复核；也可选择其他可用模型后恢复目标。' }
  }
  return { code, message }
}

export function presentRunEvent(event) {
  if (!['workbench_end', 'error'].includes(event.event) || !event.error) return event
  const failure = runFailure({ message: event.error, code: event.error_code })
  return { ...event, error: failure.message, ...(failure.code ? { error_code: failure.code } : {}) }
}

export function goalFailureReason(goal, run) {
  if (goal?.blockedReason?.message) return goal.blockedReason.message
  if (goal?.phase === 'active' && goal.activation === 'disarmed' && run?.status === 'failed' && run.error) return runFailure({ message: run.error, code: run.errorCode })?.message ?? null
  return null
}

export function resumeGoalSelection(previous, current) {
  return { ...(previous ?? current),
    ...(current?.model ? { model: current.model, model_parameters: current.model_parameters ?? {} } : {}), command: 'goal' }
}
