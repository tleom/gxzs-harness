import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from admission import Admission


def test_fenced_old_generation_ticket_can_request_new_identity(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    assert queue.request('a', 1, 'host-1', 'ticket', 'chat', 'acquire')['state'] == 'running'
    queue.fence('a', 'host-1')
    assert queue.request('a', 2, 'host-2', 'ticket', 'chat', 'acquire') == {'state': 'fenced', 'code': 'ADMISSION_TICKET_FENCED'}
    assert queue.request('a', 2, 'host-2', 'new-ticket', 'chat', 'acquire')['state'] == 'running'
    queue.close()


def test_limits_and_fifo(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    def call(owner, run, action='acquire'):
        return queue.request(owner, 1, 'host-' + owner, run, run, action)['state']
    assert queue.request('0', 1, 'host-0', 'one', 'one', 'acquire')['limits'] == {'per_user': 3, 'users': 15}
    for user in range(15):
        for run in ('one', 'two', 'three'):
            assert call(str(user), run) == 'running'
    assert queue.db.execute("SELECT COUNT(*) FROM task_admission WHERE state='running'").fetchone()[0] == 45
    assert call('0', 'four') == 'waiting'
    assert call('15', 'one') == 'waiting'
    call('0', 'one', 'release')
    assert call('15', 'one') == 'waiting'
    assert call('0', 'four') == 'running'
    call('1', 'one', 'release')
    assert call('15', 'one') == 'waiting'
    call('1', 'two', 'release')
    assert call('15', 'one') == 'waiting'
    call('1', 'three', 'release')
    assert call('15', 'one') == 'running'
    queue.close()


def test_same_generation_recovery_preserves_pending_tickets_and_fifo(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    try:
        for run in ('one', 'two', 'three'):
            assert queue.request('a', 1, 'host-a', run, run, 'acquire')['state'] == 'running'
        assert queue.request('a', 1, 'host-a', 'waiting', 'four', 'acquire')['state'] == 'waiting'
        queue.request('a', 1, 'host-a', 'two', 'two', 'release', retry=True)
        before = [tuple(row) for row in queue.db.execute("SELECT seq,run,state FROM task_admission WHERE state IN ('waiting','retry') ORDER BY seq")]
        queue.fence('a', 'wrong-host', preserve_pending=True)
        assert queue.active('a') == 2
        queue.fence('a', 'host-a', preserve_pending=True)
        assert queue.active('a') == 0 and queue.busy('a') == 2
        assert [tuple(row) for row in queue.db.execute("SELECT seq,run,state FROM task_admission WHERE state IN ('waiting','retry') ORDER BY seq")] == before
        assert queue.request('a', 1, 'host-a', 'waiting', 'four', 'acquire')['state'] == 'running'
        assert queue.request('a', 1, 'host-a', 'two', 'two', 'acquire')['state'] == 'running'
        assert queue.request('a', 1, 'host-a', 'one', 'one', 'acquire')['state'] == 'done'
        # Actual replacement/revocation keeps its stricter fencing semantics.
        queue.fence('a', 'host-a')
        assert queue.busy('a') == 0
        assert queue.request('a', 2, 'host-b', 'waiting', 'four', 'acquire')['state'] == 'fenced'
    finally:
        queue.close()


def test_restart_cancel_and_no_expiry_overcommit(tmp_path):
    path = str(tmp_path / 'queue.db')
    queue = Admission(path)
    assert queue.request('a', 1, 'host', 'r', 'chat', 'acquire')['state'] == 'running'
    queue.db.execute('UPDATE task_admission SET heartbeat=0')
    queue.db.commit()
    queue.close()
    queue = Admission(path)
    assert queue.request('a', 1, 'host', 'r', 'chat', 'renew')['state'] == 'running'
    assert queue.request('a', 1, 'host', 'r2', 'chat', 'acquire')['state'] == 'waiting'
    queue.request('a', 1, 'host', 'r2', 'chat', 'release')
    assert queue.request('a', 1, 'host', 'r2', 'chat', 'acquire')['state'] == 'done'
    queue.fence('a', 'wrong-host')
    assert queue.request('a', 1, 'host', 'r', 'chat', 'renew')['state'] == 'running'
    queue.fence('a', 'host')
    assert queue.request('a', 1, 'host', 'r3', 'chat', 'acquire')['state'] == 'running'
    queue.close()


def test_long_recovery_restores_waiting_fifo_before_any_dispatcher_polls(tmp_path, monkeypatch):
    import admission
    clock = [100]
    monkeypatch.setattr(admission.time, 'time', lambda: clock[0])
    path = str(tmp_path / 'queue.db')
    queue = Admission(path)
    for run in ('one', 'two', 'three'):
        assert queue.request('a', 1, 'host-a', run, run, 'acquire')['state'] == 'running'
    for run in ('first', 'second'):
        assert queue.request('a', 1, 'host-a', run, run, 'acquire')['state'] == 'waiting'
    queue.request('a', 1, 'host-a', 'two', 'two', 'release', retry=True)
    clock[0] = 200
    queue.fence('a', 'host-a', preserve_pending=True)
    queue.close()
    queue = Admission(path)
    try:
        clock[0] = 400  # Recovery and startup both exceed the 30-second window.
        queue.restore_pending('a', 2, 'host-a')
        queue.restore_pending('a', 1, 'other-host')
        assert queue.db.execute("SELECT heartbeat FROM task_admission WHERE run='first'").fetchone()[0] == 100
        queue.restore_pending('a', 1, 'host-a')
        assert queue.request('a', 1, 'host-a', 'second', 'second', 'acquire')['state'] == 'waiting'
        assert queue.request('a', 1, 'host-a', 'first', 'first', 'acquire')['state'] == 'running'
        assert queue.request('a', 1, 'host-a', 'second', 'second', 'acquire')['state'] == 'running'
        assert queue.db.execute("SELECT state FROM task_admission WHERE run='two'").fetchone()[0] == 'retry'
    finally:
        queue.close()


def test_retry_requeues_released_run(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    assert queue.request('a', 1, 'host', 'r', 'chat', 'acquire')['state'] == 'running'
    queue.request('a', 1, 'host', 'r', 'chat', 'release', retry=True)
    assert queue.request('a', 1, 'host', 'r', 'chat', 'acquire')['state'] == 'running'
    queue.close()


def test_busy_includes_waiting_and_retry_but_prune_only_removes_done(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    queue.request('a', 1, 'host', 'running', 'chat-a', 'acquire')
    queue.request('a', 1, 'host', 'waiting', 'chat-b', 'acquire')
    queue.request('a', 1, 'host', 'retry', 'chat-c', 'acquire')
    queue.request('a', 1, 'host', 'retry', 'chat-c', 'release', retry=True)
    queue.request('a', 1, 'host', 'done', 'chat-d', 'release')
    assert queue.active('a') == 2
    assert queue.busy('a') == 3
    queue.db.execute("UPDATE task_admission SET heartbeat=0")
    queue.db.commit()
    assert queue.prune(1) == 1
    assert queue.busy('a') == 3
    assert queue.ping()
    queue.close()


def test_concurrent_owners_never_exceed_capacity(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    def acquire(i):
        return queue.request(str(i // 4), 1, 'h' + str(i // 4), str(i), str(i), 'acquire')
    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(acquire, range(90)))
    rows = queue.db.execute("SELECT owner,COUNT(*) n FROM task_admission WHERE state='running' GROUP BY owner").fetchall()
    assert len(rows) <= 15
    assert sum(row['n'] for row in rows) <= 45
    assert all(row['n'] <= 3 for row in rows)
    queue.close()


def test_independent_connections_serialize_admission(tmp_path):
    path = str(tmp_path / 'queue.db')
    queues = [Admission(path) for _ in range(4)]
    def acquire(i):
        return queues[i % 4].request(str(i // 4), 1, 'h' + str(i // 4), str(i), str(i), 'acquire')
    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(acquire, range(90)))
    rows = queues[0].db.execute("SELECT owner,COUNT(*) n FROM task_admission WHERE state='running' GROUP BY owner").fetchall()
    assert len(rows) <= 15
    assert sum(row['n'] for row in rows) <= 45
    assert all(row['n'] <= 3 for row in rows)
    for queue in queues:
        queue.close()


def test_fourth_owner_task_waits_until_one_of_three_releases(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    try:
        for run in ('one', 'two', 'three'):
            assert queue.request('a', 1, 'host-a', run, run, 'acquire')['state'] == 'running'
        assert queue.request('a', 1, 'host-a', 'four', 'four', 'acquire')['state'] == 'waiting'
        assert queue.active('a') == 3
        queue.request('a', 1, 'host-a', 'one', 'one', 'release')
        assert queue.request('a', 1, 'host-a', 'four', 'four', 'acquire')['state'] == 'running'
        assert queue.active('a') == 3
    finally:
        queue.close()


def test_reduced_per_owner_limit_preserves_running_tasks_until_slots_drain(tmp_path, monkeypatch):
    import admission
    queue = Admission(str(tmp_path / 'queue.db'))
    try:
        monkeypatch.setattr(admission, 'MAX_CONVERSATIONS_PER_OWNER', 3)
        for run in ('one', 'two', 'three'):
            assert queue.request('a', 1, 'host-a', run, run, 'acquire')['state'] == 'running'
        monkeypatch.setattr(admission, 'MAX_CONVERSATIONS_PER_OWNER', 2)
        assert queue.request('a', 1, 'host-a', 'four', 'four', 'acquire')['state'] == 'waiting'
        assert queue.active('a') == 3
        assert queue.request('a', 1, 'host-a', 'three', 'three', 'renew')['state'] == 'running'
        queue.request('a', 1, 'host-a', 'one', 'one', 'release')
        assert queue.request('a', 1, 'host-a', 'four', 'four', 'acquire')['state'] == 'waiting'
        queue.request('a', 1, 'host-a', 'two', 'two', 'release')
        assert queue.request('a', 1, 'host-a', 'four', 'four', 'acquire')['state'] == 'running'
        assert queue.active('a') == 2
    finally:
        queue.close()
