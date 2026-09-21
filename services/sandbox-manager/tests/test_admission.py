import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from admission import Admission


def test_limits_and_fifo(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    def call(owner, run, action='acquire'):
        return queue.request(owner, 1, 'host-' + owner, run, run, action)['state']
    for user in range(10):
        assert call(str(user), 'one') == 'running'
        assert call(str(user), 'two') == 'running'
    assert call('0', 'three') == 'waiting'
    assert call('10', 'one') == 'waiting'
    call('0', 'one', 'release')
    assert call('10', 'one') == 'waiting'
    assert call('0', 'three') == 'running'
    call('1', 'one', 'release')
    assert call('10', 'one') == 'waiting'  # 10 distinct users still running
    call('1', 'two', 'release')
    assert call('10', 'one') == 'running'
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


def test_retry_requeues_released_run(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    assert queue.request('a', 1, 'host', 'r', 'chat', 'acquire')['state'] == 'running'
    queue.request('a', 1, 'host', 'r', 'chat', 'release', retry=True)
    assert queue.request('a', 1, 'host', 'r', 'chat', 'acquire')['state'] == 'running'
    queue.close()


def test_concurrent_owners_never_exceed_capacity(tmp_path):
    queue = Admission(str(tmp_path / 'queue.db'))
    def acquire(i):
        return queue.request(str(i // 3), 1, 'h' + str(i // 3), str(i), str(i), 'acquire')
    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(acquire, range(90)))
    rows = queue.db.execute("SELECT owner,COUNT(*) n FROM task_admission WHERE state='running' GROUP BY owner").fetchall()
    assert len(rows) <= 10
    assert sum(row['n'] for row in rows) <= 20
    assert all(row['n'] <= 2 for row in rows)
    queue.close()


def test_independent_connections_serialize_admission(tmp_path):
    path = str(tmp_path / 'queue.db')
    queues = [Admission(path) for _ in range(4)]
    def acquire(i):
        return queues[i % 4].request(str(i // 3), 1, 'h' + str(i // 3), str(i), str(i), 'acquire')
    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(acquire, range(90)))
    rows = queues[0].db.execute("SELECT owner,COUNT(*) n FROM task_admission WHERE state='running' GROUP BY owner").fetchall()
    assert len(rows) <= 10
    assert sum(row['n'] for row in rows) <= 20
    assert all(row['n'] <= 2 for row in rows)
    for queue in queues:
        queue.close()
