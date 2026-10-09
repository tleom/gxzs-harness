/** Read the DSH-maintained projection instead of replaying synchronous history. */
export function nativeTurn(agent) {
  return agent?.ctx?.sessionProjections?.stateOf(agent.session, 'turnBoundary')
}
