import { createHash } from 'node:crypto'

/** Platform deletion owns the operation; native handles own shutdown/storage. */
export class ChatDeletion {
  constructor(ctx, database, ownerId) { Object.assign(this, { ctx, database, ownerId }) }

  async prepare(chat) {
    const snapshots = await this.ctx.sessionPersistence.list()
    const headers = new Map(snapshots.map(row => [row.header.id, row.header]))
    for (const session of this.ctx.sessions.list()) headers.set(session.id, session.header)
    const roots = new Set(this.database.chatBindings(this.ownerId).filter(row => row.id !== chat.id).map(row => row.sessionId))
    const ids = new Set([chat.sessionId])
    let changed = true
    while (changed) {
      changed = false
      for (const header of headers.values()) {
        // parentSession also denotes fork lineage. Only delegated children are owned.
        if (header.origin === 'subagent' && !roots.has(header.id) && !ids.has(header.id) && ids.has(header.parentSession)) {
          ids.add(header.id)
          changed = true
        }
      }
    }
    return [...ids]
  }

  async erase(deletion) {
    const { agents, sessionPersistence, sessionQuery } = this.ctx
    if (typeof agents.disposeSessionForDeletion !== 'function' || typeof sessionPersistence.deleteSessionPermanently !== 'function'
      || typeof sessionQuery.deleteSessionsPermanently !== 'function') throw new Error('Permanent session deletion is not installed')
    const ids = new Set(deletion.sessionIds)
    // Mark every identity synchronously before waiting for any child teardown.
    const releases = [...ids].map(id => agents.disposeSessionForDeletion(id))
    const results = await Promise.allSettled(releases)
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Session shutdown failed during deletion')
    const changes = this.ctx.get('workspaceChanges')
    if (changes) {
      if (typeof changes.deleteSessionPermanently !== 'function') throw new Error('Permanent workspace snapshot deletion is not installed')
      for (const id of ids) await changes.deleteSessionPermanently(id)
    }
    const schedule = this.ctx.get('schedule')
    if (schedule) {
      if (typeof schedule.deleteSessionPermanently !== 'function') throw new Error('Permanent schedule deletion is not installed')
      for (const id of ids) await schedule.deleteSessionPermanently(id)
    }
    await sessionQuery.deleteSessionsPermanently([...ids], async () => {
      const cache = this.ctx.get('sessionProjectionCache')
      if (cache && typeof cache.deleteSessionPermanently !== 'function') throw new Error('Permanent projection cache deletion is not installed')
      if (cache) for (const id of ids) await cache.deleteSessionPermanently(id)
      for (const id of ids) await sessionPersistence.deleteSessionPermanently(id)
    })
    await this.erasePrivateOutputs(ids)
  }

  async erasePrivateOutputs(ids) {
    const files = this.ctx.get('workbenchFileManager')
    if (!files) return
    const paths = new Set([...ids].map(id => `.agent-output/${createHash('sha256').update(id).digest('hex').slice(0, 32)}`))
    // Most sessions never spill tool output. Avoid decoding retained histories
    // when there is no directory to delete; shutdown already fenced all writers.
    for (const path of paths) {
      if ((await files.operate({ operation: 'stat', path })).kind === 'missing') paths.delete(path)
    }
    if (!paths.size) return
    // A fork keeps its copied transcript, including paths to full tool results.
    // Scan surviving native history instead of assuming parentSession is a reference count.
    const preserve = value => {
      const text = JSON.stringify(value)
      for (const path of paths) if (text.includes(path)) paths.delete(path)
    }
    // Queued messages may refer to an output before entering the native log.
    for (const input of this.database.retainedRunInputs?.(this.ownerId) ?? []) preserve(input)
    const live = new Map(this.ctx.sessions.list().map(session => [session.id, session]))
    const stored = await this.ctx.sessionPersistence.list()
    for (const session of live.values()) if (!ids.has(session.id)) preserve(session.snapshotEvents())
    for (const row of stored) {
      if (!paths.size) break
      if (ids.has(row.header.id) || live.has(row.header.id)) continue
      const handle = await this.ctx.sessionPersistence.open(row.header.id, 'read')
      try {
        for (let offset = 0; paths.size; offset += 256) {
          const { events } = await handle.read(offset, 256)
          preserve(events)
          if (events.length < 256) break
        }
      } finally { await handle.close() }
    }
    for (const path of paths) {
      const entry = await files.operate({ operation: 'stat', path })
      if (entry.kind !== 'missing') await files.operate({ operation: 'delete', path, version: entry.version })
    }
  }
}
