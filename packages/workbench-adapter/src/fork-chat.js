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
  let source = db.getRun(owner.ownerId, sourceRunId)
  if (!source) throw httpError(404, '任务不存在')
  if (typeof body.request_key !== 'string' || !body.request_key.trim()) throw httpError(400, '缺少分叉请求标识')
  return service.withChatMutation(source.chatId, async () => {
    const chat = service.requireChat(owner, source.chatId)
    const key = `fork:${source.id}:${body.request_key}`
    const receipt = db.getCommandReceipt(owner.ownerId, chat.id, key)
    if (receipt) return service.getChat(owner, receipt.chatId, false)
    source = db.getRun(owner.ownerId, sourceRunId)
    // Inherited event sequences belong to the fork's own log too. Re-fork that
    // log so moving/deleting its ancestor cannot change its workspace or history.
    const origin = { sessionId: source.sessionId, endSeq: source.sourceEndSeq ?? source.selection?.fork_source?.endSeq }
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(source.status)
      || !Number.isSafeInteger(origin.endSeq) || origin.endSeq < 0)
      throw httpError(409, '该回答尚未形成可分叉的历史，请等待任务结束')
    const nativeKey = `fork-native:${source.id}:${body.request_key}`
    let prepared = db.getCommandReceipt(owner.ownerId, chat.id, nativeKey)
    if (prepared && (prepared.origin.sessionId !== origin.sessionId || prepared.origin.endSeq !== origin.endSeq))
      throw httpError(409, '原回答已变化，请刷新后重新分叉')
    const runs = db.listRunReferences(owner.ownerId, chat.id)
    const byId = new Map(runs.map(run => [run.id, run]))
    const chain = []
    const seen = new Set()
    let node = source
    while (node) {
      if (seen.has(node.id)) throw httpError(409, '会话历史关系异常，无法分叉')
      seen.add(node.id)
      chain.unshift(node)
      const parent = node.parentRunId ? byId.get(node.parentRunId) : null
      if (node.parentRunId && !parent) throw httpError(409, '会话历史不完整，无法分叉')
      node = parent
    }
    // A child reply/goal continuation can point to an earlier triggering run.
    // DSH forks the complete event prefix, including intervening settled turns.
    for (const run of runs) {
      if (!seen.has(run.id) && !run.nativeChild
        && Number.isSafeInteger(run.sourceEndSeq) && run.sourceEndSeq <= origin.endSeq) {
        seen.add(run.id)
        chain.push(run)
      }
    }
    // Steering messages are part of the selected turns, but are not separate turns.
    for (const run of [...chain]) {
      for (const event of db.steeringEvents(owner.ownerId, run.id)) {
        const supplement = byId.get(event.steering_id)
        if (supplement && !seen.has(supplement.id)) { seen.add(supplement.id); chain.push(supplement) }
      }
    }
    const id = randomUUID()
    // The native fork owns turn boundaries, IDs, presets and history. Its cwd is inherited.
    if (!prepared) {
      let cwd = service.chatDirectory(chat.id, chat.directory)
      if (service.sessionQuery) {
        const observed = await service.sessionQuery.observeSession(origin.sessionId)
        try { cwd = observed.header.cwd ?? cwd } finally { observed[Symbol.dispose]?.() }
      }
      const absolute = resolveWorkspacePath(service.workspace, cwd)
      const directory = path.posix.relative(service.workspace, absolute) || '.'
      const child = await service.sessions.fork({ sessionId: origin.sessionId, atSeq: origin.endSeq })
      // Retain the native result before rename/import, so retrying those stages
      // cannot create another native child, including after a host restart.
      prepared = db.saveCommandReceipt(owner.ownerId, chat.id, nativeKey, {
        sessionId: child.sessionId, origin, directory, title: increasedForkTitle(chat.title),
      })
    }
    const { sessionId, title, directory } = prepared
    await service.sessions.rename({ sessionId, title })
    const ids = new Map(chain.map((run) => [run.id, randomUUID()]))
    ids.set(chat.id, id)
    const inputs = chain.flatMap((run) => db.db.prepare('SELECT * FROM pending_inputs WHERE run_id = ?').all(run.id))
    for (const input of inputs) ids.set(input.request_id, randomUUID())
    const identityKeys = new Set(['run_id', 'workbench_run_id', 'backend_run_id', 'chat_id',
      'parent_run_id', 'steering_id', 'steer_target_run_id', 'request_id', 'supplement_run_id', 'tool_call_id'])
    // User text, questions, tool inputs/results and native payloads stay opaque.
    const remap = value => Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, identityKeys.has(key) ? ids.get(item) ?? item : item]))
    const remapEvent = value => ({ ...remap(value), ...(value.data && typeof value.data === 'object' && !Array.isArray(value.data)
      ? { data: remap(value.data) } : {}) })
    const insert = (table, row) => {
      const keys = Object.keys(row)
      db.db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row))
    }
    db.transaction(() => {
      const now = Date.now()
      // Only conversation settings carry forward. A turn's goal/schedule/steer
      // markers and explicit resource mentions belong to its historical row.
      const selection = Object.fromEntries(['model', 'tools', 'skills', 'knowledge', 'model_parameters', 'tool_parameters']
        .filter(key => source.selection[key] !== undefined).map(key => [key, source.selection[key]]))
      db.importChat({ id, ownerId: owner.ownerId, sessionId, title, selection, directory, createdAt: now, updatedAt: now })
      for (const run of chain) {
        const row = db.db.prepare('SELECT * FROM runs WHERE id = ? AND owner_id = ?').get(run.id, owner.ownerId)
        const selection = JSON.parse(row.selection_json)
        insert('runs', {
          ...row, id: ids.get(run.id), chat_id: id, session_id: sessionId, request_key: null,
          parent_run_id: ids.get(run.parentRunId) ?? null,
          selection_json: JSON.stringify({ ...selection, fork_source: selection.fork_source ?? { sessionId: run.sessionId, endSeq: run.sourceEndSeq } }),
        })
        for (const binding of db.db.prepare('SELECT * FROM run_turns WHERE run_id=?').all(run.id))
          insert('run_turns', { ...binding, session_id: sessionId, run_id: ids.get(run.id) })
        // Native pages can begin at a tool result, outside its call's window.
        // Retain labels for presentation without adopting unfinished execution.
        for (const call of db.db.prepare('SELECT * FROM tool_calls WHERE run_id=?').all(run.id))
          insert('tool_calls', { ...call, run_id: ids.get(run.id), status: 'finished' })
        for (const event of db.db.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq').all(run.id))
          insert('run_events', { ...event, run_id: ids.get(run.id), payload_json: JSON.stringify(remapEvent(JSON.parse(event.payload_json))) })
      }
      const goalRun = db.goalRun(chat.sessionId)
      if (goalRun && ids.has(goalRun.id)) db.setGoalRun(sessionId, ids.get(goalRun.id))
      for (const input of inputs) {
        const answer = input.answer_json ? JSON.parse(input.answer_json) : null
        const supplementId = answer?.supplement_run_id
        const settled = input.status !== 'pending' && (!supplementId || ids.has(supplementId))
        insert('pending_inputs', {
          ...input, request_id: ids.get(input.request_id), run_id: ids.get(input.run_id),
          status: settled ? input.status : 'skipped',
          payload_json: JSON.stringify(remap(JSON.parse(input.payload_json))),
          answer_json: settled && answer ? JSON.stringify(remap(answer)) : null,
        })
      }
      db.saveCommandReceipt(owner.ownerId, chat.id, key, { chatId: id })
    })()
    // Preserve the entire durable history, but load its display through bounded native pages.
    return service.getChat(owner, id, false)
  })
}
