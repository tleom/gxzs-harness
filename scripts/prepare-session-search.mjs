// DSH 0.2.1-rc.2 reconciles every stored transcript before applying the
// caller's workspace filter. Scope cold reads before extraction, retaining
// native FTS queries, authorization, revision checks and cancellation.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function sessionSearchSource(source) {
  const edits = [
    ['materializeSessionResultFilters, readColdSessionLog', 'materializeSessionResultFilters, filterSessionResults, readColdSessionLog'],
    ['const persistenceBinding = await this._reconcile(signal);\n\t\t\tassertNotAborted(signal);\n\t\t\tconst generation', 'const persistenceBinding = await this._reconcile(signal, normalized.sessionFilters);\n\t\t\tassertNotAborted(signal);\n\t\t\tconst generation'],
    ['const persistenceBinding = await this._reconcile(signal);\n\t\t\tassertNotAborted(signal);\n\t\t\tconst target', 'const persistenceBinding = await this._reconcile(signal, [{ kind: "id", values: [normalized.sessionId] }]);\n\t\t\tassertNotAborted(signal);\n\t\t\tconst target'],
    ['const generation = String(this._globalGeneration);', 'const generation = this._scopedGeneration(normalized.sessionFilters, persistenceBinding);'],
    ['\t_querySessions(request, offset, persistenceBinding) {\n\t\tconst selected = selectedDocumentsSql();', `	_scopedGeneration(filters, persistenceBinding) {
		const where = buildSessionWhere(filters);
		const visible = persistenceBinding.service !== void 0 ? 1 : 0;
		const bindings = [visible, visible, ...where.params];
		assertPortableBindingCount(bindings.length);
		// Hash only metadata from the authoritative rows in this scope. Other
		// workspaces can build their indexes without invalidating this cursor.
		const rows = this._requireDb().prepare(\`WITH corpus AS (
      SELECT id AS session_id, cwd, created_at, parent_session,
        0 AS live, 1 AS persisted, generation
      FROM persisted_sessions AS ps
      WHERE ? = 1 AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = ps.id)
      UNION ALL
      SELECT id AS session_id, cwd, created_at, parent_session,
        1 AS live, CASE WHEN ? = 1 THEN persisted ELSE 0 END AS persisted, generation
      FROM temp.live_sessions
    ) SELECT session_id, live, persisted, generation FROM corpus
      \${where.sql.length === 0 ? "" : \`WHERE \${where.sql}\`}
      ORDER BY session_id\`).all(...bindings);
		return createHash("sha256").update(JSON.stringify([this._persistenceEpoch, rows])).digest("hex");
	}
	_querySessions(request, offset, persistenceBinding) {
		// Retain the native full-text result query and ordering.
		const selected = selectedDocumentsSql();`],
    ['async _reconcile(signal) {', 'async _reconcile(signal, filters = []) {'],
    ['const observation = await this._observeStable(persistedById, signal);', 'const headerFilters = filters.filter((filter) => filter.kind !== "availability");\n\t\tconst includes = (header) => filterSessionResults([{ header, live: true, persisted: true }], headerFilters).length !== 0;\n\t\tconst observation = await this._observeStable(persistedById, signal, includes);'],
    ['const persistentDeletes = observation.persistenceBinding.service === void 0 ? [] : persistedRows.filter((row) => !observation.persisted.has(row.id));', 'const pointerChanged = this._lastPersistenceIdentity !== void 0 && this._lastPersistenceIdentity !== observation.persistenceBinding.identity;\n\t\tconst persistentDeletes = observation.persistenceBinding.service === void 0 ? [] : persistedRows.filter((row) => pointerChanged || !observation.persisted.has(row.id));'],
    ['\n\t\tconst pointerChanged = this._lastPersistenceIdentity !== void 0 && this._lastPersistenceIdentity !== observation.persistenceBinding.identity;\n\t\tconst hasWrites', '\n\t\tconst hasWrites'],
    ['const liveDeletes = liveRows.filter((row) => !observation.live.has(row.id));', 'const liveDeletes = liveRows.filter((row) => this.ctx.sessions.get(row.id) === void 0);'],
    ['async _observeStable(indexed, signal) {', 'async _observeStable(indexed, signal, includes) {'],
    ['const initiallyLive = new Set(this.ctx.sessions.list().map((session) => session.id));', 'const initiallyLive = new Set(this.ctx.sessions.list().filter((session) => includes(session.header)).map((session) => session.id));'],
    ['for (const entry of persisted.values()) {\n\t\t\t\t\tif (canReuseIndexed', 'for (const entry of persisted.values()) {\n\t\t\t\t\tif (!includes(entry.header)) continue;\n\t\t\t\t\tif (canReuseIndexed'],
    ['if (!samePersistenceSnapshots(persisted, after)) continue;', 'if (!samePersistenceSnapshots(persisted, after, includes, initiallyLive)) continue;'],
    ['for (const session of this.ctx.sessions.list()) {\n\t\t\t\tconst observed = observeLive(session);', 'for (const session of this.ctx.sessions.list()) {\n\t\t\t\tif (!includes(session.header)) continue;\n\t\t\t\tconst observed = observeLive(session);'],
    ['function samePersistenceSnapshots(before, after) {\n\tif (before.size !== after.size) return false;', 'function samePersistenceSnapshots(before, after, includes, live) {\n\tbefore = new Map([...before].filter(([, entry]) => includes(entry.header)));\n\tafter = new Map([...after].filter(([, entry]) => includes(entry.header)));\n\tif (before.size !== after.size) return false;'],
    ['second === void 0 || first.revision !== second.revision || !sameHeader(first.header, second.header)', 'second === void 0 || (!live.has(id) && first.revision !== second.revision) || !sameHeader(first.header, second.header)'],
  ]
  for (const [before, after] of edits) {
    if (source.split(before).length === 2) source = source.replace(before, after)
    else if (!source.includes(after)) throw new Error('DSH session-search patch anchor changed')
  }
  return source
}

export async function prepareSessionSearch(directory = resolve(import.meta.dirname, '../profiles/workbench/node_modules/@deepseek-ai/dsh-session-query-sqlite')) {
  const root = resolve(directory)
  const info = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  if (info.version !== '0.2.1-rc.2') throw new Error('DSH session-query version changed; review the scope patch')
  const file = resolve(root, 'lib/index.js')
  await writeFile(file, sessionSearchSource(await readFile(file, 'utf8')))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareSessionSearch(process.argv[2])
