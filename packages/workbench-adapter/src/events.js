export class RunEventBus {
  constructor() { this.listeners = new Map() }

  subscribe(runId, listener) {
    let listeners = this.listeners.get(runId)
    if (!listeners) this.listeners.set(runId, listeners = new Set())
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(runId)
    }
  }

  publish(runId, event) {
    for (const listener of this.listeners.get(runId) ?? []) {
      try { listener(event) }
      catch { /* A disconnected SSE client must not break the session event pipeline. */ }
    }
  }
}
