/** Read native liveness without consuming output, loading Agents or driving work. */
export async function nativeHostActivity(ctx, sidebarActivity = () => ({ browser: 0, terminal: 0 }), settingsActivity = () => 0, scheduleSafety) {
  try {
    const schedule = ctx.get('schedule')
    if (!schedule) return { protocol: 1, status: 'unknown' }
    // Read the durable native catalog first; sample live work after the await.
    const tasks = await schedule.catalog()
    const agents = ctx.agents.list()
    const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
    const jobs = new Map(ctx.jobs.list().map(job => [job.id, job]))
    for (const agent of agents) {
      for (const job of ctx.jobs.list(agent.id)) jobs.set(job.id, job)
    }
    const sidebar = sidebarActivity()
    const persistentTerminals = ctx.bail?.('gxzs/persistent-terminal-activity') ?? 0
    const activeSettingsWrites = settingsActivity()
    const wakeups = scheduleSafety?.(tasks)
    const activeSchedules = tasks.filter(task => task.status === 'active').length
    if (wakeups && (!Number.isSafeInteger(wakeups.registeredSchedules) || wakeups.registeredSchedules < 0
      || wakeups.registeredSchedules > activeSchedules || !Number.isSafeInteger(wakeups.pendingScheduleReports)
      || wakeups.pendingScheduleReports < 0)) return { protocol: 1, status: 'unknown' }
    if (![sidebar.browser, sidebar.terminal, persistentTerminals, activeSettingsWrites].every(value => Number.isSafeInteger(value) && value >= 0))
      return { protocol: 1, status: 'unknown' }
    return {
      protocol: wakeups ? 2 : 1, status: 'ready',
      runningAgents: agents.filter(agent => agent.status === 'running').length,
      // Native archival durably blocks future steps but retains queued notices.
      // An idle archived Session is safe to preserve across a Host replacement;
      // running Agents and all Jobs/sidebar resources remain visible below.
      pendingMessages: agents.reduce((count, agent) => count + (agent.status !== 'running' && archived.has(agent.session?.id ?? agent.id)
        ? 0 : agent.inbox.nextTurn.length + agent.inbox.nextStep.length), 0),
      runningJobs: [...jobs.values()].filter(job => job.status === 'running' || job.status === 'stopping').length,
      activeSchedules,
      ...wakeups,
      activeSidebarResources: sidebar.browser + sidebar.terminal + persistentTerminals,
      activeSettingsWrites,
    }
  } catch {
    // Missing capabilities or a failed native read are not an empty Host.
    return { protocol: 1, status: 'unknown' }
  }
}
