/** Observe the official bundle's isolated registry without consuming output. */
export const name = 'gxzs-persistent-terminal-activity'
export const inject = ['terminals', 'agents']

export function apply(ctx) {
  ctx.on('gxzs/persistent-terminal-activity', () =>
    ctx.agents.list().filter(agent => ctx.terminals.hasOwnerActivity(agent)).length,
  { global: true })
}
