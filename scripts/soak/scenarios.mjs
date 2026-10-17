/** Deterministic native-tool plans. Tool results, not generated prose, are the evidence. */
const call = (name, args, expected) => ({ name, arguments: args, expected })
const shell = js => `node -e '${js.replaceAll("'", "'\\''")}'`
export function ledger(scenario, step) {
  const marker = `GXZS_SIM_STEP ${scenario.id} ${step}`
  const value = JSON.stringify({ case: scenario.id, step, marker: 'GXZS_SIM_LEDGER' }) + '\n'
  return call('bash', { description: `记录模拟验收步骤 ${step}`, command: shell(`require('node:fs').appendFileSync('sim-${scenario.id}.jsonl',${JSON.stringify(value)});console.log(${JSON.stringify(marker)})`) }, marker)
}
export function mixedStep(scenario, step, state) {
  const cycle = Math.floor(step / 40), phase = step % 40, id = scenario.id
  const file = `sim-${id}.txt`, marker = `GXZS_SIM_CONTENT ${id} ${cycle}`
  const child = JSON.stringify({ id: `${id}_child${cycle}`, rounds: 3, stepDelayMs: 100 })
  switch (phase) {
    case 0: return ledger(scenario, step)
    case 1: return call('write', { file_path: file, content: marker + '\n' + '合成测试文本 ABC 😀\n'.repeat(scenario.largeArguments ? 50000 : 40) })
    case 2: return call('read', { file_path: file, limit: 3 }, marker)
    case 3: return call('edit', { file_path: file, old_string: marker, new_string: marker + ' EDITED' })
    case 4: return call('grep', { pattern: 'EDITED', path: file }, 'EDITED')
    case 5: return call('glob', { pattern: file }, file)
    case 6: return call('mcp', {}, 'soak-fixture')
    case 7: return call('mcp', { name: 'soak-fixture' }, 'fixture_echo')
    case 8: return call('mcp', { name: 'soak-fixture', tools: ['fixture_echo'] }, 'fixture_echo')
    case 9: return call('fixture_echo', { value: marker }, 'GXZS_SIM_MCP_OK')
    case 10: return call('tool_search', { query: 'fixture_echo', name: 'soak-fixture' }, 'fixture_echo')
    case 11: return call('bash', { description: '启动真实后台任务', command: shell(`setTimeout(()=>console.log('GXZS_SIM_BACKGROUND_OK'),3000)`), run_in_background: true })
    case 12: return call('job_list', {})
    case 13: return call('job_output', { job_id: state.jobId, wait: true, timeout_ms: 10000 }, 'GXZS_SIM_BACKGROUND_OK')
    case 14: return call('schedule_create', { title: '合成提醒验收', prompt: 'GXZS_SIM_SCHEDULE_UNUSED', after_seconds: 3600 })
    case 15: return call('schedule_list', {}, state.scheduleId)
    case 16: return call('schedule_update', { id: state.scheduleId, title: '合成提醒更新验收' })
    case 17: return call('schedule_delete', { id: state.scheduleId })
    case 18: return call('skill', { name: 'soak-skill' }, 'GXZS_SIM_SKILL_OK')
    case 19: return scenario.browser ? call('browser', { action: 'navigate', url: `${state.fixtureURL}/fixture/page?case=${id}&cycle=${cycle}` }, '合成计数') : ledger(scenario, step)
    case 20: return scenario.browser ? call('browser', { action: 'click', role: 'button', name: '增加计数' }, '合成计数：1') : ledger(scenario, step)
    case 21: return scenario.browser ? call('browser', { action: 'snapshot' }, '合成计数：1') : ledger(scenario, step)
    case 22: return call('terminal', { action: 'open' })
    case 23: return call('terminal', { action: 'write', data: `printf 'GXZS_SIM_TERMINAL_OK\\n'\n`, wait_ms: 500 }, 'GXZS_SIM_TERMINAL_OK')
    case 24: return call('terminal', { action: 'read', wait_ms: 100 }, 'GXZS_SIM_TERMINAL_OK')
    case 25: return call('terminal', { action: 'close' })
    case 26: return call('subagent', { description: '模拟子任务验收', prompt: `GXZS_SIM_CASE ${child}` })
    case 27: return call('list_agents', {})
    case 28: return call('bash', { description: '启动待取消后台任务', command: shell('setInterval(()=>console.log("GXZS_SIM_CANCEL_PENDING"),1000)'), run_in_background: true })
    case 29: return call('job_kill', { job_id: state.jobId, reason: '合成测试验证取消' })
    case 30: return call('working_directory', {})
    case 31: return call('todo_write', { todos: [{ content: '完成合成工具链验收', status: 'in_progress' }] })
    case 32: return call('mcp', { name: 'soak-personal' }, 'personal_echo')
    case 33: return call('mcp', { name: 'soak-personal', tools: ['personal_echo', 'catalog_item_319'] }, 'personal_echo')
    case 34: return call('personal_echo', { value: marker }, 'GXZS_SIM_PERSONAL_OK')
    case 35: return call('catalog_item_319', { value: marker }, 'GXZS_SIM_PERSONAL_OK')
    case 36: return call('todo_write', { todos: [{ content: '完成合成工具链验收', status: 'completed' }] })
    default: return ledger(scenario, step)
  }
}

export function specialStep(scenario, step, state, body) {
  if (scenario.kind === 'scheduled-delivery') return step === 0
    ? call('schedule_create', { title: '合成到期提醒', after_seconds: 10,
      prompt: `GXZS_SIM_CASE ${JSON.stringify({ id: scenario.id + '_delivery', rounds: 3, stepDelayMs: 100 })}` })
    : ledger(scenario, step)
  if (scenario.kind === 'goal') {
    const marker = `GXZS_SIM_GOAL_ROUND ${scenario.id} ${step}`
    const alreadyReturned = (body.messages ?? []).some(message => message.role === 'assistant' && textOf(message.content).includes(marker))
    if (step === 0) return call('create_goal', { objective: `GXZS_SIM_CASE ${JSON.stringify(scenario)}`, max_goal_rounds: 5 })
    if (step === 2 || step === 4) return alreadyReturned ? call('get_goal', {}) : { content: marker, intermediate: true }
    if (step === 5) return call('update_goal', { goal_id: state.goal?.id, revision: state.goal?.revision, action: 'complete' })
    return ledger(scenario, step)
  }
  if (scenario.kind === 'browser-recovery') {
    if (step === 0) return call('browser', { action: 'navigate', url: state.fixtureURL + '/fixture/slow-page?case=' + scenario.id })
    if (step === 1) return call('bash', { description: '等待慢页面完成资源加载', command: "node -e 'setTimeout(()=>console.log(\"GXZS_SIM_PAGE_WAIT_OK\"),10000)'" }, 'GXZS_SIM_PAGE_WAIT_OK')
    return call('browser', { action: 'snapshot' }, '合成慢页面')
  }
  return ledger(scenario, step)
}

export function textOf(content) {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : JSON.stringify(content)
}
export function observe(scenario, item, state) {
  const text = textOf(item.message.content), phase = item.step % 40
  if (state.expected?.[item.step] && !text.includes(state.expected[item.step])) throw new Error(`Real tool result ${item.step} missing expected marker: ${state.expected[item.step]}`)
  const expectedBrowserTimeout = scenario.kind === 'browser-recovery' && item.step === 0 && /timeout|timed out/i.test(text)
  if (!expectedBrowserTimeout && (/"(?:isError|is_error)"\s*:\s*true/.test(text) || /^Error: /m.test(text))) throw new Error(`Real tool result ${item.step} returned an error: ${text.slice(0, 500)}`)
  if (scenario.kind === 'goal' && item.call?.function?.name === 'get_goal') {
    const result = JSON.parse(text); state.goal = result.goal
    if (!state.goal?.id || !Number.isInteger(state.goal.revision)) throw new Error('Native goal result lacks an identity/revision')
  }
  if (scenario.kind === 'mixed' && (phase === 11 || phase === 28)) {
    const match = text.match(/(?:job_id|jobId|job id|Job ID|started background job)["'\s:]+([A-Za-z0-9_-]+)/i)
    if (!match) throw new Error(`Background result has no job id: ${text.slice(0, 400)}`)
    state.jobId = match[1]
  }
  if (scenario.kind === 'mixed' && phase === 14) {
    const match = text.match(/(?:"id"\s*:\s*"|(?:schedule(?: id)?|id)\s*[:=]\s*)([A-Za-z0-9_-]+)/i)
    if (!match) throw new Error(`Schedule result has no id: ${text.slice(0, 400)}`)
    state.scheduleId = match[1]
  }
  return { step: item.step, name: item.call?.function?.name, text }
}
