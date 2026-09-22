"""Bounded MCP results with durable, non-expiring execution tombstones."""

import hashlib
import json
import sqlite3
import threading
import time
from contextlib import closing, contextmanager
from uuid import UUID

UNKNOWN = {
    "error": "此前 MCP 请求已受理，结果未知或已过保留期；请核实外部状态，同一请求不会重复执行",
    "uncertain": True,
}


class Journal:
    def __init__(
        self,
        root,
        *,
        ttl=86400,
        owner_bytes=64 * 1024 * 1024,
        total_bytes=256 * 1024 * 1024,
        max_records=100_000,
    ):
        self.root, self.path = root, root / "mcp-journal.sqlite3"
        self.ttl, self.owner_bytes, self.total_bytes, self.max_records = (
            ttl,
            owner_bytes,
            total_bytes,
            max_records,
        )
        self.guard = threading.RLock()
        with self.connection() as db:
            db.execute("PRAGMA auto_vacuum=INCREMENTAL")
            db.execute("""CREATE TABLE IF NOT EXISTS calls (
                digest TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL,
                created REAL NOT NULL, finished REAL, result BLOB
            )""")
            db.execute(
                "CREATE INDEX IF NOT EXISTS calls_owner ON calls(owner, finished)"
            )
            db.execute("""CREATE TABLE IF NOT EXISTS tombstones (
                digest TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL,
                created REAL NOT NULL, finished REAL NOT NULL
            ) WITHOUT ROWID""")
            db.execute("CREATE INDEX IF NOT EXISTS calls_archive ON calls(finished) WHERE finished IS NOT NULL")
            db.execute('''CREATE TABLE IF NOT EXISTS binding_effects (
                digest TEXT PRIMARY KEY, owner TEXT NOT NULL, binding TEXT NOT NULL,
                dispatch INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0,
                uncertain INTEGER NOT NULL DEFAULT 0)''')
            db.execute('CREATE INDEX IF NOT EXISTS effects_binding ON binding_effects(owner,binding)')
            db.execute('''CREATE TABLE IF NOT EXISTS cancelled_bindings (
                owner TEXT NOT NULL, binding TEXT NOT NULL, PRIMARY KEY(owner,binding)) WITHOUT ROWID''')

    @contextmanager
    def connection(self):
        with self.guard, closing(sqlite3.connect(self.path, timeout=10)) as db, db:
            yield db

    @staticmethod
    def identity(owner, payload):
        request = payload.get("request_key")
        if not isinstance(request, str) or not request or len(request) > 400:
            raise ValueError("MCP invocation requires an execution-scoped request key")
        digest = hashlib.sha256((owner + ":" + request).encode()).hexdigest()
        # Grants, expiry and transport deadlines are refreshed on retries. They
        # are authorization inputs, never the identity of a business operation.
        stable = {key: value for key, value in payload.items()
                  if key not in {"authorization", "deadline", "deadline_ms", "deadline_at"}}
        fingerprint = hashlib.sha256(json.dumps(stable, sort_keys=True).encode()).hexdigest()
        return digest, fingerprint

    def begin(self, owner, payload):
        """Reserve before side effects; a lost reply or process cannot execute twice."""
        digest, fingerprint = self.identity(owner, payload)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire(db)
            row = db.execute(
                "SELECT fingerprint, result FROM calls WHERE digest=?", (digest,)
            ).fetchone()
            if row is None:
                row = db.execute("SELECT fingerprint, NULL FROM tombstones WHERE digest=?", (digest,)).fetchone()
            # Refuse unknown prior reservations; never replay a possibly completed side effect.
            if row is None and (self.root / ("mcp-" + digest)).exists():
                return digest, dict(UNKNOWN)
            if row is not None:
                if row[0] != fingerprint:
                    return digest, {"error": "MCP 请求标识已被不同参数使用"}
                return digest, json.loads(row[1]) if row[1] is not None else dict(
                    UNKNOWN
                )
            self._archive(db, max(0, self.max_records - 1))
            if (
                db.execute("SELECT count(*) FROM calls").fetchone()[0]
                >= self.max_records
            ):
                return digest, {
                    "error": "MCP 执行记录已达到容量上限，本次操作未执行，请联系管理员归档"
                }
            db.execute(
                "INSERT INTO calls(digest, owner, fingerprint, created) VALUES(?,?,?,?)",
                (digest, owner, fingerprint, time.time()),
            )
            try:
                binding = str(UUID(payload['request_key'].split(':', 1)[0]))
            except (ValueError, KeyError):
                binding = None
            if binding:
                db.execute('INSERT INTO binding_effects(digest,owner,binding) VALUES(?,?,?)', (digest, owner, binding))
        return digest, None

    def lookup(self, owner, payload):
        digest, fingerprint = self.identity(owner, payload)
        with self.connection() as db:
            self._expire(db)
            row = db.execute('SELECT fingerprint,result FROM calls WHERE digest=? UNION ALL SELECT fingerprint,NULL FROM tombstones WHERE digest=?', (digest, digest)).fetchone()
            if row is not None:
                if row[0] != fingerprint:
                    return {'error': 'MCP 请求标识已被不同参数使用'}
                return json.loads(row[1]) if row[1] is not None else dict(UNKNOWN)
            if (self.root / ('mcp-' + digest)).exists():
                return dict(UNKNOWN)
        return None

    def finish(self, digest, output):
        data = json.dumps(output, ensure_ascii=False).encode()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT owner FROM calls WHERE digest=?", (digest,)
            ).fetchone()
            if row is None:
                raise ValueError("Missing MCP execution reservation")
            owner = row[0]
            db.execute('UPDATE binding_effects SET finished=1, uncertain=? WHERE digest=?', (int(output.get('uncertain') is True), digest))
            self._expire(db)
            if len(data) <= min(self.owner_bytes, self.total_bytes):
                self._trim(db, self.owner_bytes - len(data), owner)
                self._trim(db, self.total_bytes - len(data))
                db.execute(
                    "UPDATE calls SET finished=?, result=? WHERE digest=?",
                    (time.time(), data, digest),
                )
            else:
                db.execute(
                    "UPDATE calls SET finished=? WHERE digest=?", (time.time(), digest)
                )

    def prepare_dispatch(self, digest):
        """A durable send intent covers a crash during pipe IO, but not a call
        blocked by an earlier cancellation. It is resolved once writing ends.
        """
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT owner,binding FROM binding_effects WHERE digest=?', (digest,)).fetchone()
            if row is None:
                raise ValueError('MCP dispatch has no execution binding')
            if db.execute('SELECT 1 FROM cancelled_bindings WHERE owner=? AND binding=?', row).fetchone():
                return False
            db.execute('UPDATE binding_effects SET dispatch=1 WHERE digest=?', (digest,))
            return True

    def resolve_dispatch(self, digest, sent):
        with self.connection() as db:
            db.execute('UPDATE binding_effects SET dispatch=? WHERE digest=?', (2 if sent else 0, digest))

    def cancel_binding(self, owner, binding):
        with self.connection() as db:
            db.execute('INSERT OR IGNORE INTO cancelled_bindings(owner,binding) VALUES(?,?)', (owner, binding))

    def binding_uncertain(self, owner, binding):
        with self.connection() as db:
            return db.execute('''SELECT 1 FROM binding_effects WHERE owner=? AND binding=?
                AND dispatch>0 AND (finished=0 OR uncertain=1) LIMIT 1''', (owner, binding)).fetchone() is not None

    def _expire(self, db):
        db.execute(
            "UPDATE calls SET result=NULL WHERE result IS NOT NULL AND finished<?",
            (time.time() - self.ttl,),
        )

    @staticmethod
    def _trim(db, budget, owner=None):
        where, parameters = (
            (" AND owner=?", (owner,)) if owner is not None else ("", ())
        )
        size = db.execute(
            "SELECT coalesce(sum(length(result)),0) FROM calls WHERE result IS NOT NULL"
            + where,
            parameters,
        ).fetchone()[0]
        if size <= budget:
            return
        rows = db.execute(
            "SELECT digest, length(result) FROM calls WHERE result IS NOT NULL"
            + where
            + " ORDER BY finished, digest",
            parameters,
        )
        for digest, length in rows:
            db.execute("UPDATE calls SET result=NULL WHERE digest=?", (digest,))
            size -= length
            if size <= budget:
                break

    def prune(self):
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._expire(db)
            self._trim(db, self.total_bytes)
            owners = db.execute(
                "SELECT DISTINCT owner FROM calls WHERE result IS NOT NULL"
            ).fetchall()
            for (owner,) in owners:
                self._trim(db, self.owner_bytes, owner)
            self._archive(db, self.max_records)
        with self.connection() as db:
            db.execute("PRAGMA incremental_vacuum(2048)")

    @staticmethod
    def _archive(db, keep):
        """Compact finished reservations without ever forgetting request IDs.

        The active result cache is bounded; compact tombstones remain searchable
        in the same transaction and DB backup. Uncertain in-flight calls are
        deliberately not archived or replayed.
        """
        excess = max(0, db.execute("SELECT count(*) FROM calls").fetchone()[0] - keep)
        rows = db.execute("SELECT digest FROM calls WHERE finished IS NOT NULL ORDER BY finished, digest LIMIT ?", (excess,)).fetchall()
        for (digest,) in rows:
            db.execute("INSERT INTO tombstones SELECT digest,owner,fingerprint,created,finished FROM calls WHERE digest=?", (digest,))
            db.execute("DELETE FROM calls WHERE digest=?", (digest,))

    def statistics(self):
        with self.connection() as db:
            active, pending, results = db.execute("SELECT count(*),coalesce(sum(finished IS NULL),0),coalesce(sum(length(result)),0) FROM calls").fetchone()
            archived = db.execute("SELECT count(*) FROM tombstones").fetchone()[0]
        return {"active_records": active, "pending_records": pending, "archived_records": archived,
                "result_bytes": results, "active_limit": self.max_records,
                "database_bytes": self.path.stat().st_size}
