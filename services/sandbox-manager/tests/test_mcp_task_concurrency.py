"""Task cancellation uses the existing transport while status IO is in flight."""
import json
import queue
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import mcp_runtime as runtime
import mcp_policy


@pytest.mark.parametrize('read_method', ['tasks/get', 'tasks/result'])
def test_cancel_bypasses_saturated_admission_without_reusing_the_query_response(monkeypatch, read_method):
    key, name = 'cancel-owner', 'demo'
    entered, release = threading.Event(), threading.Event()
    worker = SimpleNamespace(token='connection', version='v1', process=SimpleNamespace(poll=lambda: None),
                             pending_guard=threading.Lock(), pending_responses={}, eof=threading.Event())
    worker.close = Mock(return_value=True)
    def send(payload, cancelled, on_dispatch):
        on_dispatch()
        if payload['method'] == read_method:
            entered.set()
        else:
            worker.pending_responses[payload['request_id']].put({'result': {'taskId': 'one', 'status': 'cancelled'}, 'tasks_active_until': 0})
    def response(cancelled, timeout, request_id):
        if not worker.pending_responses[request_id].empty():
            return worker.pending_responses[request_id].get()
        assert release.wait(3)
        return {'result': {'taskId': 'one', 'status': 'working'}, 'tasks_active_until': 0}
    worker.send, worker.response = send, response
    monkeypatch.setitem(runtime.WORKERS, (key, name), worker)
    monkeypatch.setattr(runtime, 'validate_grant', lambda *args: 'run')
    monkeypatch.setattr(runtime, 'record_pending', lambda *args: None)
    monkeypatch.setattr(runtime, 'complete_call', lambda *args: None)
    monkeypatch.setattr(mcp_policy, '_policy', {**mcp_policy.current(), 'max_active_calls': 1, 'max_owner_calls': 1})
    state = {'version': 'v1', 'enabled': True, 'timeout': 5}
    def invoke(method, **changes):
        return runtime.invoke(key, 'unused', {'operation': 'mcp_task', 'name': name, 'version': 'v1', 'tool': 'report',
            'method': method, 'params': {'taskId': 'one'}, 'authorization': {}, 'connection_id': 'connection', **changes},
            state, authorize=lambda _: True)
    try:
        with ThreadPoolExecutor() as executor:
            query = executor.submit(invoke, read_method)
            assert entered.wait(2)
            assert invoke('tasks/get', connection_id='forged')['code'] == 'MCP_BUSY'
            cancelled = invoke('tasks/cancel')
            assert cancelled['result']['status'] == 'cancelled'
            assert not query.done()
            release.set()
            assert query.result(2)['result']['status'] == 'working'
            assert worker.pending_responses == {}
            assert worker.tasks_active_until == 0
        worker.close.assert_not_called()
    finally:
        release.set()
        runtime.WORKERS.pop((key, name), None)
        runtime.LAST_USED.pop((key, name), None)


def test_correlated_reader_discards_late_responses_and_wakes_pending_on_eof():
    import io
    worker = object.__new__(runtime.Worker)
    worker.token = 'token'
    worker.responses, worker.pending_responses = queue.Queue(2), {'cancel': queue.Queue(1)}
    worker.pending_guard, worker.eof, worker.fenced = threading.Lock(), threading.Event(), threading.Event()
    frames = [{'request_id': 'expired-query', 'result': {'status': 'working'}},
              {'request_id': 'cancel', 'result': {'status': 'cancelled'}}]
    worker.process = SimpleNamespace(stdout=io.BytesIO(b''.join(json.dumps(frame).encode() + b'\n' for frame in frames)))
    worker._read()
    assert worker.pending_responses['cancel'].get()['result']['status'] == 'cancelled'
    assert worker.responses.get()['uncertain']
    assert worker.eof.is_set()


def test_missing_or_unauthorized_cancel_does_not_start_a_connection(monkeypatch):
    monkeypatch.setattr(runtime, 'validate_grant', lambda *args: 'run')
    start = Mock()
    monkeypatch.setattr(runtime, 'Worker', start)
    result = runtime.invoke('cancel-missing', 'unused', {'operation': 'mcp_task', 'name': 'demo', 'version': 'v1',
        'tool': 'report', 'method': 'tasks/cancel', 'authorization': {}, 'connection_id': 'lost'},
        {'version': 'v1', 'enabled': True, 'timeout': 5}, authorize=lambda _: False)
    assert '失效' in result['error']
    start.assert_not_called()


def test_a_partial_query_frame_is_not_mistaken_for_a_recoverable_read_timeout(monkeypatch):
    key, name = 'partial-query', 'demo'
    worker = Mock(token='connection', version='v1', process=SimpleNamespace(poll=lambda: None),
                  pending_guard=threading.Lock(), pending_responses={}, eof=threading.Event())
    worker.close.return_value = True
    def partial_send(payload, cancelled, on_dispatch):
        on_dispatch()
        time.sleep(.05)
        return {'error': 'partial frame', 'uncertain': True}
    worker.send = partial_send
    monkeypatch.setitem(runtime.WORKERS, (key, name), worker)
    monkeypatch.setattr(runtime, 'validate_grant', lambda *args: 'run')
    monkeypatch.setattr(runtime, 'record_pending', Mock())
    result = runtime.invoke(key, 'container', {'operation': 'mcp_task', 'name': name, 'version': 'v1', 'tool': 'report',
        'method': 'tasks/get', 'params': {'taskId': 'one'}, 'authorization': {}, 'connection_id': 'connection',
        'deadline_ms': time.time()*1000 + 25}, {'version': 'v1', 'enabled': True, 'timeout': 5}, authorize=lambda _: True)
    assert result.get('uncertain') is True
    assert (key, name) not in runtime.WORKERS
    worker.response.assert_not_called()
    worker.close.assert_called_once()
    runtime.record_pending.assert_not_called()
    runtime.LAST_USED.pop((key, name), None)
