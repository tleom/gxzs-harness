import { hasEarlierContent, historyWindow } from './history-page.js'
import { HistoryPresentation } from './history-presentation.js'
import { httpError } from './http.js'

const terminal = { completed: 'completed', aborted: 'cancelled', interrupted: 'interrupted' }
/** Read only native catalog descendants; never register another Workbench chat. */
export class WorkbenchSubagents {
  constructor({ sessions, service, native, attachments, runtime }) { this.sessions = sessions; this.service = service; this.native = native; this.attachments = attachments; this.runtime = runtime }
  async catalog(owner, chatId, signal) {
    const parent = this.service.requireChat(owner, chatId)
    const { items } = await this.sessions.list({}, signal)
    const root = items.find(item => item.sessionId === parent.sessionId)
    const catalog = root?.projections?.values?.subagentCatalog ?? []
    return catalog.map(entry => {
      const item = items.find(item => item.sessionId === entry.id)
      const values = item?.projections?.values ?? {}
      return { ...entry, title: entry.label || entry.id, summary: values.title, running: item?.running === true, parentAvailable: root?.agentAvailable === true,
        timing: values.subagentTiming, usage: values.tokenUsage, parentSessionId: parent.sessionId }
    })
  }
  async prompt(owner, chatId, childId, request, signal) {
    const child = (await this.catalog(owner, chatId, signal)).find(item => item.id === childId)
    if (!child) throw httpError(404, '子智能体不属于此对话')
    if (child.mode !== 'continuable') throw httpError(409, '此子智能体不支持后续消息')
    if (!this.native) throw httpError(503, '子智能体服务尚未就绪')
    const images = request.images ?? []
    if (typeof request.text !== 'string' || (!request.text.trim() && !images.length) || typeof request.requestId !== 'string'
      || !Array.isArray(images) || images.length > 20) throw httpError(400, '子智能体消息无效')
    let bytes = 0
    for (const image of images) {
      if (!image || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)
        || typeof image.data !== 'string' || (image.name !== undefined && typeof image.name !== 'string')) throw httpError(400, '图片参数无效')
      bytes += image.data.length * 0.75
    }
    if (bytes > 20 * 1024 * 1024) throw httpError(413, '图片总大小超过 20 MiB')
    const receipt = this.runtime?.prepareChildPrompt(this.service.requireChat(owner, chatId), child, request.requestId)
    try { return await this.native.prompt({ parentSessionId: child.parentSessionId, childSessionId: child.id,
      mode: 'continuable', requestId: request.requestId, delivery: 'queue', content: [
        ...(request.text.trim() ? [{ type: 'text', text: request.text }] : []),
        ...images.map(({ data, mediaType, name }) => ({ type: 'image', data, mediaType, ...(name ? { name } : {}) }))],
      ...(request.clientTimeZone ? { clientTimeZone: request.clientTimeZone } : {}) }, signal)
    } catch (error) {
      if (receipt?.requestKey === `subagent-prompt:${child.id}:${request.requestId}` && receipt.status === 'running'
        && !signal.aborted && error.status >= 400 && error.status < 500 && error.status !== 408)
        this.runtime.rejectChildPrompt(receipt)
      throw error
    }
  }
  async image(owner, chatId, childId, ref, signal) {
    if (!(await this.catalog(owner, chatId, signal)).some(child => child.id === childId && child.mode !== 'external')) throw httpError(404, '子智能体不属于此对话')
    if (!this.attachments || !ref || typeof ref.attachmentId !== 'string'
      || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(ref.mediaType)) throw httpError(400, '图片引用无效')
    // This store is mounted on the signed owner's private Host home.
    return this.attachments.readImage(ref, signal)
  }
  async history(owner, chatId, childId, cursor, signal) {
    const child = (await this.catalog(owner, chatId, signal)).find(item => item.id === childId)
    if (!child) throw httpError(404, '子智能体不属于此对话')
    if (child.mode === 'external') throw httpError(409, '外部子智能体没有本地对话记录')
    const address = { kind: 'subagent', parentSessionId: child.parentSessionId,
      childSessionId: child.id, mode: child.mode }
    let frame
    if (cursor !== undefined) {
      if (cursor?.sessionId !== childId || !Number.isSafeInteger(cursor.throughSeq)
        || !Number.isSafeInteger(cursor.beforeSeq) || cursor.beforeSeq < 0
        || cursor.beforeSeq > cursor.throughSeq + 1) throw httpError(400, '子智能体历史游标无效')
      const page = await this.sessions.page({ address, throughSeq: cursor.throughSeq,
        beforeSeq: cursor.beforeSeq, ...historyWindow }, signal)
      frame = { type: 'snapshot', ...page, cursor: cursor.throughSeq }
    } else {
      const abort = new AbortController()
      const stop = () => abort.abort(signal.reason)
      signal.addEventListener('abort', stop, { once: true })
      const source = this.sessions.follow({ address, ...historyWindow, assistantStream: true }, abort.signal)[Symbol.asyncIterator]()
      try {
        signal.throwIfAborted()
        const first = await source.next()
        if (first.done || first.value.type !== 'snapshot') throw httpError(503, '子智能体历史尚未就绪')
        frame = first.value
      } finally {
        signal.removeEventListener('abort', stop); abort.abort(); await source.return?.()
      }
    }
    const runs = new Map()
    const get = turn => {
      if (!Number.isInteger(turn)) return
      let run = runs.get(turn)
      if (!run) {
        run = { id: `${childId}:turn:${turn}`, chat_id: chatId, revision_id: '', version: 1,
          query: '', status: child.running ? 'running' : 'completed', activity_protocol: 1,
          events: [], created_at: 0, history_complete: !frame.hasMore }
        runs.set(turn, run)
      }
      return run
    }
    let current
    for (const { event } of frame.records) {
      if (Number.isInteger(event.data?.turn)) current = event.data.turn
      const run = get(current)
      if (!run) continue
      if (!run.created_at) run.created_at = event.time / 1000
      if (event.type === 'turn/start') run.started_at = event.time / 1000
      if (event.type === 'user/message' && !run.messageId && ['user','agent-message','subagent-settled'].includes(event.data?.source?.kind)) {
        run.messageId = event.data.id
        run.message_id = event.data.id
        run.query = event.data.source.kind === 'user' ? (event.data?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n') : ''
        run.is_continuation = event.data.source.kind !== 'user'
        run.selection = { parent_session_id: child.parentSessionId }
        run.attachments = (event.data?.content ?? []).filter(block => block.type === 'image' && block.attachment).map(block => ({
          name: block.attachment.name || `图片.${block.attachment.mediaType.split('/').at(-1)}`,
          path: `native-image:${block.attachment.attachmentId}`, size: block.attachment.bytes,
          native_image: { parentChatId: chatId, childId, ref: block.attachment },
        }))
      }
      if (event.type === 'turn/end') {
        run.status = terminal[event.data.reason?.kind] ?? 'failed'
        run.completed_at = event.time / 1000
      }
    }
    const presentation = new HistoryPresentation(childId, turn => get(turn))
    for (const value of presentation.accept(frame).events) {
      const run = [...runs.values()].find(run => run.id === value.run_id)
      run?.events.push(value.event)
    }
    const before = frame.records[0]?.event.seq
    if (frame.hasMore && (!Number.isSafeInteger(before) || before < 1 || before >= (cursor?.beforeSeq ?? frame.cursor + 1)))
      throw httpError(502, '子智能体历史分页未向前推进')
    const hasMore = frame.hasMore && await hasEarlierContent(this.sessions, childId, frame.cursor, before, signal, address)
    return { child, runs: [...runs.values()], through_seq: frame.cursor, history_cursor: hasMore
      ? { sessionId: childId, throughSeq: frame.cursor, beforeSeq: before } : null }
  }
}
