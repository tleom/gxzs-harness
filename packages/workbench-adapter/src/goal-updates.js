/** Overlay process-local activation on the native durable event stream. */
export async function* withGoalUpdates(source, subscribe, signal) {
  let dirty = false
  let wake
  const changed = () => { dirty = true; wake?.({ activation: true }) }
  const dispose = subscribe?.(changed)
  const iterator = source[Symbol.asyncIterator]()
  let pending
  const aborted = () => wake?.({ aborted: true })
  signal.addEventListener('abort', aborted, { once: true })
  try {
    while (!signal.aborted) {
      if (dirty) {
        dirty = false
        yield { type: 'goal-state' }
        continue
      }
      pending ??= iterator.next()
      const result = await Promise.race([pending, new Promise(resolve => { wake = resolve })])
      wake = undefined
      if (result.aborted) return
      if (result.activation) continue
      pending = undefined
      if (result.done) return
      yield result.value
    }
  } finally {
    dispose?.()
    signal.removeEventListener('abort', aborted)
    // The caller's signal closes a pending native read on disconnect.
    pending?.catch(() => {})
    await iterator.return?.()
  }
}
