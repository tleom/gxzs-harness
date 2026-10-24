"""Skill jobs share MCP supervision and retain a capacity slot until settlement."""
import importlib
import threading

import pytest


@pytest.fixture
def runtime(monkeypatch):
    import skill_import_runtime
    module = importlib.reload(skill_import_runtime)
    monkeypatch.setattr(module, 'module_source', lambda *args: '')
    yield module
    module.CALLS.clear()


def test_async_job_uses_mcp_worker_identity_and_releases_capacity(runtime, monkeypatch):
    released = threading.Event()
    state = {'import_id': 'a' * 32, 'status': 'ready'}
    created = []
    class Worker:
        def __init__(self, *args, **kwargs):
            assert kwargs['token'] == state['import_id']
            assert kwargs['interpreter'] == '/usr/local/bin/python'
            created.append(self)
            self.sent = False
        def response(self, *args, **kwargs):
            if not self.sent:
                return {'ready': True}
            state.update(status='completed', id='demo', version='v1')
            return dict(state)
        def send(self, payload, *args):
            assert payload['arguments']['name'] == 'demo'
            self.sent = True
        def close(self):
            return True
    monkeypatch.setattr(runtime, 'Worker', Worker)
    monkeypatch.setattr(runtime, 'control', lambda *args, **kwargs: dict(state))
    payload = {'import_id': state['import_id'], 'name': 'demo', 'version': None}
    assert runtime.invoke('owner', 'container', payload, on_finish=released.set)['status'] == 'running'
    assert released.wait(2)
    assert runtime.status('owner', 'container', payload)['status'] == 'completed'
    assert len(created) == 1 and not runtime.CALLS


def test_stop_during_startup_prevents_dispatch_and_duplicate_worker(runtime, monkeypatch):
    ready, stopped, released = threading.Event(), threading.Event(), threading.Event()
    payload = {'import_id': 'b' * 32, 'name': 'demo', 'version': None}
    state = {'import_id': payload['import_id'], 'status': 'ready'}
    sent = []
    class Worker:
        def __init__(self, *args, **kwargs):
            ready.set()
        def response(self, cancelled, **kwargs):
            assert stopped.wait(2)
            return {'uncertain': True}
        def send(self, *args):
            sent.append(args)
        def close(self):
            stopped.set()
            return True
    def control(*args, cancel=False):
        if cancel:
            state['status'] = 'cancelled'
        return dict(state)
    monkeypatch.setattr(runtime, 'Worker', Worker)
    monkeypatch.setattr(runtime, 'control', control)
    runtime.invoke('owner', 'container', payload, on_finish=released.set)
    assert ready.wait(2)
    assert runtime.status('owner', 'container', payload)['status'] == 'running'
    duplicate_finished = threading.Event()
    runtime.invoke('owner', 'container', payload, on_finish=duplicate_finished.set)
    assert duplicate_finished.is_set()
    assert runtime.cancel('owner', 'container', payload)['status'] == 'cancelled'
    assert released.wait(2)
    assert not sent


def test_invalid_identity_and_thread_start_failure_return_capacity(runtime, monkeypatch):
    released = []
    with pytest.raises(ValueError):
        runtime.invoke('owner', 'container', {'import_id': '../bad'}, on_finish=lambda: released.append(1))
    assert released == [1]
    monkeypatch.setattr(runtime, 'control', lambda *args: {'status': 'ready'})
    monkeypatch.setattr(threading.Thread, 'start', lambda *_: (_ for _ in ()).throw(RuntimeError('no threads')))
    with pytest.raises(RuntimeError):
        runtime.invoke('owner', 'container', {'import_id': 'c' * 32}, on_finish=lambda: released.append(2))
    assert released == [1, 2] and not runtime.CALLS


def test_unconfirmed_worker_stop_retains_capacity_until_reaped(runtime, monkeypatch):
    released, closed = threading.Event(), threading.Event()
    fenced = [False]
    class Worker:
        def __init__(self, *args, **kwargs):
            pass
        def response(self, *args, **kwargs):
            return {'uncertain': True}
        def close(self):
            closed.set()
            return fenced[0]
    monkeypatch.setattr(runtime, 'Worker', Worker)
    monkeypatch.setattr(runtime, 'control', lambda *args, **kwargs: {'status': 'unknown' if kwargs.get('cancel') else 'ready'})
    payload = {'import_id': 'e' * 32}
    runtime.invoke('owner', 'container', payload, on_finish=released.set)
    assert closed.wait(2)
    # Joining the actual job avoids asserting before its finally block.
    import time
    deadline = time.monotonic() + 2
    while not next(iter(runtime.CALLS.values()))['closing'] and time.monotonic() < deadline:
        time.sleep(.01)
    runtime.reap_calls()
    assert runtime.CALLS and not released.is_set()
    fenced[0] = True
    runtime.reap_calls()
    assert released.is_set() and not runtime.CALLS


def test_cleanup_batch_uses_shared_budget_and_retries_oldest_worker_first(runtime, monkeypatch):
    now, attempted = [0], []
    monkeypatch.setattr(runtime.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(runtime, 'policy', lambda key: 1)
    class Worker:
        def __init__(self, last):
            self.last_close_attempt = last
        def close(self):
            attempted.append(self.last_close_attempt)
            now[0] += 2
            return False
    for name, last in [('recent', 10), ('oldest', 1)]:
        runtime.CALLS[name] = {'closing': True, 'close_lock': threading.Lock(), 'worker': Worker(last)}
    runtime.reap_calls()
    assert attempted == [1] and len(runtime.CALLS) == 2


def test_confirmed_workspace_stop_releases_only_its_closing_skill_jobs(runtime):
    released = []
    class Worker:
        def __init__(self):
            self.fenced = threading.Event()
        def close(self):
            return self.fenced.is_set()
    for owner in ['stopped', 'other']:
        runtime.CALLS[(owner, 'a' * 32)] = {'worker': Worker(), 'closing': True,
            'cancelled': threading.Event(), 'close_lock': threading.Lock(),
            'on_finish': lambda owner=owner: released.append(owner)}
    runtime.fence_workspace('stopped')
    runtime.fence_workspace('stopped')
    assert released == ['stopped']
    assert list(runtime.CALLS) == [('other', 'a' * 32)]


def test_workspace_stop_during_worker_startup_prevents_dispatch_and_releases_once(runtime, monkeypatch):
    constructing, resume, released = threading.Event(), threading.Event(), threading.Event()
    sent = []
    class Worker:
        def __init__(self, *args, **kwargs):
            self.fenced = threading.Event()
            constructing.set()
            assert resume.wait(3)
        def response(self, *args, **kwargs):
            return {'ready': True}
        def send(self, *args):
            sent.append(args)
        def close(self):
            return self.fenced.is_set()
    monkeypatch.setattr(runtime, 'Worker', Worker)
    monkeypatch.setattr(runtime, 'control', lambda *args, **kwargs: {'status': 'cancelled' if kwargs.get('cancel') else 'ready'})
    runtime.invoke('owner', 'container', {'import_id': '1' * 32}, on_finish=released.set)
    assert constructing.wait(3)
    runtime.fence_workspace('owner')
    assert not released.is_set()
    resume.set()
    assert released.wait(3)
    assert not sent and not runtime.CALLS
