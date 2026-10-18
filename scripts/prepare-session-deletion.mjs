import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// DSH rc.2 has archive but no permanent deletion. Expose narrow Host-side
// lifecycle/storage operations; leave search, replay and archive semantics intact.
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Session deletion upstream anchor changed')
  return source.replace(before, after)
}

export function agentDeletionSource(source) {
  if (source.includes('async disposeSessionForDeletion(id)')) return source
  source = replaceOnce(source, '\tstore = /* @__PURE__ */ new Map();\n\tfactory;', `	store = /* @__PURE__ */ new Map();
	deletionHandles = new Map();
	deletionCreations = new Map();
	deletedSessionIds = new Set();
	factory;`)
  source = replaceOnce(source, '\t\tsuper(ctx, "agents");', `		super(ctx, "agents");
		ctx.on("agent/disposed", ({ agent }) => {
			if (this.deletionHandles.get(agent.id)?.agent === agent) this.deletionHandles.delete(agent.id);
		}, { global: true });`)
  source = replaceOnce(source, 'return Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);', 'return this.trackDeletionHandle(options.sessionId, () => Reflect.apply(target.createAgent, receiver, [ownerCtx, options]));')
  source = replaceOnce(source, 'return Reflect.apply(target.resume, receiver, [ownerCtx, options]);', 'return this.trackDeletionHandle(options.resumeSessionId, () => Reflect.apply(target.resume, receiver, [ownerCtx, options]));')
  return replaceOnce(source, '\t/** Return the active creation factory. */', `	async trackDeletionHandle(id, create) {
		if (this.deletedSessionIds.has(id)) throw Object.assign(new Error("Session was permanently deleted"), { code: "SESSION_DELETED" });
		const pending = Promise.resolve().then(create).then(async handle => {
			this.deletionHandles.set(id, handle);
			if (this.deletedSessionIds.has(id)) {
				await handle.dispose();
				throw Object.assign(new Error("Session was permanently deleted"), { code: "SESSION_DELETED" });
			}
			return handle;
		});
		const operations = this.deletionCreations.get(id) ?? new Set();
		operations.add(pending);
		this.deletionCreations.set(id, operations);
		try { return await pending; }
		finally {
			operations.delete(pending);
			if (!operations.size) this.deletionCreations.delete(id);
		}
	}
	// Trusted Host integration only. The original capability performs teardown.
	async disposeSessionForDeletion(id) {
		this.deletedSessionIds.add(id);
		await Promise.allSettled([...(this.deletionCreations.get(id) ?? [])]);
		const handle = this.deletionHandles.get(id);
		if (handle) await handle.dispose();
		if (this.get(id)) throw new Error("Session lifecycle is not owned by the deletion API");
		this.deletionHandles.delete(id);
	}
	/** Return the active creation factory. */`)
}

export function persistenceDeletionSource(source) {
  if (source.includes('async deleteSessionPermanently(id)')) return source
  source = replaceOnce(source, '\tasync read(offset = 0, length = Number.MAX_SAFE_INTEGER, options) {', `\tasync read(offset = 0, length = Number.MAX_SAFE_INTEGER, options) {
\t\treturn this.storage.withDeletionFence(this.id, () => this.readBeforeDeletion(offset, length, options));
\t}
\tasync readBeforeDeletion(offset, length, options) {`)
  source = replaceOnce(source, '\tasync create(header, options) {', `\tasync create(header, options) {
\t\treturn this.withDeletionFence(header.id, () => this.createBeforeDeletion(header, options), true);
\t}
\tasync createBeforeDeletion(header, options) {`)
  source = replaceOnce(source, '\tasync open(id, access, options) {', `\tasync open(id, access, options) {
\t\treturn this.withDeletionFence(id, () => this.openBeforeDeletion(id, access, options), true);
\t}
\tasync openBeforeDeletion(id, access, options) {`)
  return replaceOnce(source, '\tasync open(id, access, options) {', `	// Delete all generations while holding the original writer exclusion.
	// Keep the empty lock inode so another process cannot acquire a new lock
	// under the same pathname while this deletion still holds the old inode.
	deletedSessionIds = new Set();
	deletionOperations = new Map();
	async withDeletionFence(id, operation, returnsHandle = false) {
		if (this.deletedSessionIds.has(id)) throw new SessionPersistenceNotFoundError(id);
		const pending = Promise.resolve().then(operation).then(async result => {
			if (this.deletedSessionIds.has(id)) {
				if (returnsHandle) await result.close();
				throw new SessionPersistenceNotFoundError(id);
			}
			return result;
		});
		const operations = this.deletionOperations.get(id) ?? new Set();
		operations.add(pending);
		this.deletionOperations.set(id, operations);
		try { return await pending; }
		finally {
			operations.delete(pending);
			if (!operations.size) this.deletionOperations.delete(id);
		}
	}
	async deleteSessionPermanently(id) {
		if (typeof id !== "string" || !id.length) throw new TypeError("Invalid Session id");
		if (this.ctx.sessions.get(id) || this.tracker.writers.has(id)) throw new SessionAlreadyOwnedError(id);
		this.deletedSessionIds.add(id);
		await Promise.allSettled([...(this.deletionOperations.get(id) ?? [])]);
		for (const handle of [...this.tracker.openHandles]) if (handle.id === id) {
			await handle.close();
			handle.state.primed = void 0;
		}
		const preparation = this.migrationPreparations.get(id);
		if (preparation) { preparation.controller.abort(); await Promise.allSettled([preparation.promise]); }
		this.tracker.claimWrite(id);
		let lease;
		try {
			const selected = await this.findLog(id);
			if (selected) await this.readGenerationHeader(selected, id);
			// A retry may find only staging files after the canonical log was
			// already removed. Locate by encoded identity even in that case.
			for (const project of await this.listProjectDirs()) {
				const dir = join(project, encodeSegment(id));
				const info = await lstat(dir).catch(error => { if (error.code !== "ENOENT") throw error; });
				if (!info) continue;
				if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Session artifact directory");
				lease = await this.acquireLease(id, void 0, dir);
				try {
					for (const entry of await readdir(dir, { withFileTypes: true })) {
						if (entry.name !== LEASE_FILENAME) await rm(join(dir, entry.name), { recursive: true, force: true });
					}
					if ((await readdir(dir)).some(name => name !== LEASE_FILENAME)) throw new Error("Session artifacts changed during deletion");
					if (process.platform !== "win32") await this.syncDirPosix(dir);
				} finally { await lease.release(); lease = void 0; }
			}
			this.coldLogMemo.delete(id);
		} finally {
			try { await lease?.release(); }
			finally { this.tracker.releaseClaim(id); }
		}
	}
	async open(id, access, options) {`)
}

export function queryDeletionSource(source) {
  if (source.includes('async deleteSessionsPermanently(ids, erase, coordinated = false)')) return source
  source = replaceOnce(source, '\t\t\tconst service = childCtx.sessionPersistence;', `\t\t\tconst service = childCtx.sessionPersistence;
\t\t\tconst queries = service.deletionQueries ??= new Set();
\t\t\tqueries.add(this);
\t\t\tchildCtx.effect(() => () => queries.delete(this), "sessionQuerySqlite.deletionRegistry");`)
  return replaceOnce(source, '\tasync searchSessions(request, exec) {', `	// Serialize explicit erasure with searches. No reconciliation/filter changes.
	deletedSessionIds = new Set();
	deletionObservations = new Map();
	deletionLeases = new Map();
	async observeSession(id, options) {
		if (this.deletedSessionIds.has(id)) throw new SessionQueryError("Session was deleted", "SESSION_QUERY_SESSION_NOT_FOUND");
		const pending = super.observeSession(id, options);
		const operations = this.deletionObservations.get(id) ?? new Set();
		operations.add(pending);
		this.deletionObservations.set(id, operations);
		try {
			const lease = await pending;
			if (this.deletedSessionIds.has(id)) {
				lease[Symbol.dispose]();
				throw new SessionQueryError("Session was deleted", "SESSION_QUERY_SESSION_NOT_FOUND");
			}
			return this.deletionAwareLease(id, lease);
		} finally {
			operations.delete(pending);
			if (!operations.size) this.deletionObservations.delete(id);
		}
	}
	deletionAwareLease(id, lease) {
		const leases = this.deletionLeases.get(id) ?? new Set();
		const release = () => {
			lease[Symbol.dispose]();
			leases.delete(release);
			if (!leases.size) this.deletionLeases.delete(id);
		};
		leases.add(release);
		this.deletionLeases.set(id, leases);
		return new Proxy(lease, { get: (target, key) => {
			if (key === Symbol.dispose) return release;
			if (this.deletedSessionIds.has(id)) throw new SessionQueryError("Session was deleted", "SESSION_QUERY_SESSION_NOT_FOUND");
			if (key === "retain") return () => this.deletionAwareLease(id, target.retain());
			return Reflect.get(target, key);
		} });
	}
	async deleteSessionsPermanently(ids, erase, coordinated = false) {
		if (!coordinated) {
			const queries = [...(this._persistenceBinding.service?.deletionQueries ?? [this])];
			const next = index => index === queries.length ? erase() : queries[index].deleteSessionsPermanently(ids, () => next(index + 1), true);
			return next(0);
		}
		for (const id of ids) this.deletedSessionIds.add(id);
		return this._serialized(void 0, async () => {
			await this._ensureReady(void 0);
			for (const id of ids) {
				await Promise.allSettled([...(this.deletionObservations.get(id) ?? [])]);
				for (const release of [...(this.deletionLeases.get(id) ?? [])]) release();
				this._observations.cache.delete(id);
			}
			await erase();
			for (const id of ids) {
				if (this.ctx.sessions.get(id) || await this._persistenceBinding.service.stat(id)) throw new Error("Cannot forget an existing Session");
			}
			const db = this._requireDb();
			db.exec("PRAGMA secure_delete = ON; BEGIN IMMEDIATE");
			try {
				db.exec("INSERT INTO persisted_docs(persisted_docs, rank) VALUES('secure-delete', 1); INSERT INTO temp.live_docs(live_docs, rank) VALUES('secure-delete', 1)");
				for (const id of ids) { this._deleteSession("persisted", id); this._deleteSession("live", id); }
				const generation = Math.max(this._mainGeneration(), this._localGeneration) + 1;
				db.prepare("UPDATE search_state SET global_generation = ? WHERE singleton = 1").run(generation);
				db.exec("COMMIT");
				this._globalGeneration = generation;
				this._localGeneration = generation;
			} catch (error) { db.exec("ROLLBACK"); throw error; }
			const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
			if (checkpoint.busy) throw new Error("Session index deletion is waiting for a reader; retry deletion");
		});
	}
	async searchSessions(request, exec) {`)
}

export function projectionDeletionSource(source) {
  if (source.includes('async deleteSessionPermanently(id)')) return source
  return replaceOnce(source, '\tasync put(id, identity, rows) {', `\tdeletedSessionIds = new Set();
\tasync deleteSessionPermanently(id) {
\t\tthis.deletedSessionIds.add(id);
\t\tfor (const [session, state] of this.dirty) if (session.id === id) {
\t\t\tif (state.timer !== void 0) clearTimeout(state.timer);
\t\t\tthis.dirty.delete(session);
\t\t}
\t\tawait this.requireTable().deletePermanently(id);
\t}
\tasync put(id, identity, rows) {
\t\tif (this.deletedSessionIds.has(id)) return;`)
}

export function domainDeletionSource(source) {
  if (source.includes('deletePermanently(key)')) return source
  return replaceOnce(source, '\tdelete(key) {', `\tdeletePermanently(key) {
\t\treturn this.host.enqueue(async () => {
\t\t\tif (typeof this.host.unit.deleteRecordPermanently !== "function") throw new Error("Storage backend does not support permanent record deletion");
\t\t\tawait this.host.unit.deleteRecordPermanently(this.tableName, key);
\t\t\tthis.records.delete(key);
\t\t\tthis.host.emitChanged({ domain: this.host.domainName, table: this.tableName, key, operation: "deleted" });
\t\t});
\t}
\tdelete(key) {`)
}

export function jsonStorageDeletionSource(source) {
  if (source.includes('async deleteRecordPermanently(table, key)')) return source
  return replaceOnce(source, '\t/**\n\t* Move one record\'s document aside', `\tasync deleteRecordPermanently(table, key) {
\t\tthis.assertOpen();
\t\tassertSafeKey(this.descriptor.name, key);
\t\tconst dir = this.tableDir(table);
\t\t// Retained legacy units can otherwise bootstrap a deleted record again.
\t\tconst legacy = join(dirname(this.dir), this.descriptor.name + ".json");
\t\tconst text = await readFile(legacy, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; });
\t\tif (text !== void 0) {
\t\t\tconst document = JSON.parse(text);
\t\t\tif (document.unit?.name !== this.descriptor.name) throw new Error("Unexpected legacy storage identity");
\t\t\tif (Object.hasOwn(document.tables?.[table] ?? {}, key)) {
\t\t\t\tdelete document.tables[table][key];
\t\t\t\tawait this.tracked(writeAtomic(legacy, JSON.stringify(document) + "\\n"));
\t\t\t}
\t\t}
\t\tconst entries = await readdir(dir).catch(error => { if (error.code !== "ENOENT") throw error; return []; });
\t\t// The original domain write chain is drained; table-local UUID stages are orphaned.
\t\tfor (const name of entries) if (name === key + ".json" || name.startsWith(key + ".json.bak.") || /^\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$/i.test(name))
\t\t\tawait this.tracked(rm(join(dir, name), { force: true }));
\t\tif (entries.length) await fsyncDirectory(dir);
\t}
\t/**
\t* Move one record's document aside`)
}

export async function prepareSessionDeletion(root) {
  for (const [name, transform] of [
    ['dsh-agent', agentDeletionSource],
    ['dsh-session-persistence-jsonl', persistenceDeletionSource],
    ['dsh-session-query-sqlite', queryDeletionSource],
    ['dsh-session-projection-cache', projectionDeletionSource],
    ['dsh-storage-domain', domainDeletionSource],
    ['dsh-storage-json', jsonStorageDeletionSource],
  ]) {
    const directory = join(root, 'node_modules/@deepseek-ai', name)
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (metadata.version !== '0.2.1-rc.2') throw new Error('Review permanent deletion against the new DSH version first')
    const path = join(directory, 'lib/index.js')
    const source = await readFile(path, 'utf8')
    const stamp = '// gxzs-permanent-deletion:' + createHash('sha256').update(transform.toString()).digest('hex')
    if (source.includes('// gxzs-permanent-deletion:') && !source.includes(stamp))
      throw new Error('Reinstall clean DSH packages before updating the deletion extension')
    const next = transform(source)
    if (next === source && !source.includes(stamp)) throw new Error('Unversioned deletion extension; reinstall clean DSH packages')
    if (next !== source) await writeFile(path, next + '\n' + stamp + '\n')
  }
}
