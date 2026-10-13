import { randomUUID } from 'node:crypto'
import { httpError } from './http.js'
import path from 'node:path'
import { resolveWorkspacePath } from './paths.js'

// Mirrors DSH sessions/service.ts increasedForkTitle (client-only, not exported).
function increasedForkTitle(title) {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii) return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth) return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  return `${title} (1)`
}

/** Fork the model event log and the corresponding visible conversation together. */
export async function forkChat(service, owner, sourceRunId, body) {
  const db = service.database
  const source = db.getRun(owner.ownerId, sourceRunId)
  if (!source) throw httpError(404, '任务不存在')
  const origin = source.selection?.fork_source ?? { sessionId: source.sessionId, endSeq: source.sourceEndSeq }
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(source.status) || !Number.isInteger(origin.endSeq))
    throw httpError(409, '该回答尚未形成可分叉的历史，请等待任务结束')
  if (typeof body.request_key !== 'string' || !body.request_key.trim()) throw httpError(400, '缺少分叉请求标识')
  return service.withChatMutation(source.chatId, async () => {
    const chat = service.requireChat(owner, source.chatId)
    const key = `fork:${source.id}:${body.request_key}`
    const receipt = db.getCommandReceipt(owner.ownerId, chat.id, key)
    if (receipt) return service.getChat(owner, receipt.chatId, false)
    const runs = db.listRuns(owner.ownerId, chat.id)
    const chain = []
    const seen = new Set()
    let node = source
    while (node) {
      if (seen.has(node.id)) throw httpError(409, '会话历史关系异常，无法分叉')
      seen.add(node.id)
      chain.unshift(node)
      const parent = node.parentRunId ? runs.find((run) => run.id === node.parentRunId) : null
      if (node.parentRunId && !parent) throw httpError(409, '会话历史不完整，无法分叉')
      node = parent
    }
    // Steering messages are part of the selected turns, but are not separate turns.
    for (const run of [...chain]) {
      for (const event of db.steeringEvents(owner.ownerId, run.id)) {
        const supplement = runs.find((item) => item.id === event.steering_id)
        if (supplement && !seen.has(supplement.id)) { seen.add(supplement.id); chain.push(supplement) }
      }
    }
    const id = randomUUID()
    // The native fork owns turn boundaries, IDs, presets and history. Its cwd is inherited.
    let cwd = service.chatDirectory(chat.id, chat.directory)
    if (service.sessionQuery) {
      const observed = await service.sessionQuery.observeSession(origin.sessionId)
      try { cwd = observed.header.cwd ?? cwd } finally { observed[Symbol.dispose]?.() }
    }
    const absolute = resolveWorkspacePath(service.workspace, cwd)
    const directory = path.posix.relative(service.workspace, absolute) || '.'
    const child = await service.sessions.fork({ sessionId: origin.sessionId, atSeq: origin.endSeq })
    const title = increasedForkTitle(chat.title)
    await service.sessions.rename({ sessionId: child.sessionId, title })
    const ids = new Map(chain.map((run) => [run.id, randomUUID()]))
    ids.set(chat.id, id)
    const inputs = chain.flatMap((run) => db.db.prepare('SELECT * FROM pending_inputs WHERE run_id = ?').all(run.id))
    for (const input of inputs) ids.set(input.request_id, randomUUID())
    const remap = (value) => {
      if (typeof value === 'string') return ids.get(value) ?? value
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'native' ? item : remap(item)]))
      return value
    }
    const insert = (table, row) => {
      const keys = Object.keys(row)
      db.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row))
    }
    db.transaction(() => {
      const now = Date.now()
      const { fork_source: _, ...selection } = source.selection
      db.importChat({ id, ownerId: owner.ownerId, sessionId: child.sessionId, title, selection, directory, createdAt: now, updatedAt: now })
      for (const run of chain) {
        const row = db.db.prepare('SELECT * FROM runs WHERE id = ? AND owner_id = ?').get(run.id, owner.ownerId)
        insert('runs', {
          ...row, id: ids.get(run.id), chat_id: id, session_id: child.sessionId, request_key: null,
          parent_run_id: ids.get(run.parentRunId) ?? null,
          selection_json: JSON.stringify({ ...run.selection, fork_source: run.selection.fork_source ?? { sessionId: run.sessionId, endSeq: run.sourceEndSeq } }),
        })
        for (const binding of db.db.prepare('SELECT * FROM run_turns WHERE run_id=?').all(run.id))
          insert('run_turns', { ...binding, session_id: child.sessionId, run_id: ids.get(run.id) })
        for (const event of db.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq').all(run.id))
          insert('run_events', { ...event, run_id: ids.get(run.id), payload_json: JSON.stringify(remap(JSON.parse(event.payload_json))) })
      }
      const goalRun = db.goalRun(chat.sessionId)
      if (goalRun && ids.has(goalRun.id)) db.setGoalRun(child.sessionId, ids.get(goalRun.id))
      for (const input of inputs) {
        const supplementId = input.answer_json ? JSON.parse(input.answer_json).supplement_run_id : null
        const copiedSupplement = supplementId && ids.has(supplementId)
        const answer = copiedSupplement ? JSON.parse(input.answer_json) : null
        insert('pending_inputs', {
        ...input, request_id: ids.get(input.request_id), run_id: ids.get(input.run_id),
        status: copiedSupplement ? input.status : 'skipped',
        payload_json: JSON.stringify(remap(JSON.parse(input.payload_json))),
        answer_json: answer ? JSON.stringify(remap(answer)) : null,
        })
      }
      db.saveCommandReceipt(owner.ownerId, chat.id, key, { chatId: id })
    })()
    // Preserve the entire durable history, but load its display through bounded native pages.
    return service.getChat(owner, id, false)
  })
}
