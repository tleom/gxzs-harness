"""Maintenance dispatch must not couple unrelated owners' heartbeat cycles."""
import ast
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from queue import Queue
import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hosts import Hosts


@pytest.fixture
def host(tmp_path):
    locks = {}
    def docker(*args, **_kwargs):
        assert args[0] == 'inspect'
        return SimpleNamespace(returncode=0, stdout=json.dumps([{'State': {'Running': True}}]))
    result = Hosts(tmp_path, Mock(side_effect=docker), None,
                   lambda workspace: ('sandbox-' + workspace, 'unused'),
                   lambda workspace: locks.setdefault(workspace, threading.RLock()),
                   SimpleNamespace(busy=lambda _owner: False), None)
    result.healthy = Mock(return_value=True)
    result.native_activity = Mock(return_value=dict(
        runningAgents=0, pendingMessages=0, runningJobs=0,
        activeSchedules=0, activeSidebarResources=0, activeSettingsWrites=0))
    result._cleanup_superseded = Mock()
    result.heartbeat = Mock()
    yield result
    close = getattr(result, 'close', None)
    if close:
        close()


def record(host, workspace):
    folder = host.root / workspace
    folder.mkdir()
    (host.root.parent / workspace).mkdir()
    value = dict(owner_id='test:' + workspace, workspace_id=workspace, generation=1,
                 instance_id='host-' + workspace, state='ready', ready=True,
                 endpoint='http://offline.invalid/' + workspace)
    path = folder / 'host.json'
    path.write_text(json.dumps(value), encoding='utf-8')
    return path


def test_slow_owner_does_not_delay_healthy_owners_next_heartbeat(host, monkeypatch):
    import hosts
    clock = [0]
    monkeypatch.setattr(hosts, 'time', SimpleNamespace(time=lambda: clock[0], monotonic=lambda: clock[0]))
    record(host, 'slow')
    record(host, 'healthy')
    entered, release = threading.Event(), threading.Event()
    original = host.docker.side_effect
    def slow_docker(*args, **kwargs):
        if args[:2] == ('inspect', 'host-slow'):
            entered.set()
            assert release.wait(5)
        return original(*args, **kwargs)
    host.docker.side_effect = slow_docker
    with ThreadPoolExecutor(max_workers=1) as caller:
        try:
            # A real caller must return while another owner's Docker read is
            # still pending. The previous whole-batch barrier fails here.
            caller.submit(host.maintain).result(timeout=1)
            assert entered.wait(1)
            host._maintenance_pending['healthy'].result(timeout=1)
            for tick in (10, 20, 30, 40, 50):
                clock[0] = tick
                caller.submit(host.maintain).result(timeout=1)
                host._maintenance_pending['healthy'].result(timeout=1)
            healthy = [call for call in host.heartbeat.call_args_list
                       if call.args[0]['workspace_id'] == 'healthy']
            assert len(healthy) == 6
            assert all(call.args[1] == 'ready' for call in healthy)
            assert sum(call.args[:2] == ('inspect', 'host-slow')
                       for call in host.docker.call_args_list) == 1
            assert not release.is_set()
        finally:
            release.set()


def test_full_capacity_stays_bounded_and_resumes_after_the_last_owner(host):
    releases = {f'{index:02}': threading.Event() for index in range(18)}
    started = {key: threading.Event() for key in releases}
    calls = []
    guard = threading.Lock()
    for key in releases:
        record(host, key)
    def worker(path):
        key = path.parent.name
        with guard:
            calls.append(key)
        started[key].set()
        assert releases[key].wait(5)
    host._maintain_one = worker
    try:
        pending = host.maintain()
        assert len(pending) == 16
        assert all(started[f'{index:02}'].wait(1) for index in range(16))
        for _ in range(20):
            assert len(host.maintain()) == 16
        assert len(calls) == 16
        assert not started['16'].is_set() and not started['17'].is_set()
        first = host._maintenance_pending['00']
        releases['00'].set()
        first.result(timeout=1)
        assert len(host.maintain()) == 16
        assert started['16'].wait(1)
        assert calls.count('00') == 1
        assert len(calls) == 17
        assert not started['17'].is_set()
    finally:
        for release in releases.values():
            release.set()


def test_manager_loop_keeps_ticking_while_another_owner_is_slow(host, monkeypatch):
    import hosts
    clock = [0]
    monkeypatch.setattr(hosts, 'time', SimpleNamespace(time=lambda: clock[0], monotonic=lambda: clock[0]))
    for key in ('healthy', 'slow'):
        record(host, key)
    entered, release = threading.Event(), threading.Event()
    original = host.docker.side_effect
    def slow_docker(*args, **kwargs):
        if args[:2] == ('inspect', 'host-slow'):
            entered.set()
            assert release.wait(5)
        return original(*args, **kwargs)
    host.docker.side_effect = slow_docker
    commands, rounds = Queue(), Queue()
    class StopLoop(Exception):
        pass
    def sleep(seconds):
        assert seconds == 10
        rounds.put(clock[0])
        next_tick = commands.get(timeout=5)
        if next_tick is None:
            raise StopLoop()
        clock[0] = next_tick
    # Execute the actual periodic function without importing the Linux-only
    # server startup dependencies or replacing its maintenance dispatch.
    path = Path(__file__).resolve().parents[1] / 'server.py'
    function = next(node for node in ast.parse(path.read_text(encoding='utf-8')).body
                    if isinstance(node, ast.FunctionDef) and node.name == 'maintain_hosts')
    logger = Mock()
    scope = dict(HOSTS=host, tick=Mock(), LOGGER=logger, time=SimpleNamespace(sleep=sleep))
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec'), scope)
    def manager():
        try:
            scope['maintain_hosts']()
        except StopLoop:
            pass
    with ThreadPoolExecutor(max_workers=1) as caller:
        running = caller.submit(manager)
        try:
            assert rounds.get(timeout=1) == 0
            assert entered.wait(1)
            host._maintenance_pending['healthy'].result(timeout=1)
            for tick in (10, 20, 30, 40, 50):
                commands.put(tick)
                assert rounds.get(timeout=1) == tick
                host._maintenance_pending['healthy'].result(timeout=1)
            assert sum(call.args[0]['workspace_id'] == 'healthy'
                       for call in host.heartbeat.call_args_list) == 6
            logger.exception.assert_not_called()
        finally:
            release.set()
            commands.put(None)
            running.result(timeout=1)


def test_unexpected_worker_failure_is_reaped_and_can_retry(host, caplog):
    record(host, 'one')
    host._maintain_one = Mock(side_effect=[RuntimeError('unexpected worker failure'), None])
    first, = host.maintain()
    with pytest.raises(RuntimeError, match='unexpected worker failure'):
        first.result(timeout=1)
    second, = host.maintain()
    second.result(timeout=1)
    assert host._maintain_one.call_count == 2
    assert 'Host maintenance worker failed for workspace one' in caplog.text


def test_failed_thread_start_cancels_enqueued_work_before_retry(host, monkeypatch):
    record(host, 'one')
    host._maintain_one = Mock()
    retired = host._maintenance_pool
    def cannot_start():
        raise RuntimeError('cannot start new thread')
    monkeypatch.setattr(retired, '_adjust_thread_count', cannot_start)
    with pytest.raises(RuntimeError, match='cannot start new thread'):
        host.maintain()
    host._maintain_one.assert_not_called()
    for future in host.maintain():
        future.result(timeout=1)
    host._maintain_one.assert_called_once()
    with pytest.raises(RuntimeError, match='shutdown'):
        retired.submit(lambda: None)


def test_failed_submit_retains_an_owner_that_started_before_the_exception(host, monkeypatch):
    for key in ('00', '01'):
        record(host, key)
    release_first, second_started, release_second = (threading.Event() for _ in range(3))
    counts = {'00': 0, '01': 0}
    def worker(path):
        key = path.parent.name
        counts[key] += 1
        if key == '00':
            assert release_first.wait(5)
        else:
            second_started.set()
            assert release_second.wait(5)
    host._maintain_one = worker
    pool = host._maintenance_pool
    adjust = pool._adjust_thread_count
    attempts = [0]
    def fail_after_enqueue():
        attempts[0] += 1
        if attempts[0] == 1:
            return adjust()
        release_first.set()
        # The existing worker can dequeue the second owner before submit's
        # attempt to start another thread fails. That owner remains in-flight.
        assert second_started.wait(1)
        raise RuntimeError('cannot start new thread')
    monkeypatch.setattr(pool, '_adjust_thread_count', fail_after_enqueue)
    try:
        with pytest.raises(RuntimeError, match='cannot start new thread'):
            host.maintain()
        second = host._maintenance_pending['01']
        assert second.running()
        for _ in range(20):
            host.maintain()
        assert host._maintenance_pending['01'] is second
        assert counts['01'] == 1
    finally:
        release_first.set()
        release_second.set()


def test_close_stops_new_dispatch_and_waits_for_the_running_lifecycle(host, monkeypatch):
    record(host, 'one')
    entered, release = threading.Event(), threading.Event()
    def worker(_path):
        entered.set()
        assert release.wait(5)
    host._maintain_one = Mock(side_effect=worker)
    pending, = host.maintain()
    assert entered.wait(1)
    shutting_down = threading.Event()
    shutdown = host._maintenance_pool.shutdown
    def observed_shutdown(**kwargs):
        shutting_down.set()
        shutdown(**kwargs)
    monkeypatch.setattr(host._maintenance_pool, 'shutdown', observed_shutdown)
    with ThreadPoolExecutor(max_workers=1) as caller:
        closing = caller.submit(host.close)
        try:
            assert shutting_down.wait(1)
            assert host.maintain() == ()
            assert not closing.done()
        finally:
            release.set()
        closing.result(timeout=1)
    assert pending.done()
    assert host.maintain() == ()
    assert host._maintain_one.call_count == 1
    with pytest.raises(RuntimeError, match='shutdown'):
        host._maintenance_pool.submit(lambda: None)


def test_close_cancels_work_that_has_not_started(host):
    # A queued task is possible while a pool is still starting its threads.
    # Use one worker to hold that boundary deterministically.
    host._maintenance_pool.shutdown()
    host._maintenance_pool = ThreadPoolExecutor(max_workers=1)
    for key in ('first', 'queued'):
        record(host, key)
    entered, release, cancelled = (threading.Event() for _ in range(3))
    def worker(_path):
        entered.set()
        assert release.wait(5)
    host._maintain_one = Mock(side_effect=worker)
    host.maintain()
    assert entered.wait(1)
    queued = host._maintenance_pending['queued']
    queued.add_done_callback(lambda _future: cancelled.set())
    with ThreadPoolExecutor(max_workers=1) as caller:
        closing = caller.submit(host.close)
        try:
            assert cancelled.wait(1)
            assert queued.cancelled()
            assert host.maintain() == ()
        finally:
            release.set()
        closing.result(timeout=1)
    assert host._maintain_one.call_count == 1


@pytest.mark.parametrize('state', ['fencing', 'ready'])
def test_replaced_or_fenced_identity_is_not_overwritten_by_an_old_probe(host, state):
    path = record(host, 'one')
    entered, release = threading.Event(), threading.Event()
    def health(_endpoint):
        entered.set()
        assert release.wait(5)
        return True
    host.healthy.side_effect = health
    pending, = host.maintain()
    try:
        assert entered.wait(1)
        with host.lock('one'):
            current = json.loads(path.read_text(encoding='utf-8'))
            current.update(generation=2, instance_id='host-new', state=state)
            path.write_text(json.dumps(current), encoding='utf-8')
    finally:
        release.set()
    pending.result(timeout=1)
    assert json.loads(path.read_text(encoding='utf-8')) == current
    host.heartbeat.assert_not_called()
    for future in host.maintain():
        future.result(timeout=1)
    if state == 'ready':
        host.heartbeat.assert_called_once()
        assert host.heartbeat.call_args.args[0]['generation'] == 2
        assert host.heartbeat.call_args.args[0]['instance_id'] == 'host-new'
    else:
        host.heartbeat.assert_not_called()
