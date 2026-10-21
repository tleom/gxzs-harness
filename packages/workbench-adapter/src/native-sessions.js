import { httpError } from './http.js'
import { ownedSessionRoots } from './owned-session-roots.js'

const SESSION_EVENTS = ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity', 'api-session/error']
const GLOBAL_EVENTS = ['settings/document-updated', 'llm/adapters-updated', 'schedule/changed', 'workbench/schedule-notifications-changed']

/** Owner-scoped transport for public Session APIs. Admission stays in the existing gateways. */
export class WorkbenchNativeSessions {
  constructor({ ctx, sessions, service, subagents, database }) {
    Object.assign(this, { ctx, sessions, service, subagents, database })
  }

  async list(owner, signal) {
    const result = await this.sessions.list({}, signal)
    const owned = ownedSessionRoots(this.database.listChats(owner.ownerId), result.items)
    return { ...result, items: result.items.filter(item => owned.has(item.sessionId)) }
  }

  async address(owner, chatId, request, signal) {
    const root = this.service.requireChat(owner, chatId)
    const address = request?.address
    if (!address || !['session', 'subagent'].includes(address.kind)) throw httpError(400, '会话地址无效')
    if (address.kind === 'session' && address.sessionId === root.sessionId) return address
    if (address.kind !== 'subagent') throw httpError(403, '子会话必须使用原生父子地址')
    const child = await this.subagents.requireChild(owner, chatId, address.childSessionId, signal)
    if (address.parentSessionId !== child.parentSessionId) throw httpError(403, '子会话父地址不匹配')
    // The native controller verifies mode and the durable own-suffix proof.
    return address
  }

  async *follow(owner, chatId, request, signal) {
    const address = await this.address(owner, chatId, request, signal)
    for await (const value of this.sessions.follow({ ...request, address }, signal)) yield { event: 'native_session', value }
  }

  async read(owner, chatId, operation, request, signal) {
    const address = await this.address(owner, chatId, request, signal)
    if (operation === 'page') return this.sessions.page({ ...request, address }, signal)
    const sessionId = address.kind === 'session' ? address.sessionId : address.childSessionId
    if (operation === 'projections') return this.sessions.projections({ sessionId, ...(request.keys ? { keys: request.keys } : {}) }, signal)
    if (operation === 'attachment') {
      return this.sessions.attachment({ sessionId, attachmentId: request.attachmentId }, signal)
    }
    throw httpError(404, '原生会话读取接口不存在')
  }

  async *control(_owner, signal) {
    // This Host belongs to one signed owner. Control is read-only; list and
    // addressed history still apply the platform's conversation visibility.
    for await (const value of this.sessions.control(signal)) yield { event: 'native_session_control', value }
  }

  async *events(owner, signal) {
    const queue = []
    let wake, failure
    const stop = () => wake?.()
    const disposers = [...SESSION_EVENTS, ...GLOBAL_EVENTS].map(event => this.ctx.on(event, (...args) => {
      if (signal.aborted || failure) return
      if (queue.length >= 256) failure = httpError(503, '会话事件连接需要重新建立')
      else queue.push({ event, args })
      wake?.()
    }, { global: true }))
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      yield { event: 'native_session_events', value: { type: 'ready' } }
      while (!signal.aborted) {
        if (!queue.length && !failure) await new Promise(resolve => { wake = resolve })
        wake = undefined
        signal.throwIfAborted()
        if (failure) throw failure
        let ids
        while (queue.length && !signal.aborted) {
          const value = queue.shift()
          if (GLOBAL_EVENTS.includes(value.event)) {
            if (value.event === 'settings/document-updated' && !['subagent', 'subagent-model-selection-settings', 'ui-conversation'].includes(value.args[0])) continue
            // Keep existing clients' catalog invalidation contract at the transport boundary.
            yield { event: 'native_session_events', value: { type: 'emit', ...value,
              event: value.event === 'workbench/schedule-notifications-changed' ? 'schedule/changed' : value.event } }
            continue
          }
          ids ??= new Set((await this.list(owner, signal)).items.map(item => item.sessionId))
          const id = value.event === 'api-session/added' ? value.args[0]?.sessionId : value.args[0]
          // A removal must reach a client that already retained this identity.
          if (value.event !== 'api-session/removed' && !ids.has(id)) continue
          yield { event: 'native_session_events', value: { type: 'emit', ...value } }
        }
      }
    } finally {
      signal.removeEventListener('abort', stop)
      disposers.forEach(dispose => dispose())
    }
  }
}
