/** Read native liveness without consuming output, loading Agents or driving work. */
export async function nativeHostActivity(ctx, sidebarActivity = () => ({ browser: 0, terminal: 0 }), settingsActivity = () => 0) {
  try {
    const schedule = ctx.get('schedule')
    if (!schedule) return { protocol: 1, status: 'unknown' }
    // Read the durable native catalog first; sample live work after the await.
    const tasks = await schedule.catalog()
    const agents = ctx.agents.list()
    const jobs = new Map(ctx.jobs.list().map(job => [job.id, job]))
    for (const agent of agents) {
      for (const job of ctx.jobs.list(agent.id)) jobs.set(job.id, job)
    }
    const sidebar = sidebarActivity()
    const activeSettingsWrites = settingsActivity()
    if (![sidebar.browser, sidebar.terminal, activeSettingsWrites].every(value => Number.isSafeInteger(value) && value >= 0))
      return { protocol: 1, status: 'unknown' }
    return {
      protocol: 1, status: 'ready',
      runningAgents: agents.filter(agent => agent.status === 'running').length,
      pendingMessages: agents.reduce((count, agent) => count + agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0),
      runningJobs: [...jobs.values()].filter(job => job.status === 'running' || job.status === 'stopping').length,
      activeSchedules: tasks.filter(task => task.status === 'active').length,
      activeSidebarResources: sidebar.browser + sidebar.terminal,
      activeSettingsWrites,
    }
  } catch {
    // Missing capabilities or a failed native read are not an empty Host.
    return { protocol: 1, status: 'unknown' }
  }
}
