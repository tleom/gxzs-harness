"""Durable uncertainty markers for stop confirmation; never used to deduplicate calls."""

import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path


def _connect():
    root = Path(os.environ.get('WORKBENCH_MANAGER_STATE', '/state'))
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    database = root / 'mcp-outcomes.sqlite3'
    connection = sqlite3.connect(database, timeout=2)
    os.chmod(database, 0o600)
    connection.execute('PRAGMA busy_timeout=2000')
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('PRAGMA synchronous=FULL')
    connection.execute('CREATE TABLE IF NOT EXISTS unconfirmed_calls ('
                       'call_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, '
                       'binding TEXT NOT NULL, started_at INTEGER NOT NULL)')
    connection.execute('CREATE INDEX IF NOT EXISTS unconfirmed_binding '
                       'ON unconfirmed_calls(workspace, binding)')
    return connection


def record_pending(workspace, binding, call_id):
    with closing(_connect()) as connection:
        connection.execute('INSERT INTO unconfirmed_calls VALUES (?, ?, ?, ?)',
                           (call_id, workspace, binding, int(time.time())))
        connection.commit()


def complete_call(workspace, binding, call_id):
    with closing(_connect()) as connection:
        connection.execute('DELETE FROM unconfirmed_calls WHERE call_id=? AND workspace=? AND binding=?',
                           (call_id, workspace, binding))
        connection.commit()


def has_unconfirmed(workspace, binding):
    with closing(_connect()) as connection:
        return connection.execute('SELECT 1 FROM unconfirmed_calls '
                                  'WHERE workspace=? AND binding=? LIMIT 1',
                                  (workspace, binding)).fetchone() is not None
