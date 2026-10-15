/** Platform visibility over native lineage; no child receives another platform Chat. */
export function ownedSessionRoots(chats, records, excluded = new Set()) {
  const roots = new Map(chats.map(chat => [chat.sessionId, chat.id]))
  const rows = new Map(records.map(record => [record.sessionId ?? record.header?.id, record]))
  const result = new Map()
  for (const sessionId of new Set([...roots.keys(), ...rows.keys()])) {
    let id = sessionId
    const seen = new Set()
    while (id && !seen.has(id) && !excluded.has(id)) {
      if (roots.has(id)) {
        result.set(sessionId, { chatId: roots.get(id), rootSessionId: id,
          parentSessionId: rows.get(sessionId)?.parentSessionId ?? rows.get(sessionId)?.header?.parentSession })
        break
      }
      seen.add(id)
      id = rows.get(id)?.parentSessionId ?? rows.get(id)?.header?.parentSession
    }
  }
  return result
}
