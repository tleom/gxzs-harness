"""Durable global task admission. A stale heartbeat never frees a live task slot."""
import os
import sqlite3
import threading
import time


class Admission:
    def __init__(self, path):
        self.guard = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('''CREATE TABLE IF NOT EXISTS task_admission (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, run TEXT NOT NULL,
            generation INTEGER NOT NULL, instance TEXT NOT NULL, chat TEXT NOT NULL,
            state TEXT NOT NULL, heartbeat REAL NOT NULL, UNIQUE(owner,run))''')
        self.db.commit()
        os.chmod(path, 0o600)

    def request(self, owner, generation, instance, run, chat, action, retry=False):
        if action not in ('acquire', 'renew', 'release') or not all((owner, instance, run, chat)) or generation < 1:
            raise ValueError('Invalid scheduling request')
        with self.guard, self.db:
            # Serialize read/decide/write across SQLite connections as well.
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT * FROM task_admission WHERE owner=? AND run=?', (owner, run)).fetchone()
            if row and row['state'] == 'done' and generation > row['generation']:
                return {'state': 'fenced', 'code': 'ADMISSION_TICKET_FENCED'}
            if row and (row['generation'] != generation or row['instance'] != instance or row['chat'] != chat):
                raise ValueError('Task belongs to another host generation or conversation')
            now = time.time()
            if action == 'release':
                if row:
                    self.db.execute("UPDATE task_admission SET state=?,heartbeat=? WHERE seq=?", ('retry' if retry else 'done', now, row['seq']))
                else:
                    self.db.execute("INSERT INTO task_admission(owner,run,generation,instance,chat,state,heartbeat) VALUES(?,?,?,?,?,'done',?)", (owner, run, generation, instance, chat, now))
            elif action == 'acquire' and not row:
                self.db.execute("INSERT INTO task_admission(owner,run,generation,instance,chat,state,heartbeat) VALUES(?,?,?,?,?,'waiting',?)", (owner, run, generation, instance, chat, now))
            elif row:
                # A retry reuses the durable run identity. Requeue a released
                # admission row instead of leaving it terminal forever.
                self.db.execute(
                    "UPDATE task_admission SET state=?, heartbeat=? WHERE seq=?",
                    ('waiting' if action == 'acquire' and row['state'] == 'retry' else row['state'], now, row['seq'])
                )
            if action == 'acquire':
                # Reserve only for this polling host. Do not grant absent hosts
                # slots while releasing another task; preserve eligible FIFO.
                running = self.db.execute("SELECT * FROM task_admission WHERE state='running'").fetchall()
                counts = {}
                chats = set()
                for task in running:
                    counts[task['owner']] = counts.get(task['owner'], 0) + 1
                    chats.add((task['owner'], task['chat']))
                if len(running) < 20:
                    for pending in self.db.execute("SELECT * FROM task_admission WHERE state='waiting' AND heartbeat>? ORDER BY seq", (now - 30,)):
                        user = pending['owner']
                        if counts.get(user, 0) >= 2 or (user not in counts and len(counts) >= 10) or (user, pending['chat']) in chats:
                            continue
                        if user == owner and pending['run'] == run:
                            self.db.execute("UPDATE task_admission SET state='running' WHERE seq=?", (pending['seq'],))
                        break
            current = self.db.execute('SELECT state FROM task_admission WHERE owner=? AND run=?', (owner, run)).fetchone()
            return {'state': current['state'] if current else 'missing', 'limits': {'per_user': 2, 'users': 10, 'tasks': 20}}

    def fence(self, owner, instance):
        """Call only AFTER that host and its sandbox have been stopped."""
        with self.guard, self.db:
            self.db.execute("UPDATE task_admission SET state='done' WHERE owner=? AND instance=? AND state IN ('running','waiting','retry')", (owner, instance))

    def active(self, owner):
        with self.guard:
            return self.db.execute("SELECT COUNT(*) FROM task_admission WHERE owner=? AND state='running'", (owner,)).fetchone()[0]

    def busy(self, owner):
        """Include queued and retrying work when deciding host lifecycle."""
        with self.guard:
            return self.db.execute(
                "SELECT COUNT(*) FROM task_admission WHERE owner=? AND state IN ('running','waiting','retry')",
                (owner,),
            ).fetchone()[0]

    def pending(self, owner, generation, instance, run, chat):
        """Whether this exact ticket was admitted before a Host began draining."""
        with self.guard:
            return self.db.execute(
                "SELECT 1 FROM task_admission WHERE owner=? AND generation=? AND instance=? AND run=? AND chat=? AND state IN ('running','waiting','retry')",
                (owner, generation, instance, run, chat),
            ).fetchone() is not None

    def ping(self):
        with self.guard:
            return self.db.execute('SELECT 1').fetchone()[0] == 1

    def prune(self, before):
        """Bound terminal scheduling history without touching active tickets."""
        with self.guard, self.db:
            return self.db.execute(
                "DELETE FROM task_admission WHERE state='done' AND heartbeat<?", (before,)
            ).rowcount

    def close(self):
        self.db.close()
