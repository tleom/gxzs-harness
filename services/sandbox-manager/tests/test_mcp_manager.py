"""Manager scheduling, authorization and repeated calls with bounded fake IO."""

import importlib.util
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest


@pytest.fixture
def manager(tmp_path, monkeypatch):
    base = Path(__file__).parents[1]
    monkeypatch.syspath_prepend(str(base))
    monkeypatch.setenv("WORKBENCH_SANDBOX_MANAGER_TOKEN", "test-manager-token")
    monkeypatch.setenv("WORKBENCH_MANAGER_STATE", str(tmp_path))
    spec = importlib.util.spec_from_file_location(
        "tested_mcp_manager", base / "server.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    import mcp_runtime

    calls, entered = [], threading.Event()

    class Worker:
        def __init__(self, container, name, version, timeout, *, deadline=None):
            self.version, self.ready = version, None
            self.process = SimpleNamespace(poll=lambda: None)
            self.closed, self.pending = threading.Event(), None

        def response(self, cancelled=None, timeout=None):
            if self.ready is None:
                return {"ready": True}
            if self.pending.get("tool") == "slow":
                assert self.closed.wait(4), "test did not stop the in-flight request"
                return {"error": "stopped", "uncertain": True}
            return {"result": {"value": "ok"}}

        def send(self, payload, cancelled=None, on_dispatch=None):
            self.pending = payload
            if on_dispatch:
                on_dispatch()
            calls.append(payload)
            entered.set()

        def close(self, *, deadline=None):
            self.closed.set()
            return True

    def docker(*args, stdin=None, **kwargs):
        if args[0] == "ps":
            # This fixture has MCP workers but no planning containers.
            return SimpleNamespace(returncode=0, stdout="")
        if args[0] == "inspect":
            return SimpleNamespace(
                returncode=0, stdout=json.dumps([{"State": {"Running": True}}])
            )
        payload = json.loads(stdin)
        result = {"version": "v1", "enabled": True, "timeout": 5}
        if "binding_id" in payload:
            result = {"stopped": 0}
        elif payload["operation"] == "mcp_list":
            result = {"mcp": []}
        return SimpleNamespace(returncode=0, stdout=json.dumps(result))

    monkeypatch.setattr(module, "ensure", lambda _, **kwargs: None)
    monkeypatch.setattr(module, "docker", docker)
    monkeypatch.setattr(mcp_runtime, "Worker", Worker)
    monkeypatch.setattr(module, "authorize_mcp", lambda _: True)
    yield module, mcp_runtime, calls, entered
    for key, _ in list(mcp_runtime.WORKERS):
        mcp_runtime.invalidate(key)
    assert not mcp_runtime.ACTIVE


def payload(key, binding, *, tool="slow", request="call-1"):
    return {
        "operation": "mcp_call",
        "name": "demo",
        "version": "v1",
        "manifest_version": "m1",
        "tool": tool,
        "arguments": {},
        "request_key": binding + ':' + request,
        "authorization": {"workspace_id": key, "binding_id": binding, "run_id": binding,
                          "request_key": request, "resource_id": 'personal:mcp:demo:' + tool,
                          "version": "v1", "manifest_version": "m1", "arguments": {}},
    }


def test_background_catalog_refresh_keeps_each_observed_version(manager, monkeypatch):
    module, _, _, _ = manager
    pending, observed = [], []

    class DeferredThread:
        def __init__(self, target, **kwargs):
            self.target = target

        def start(self):
            pending.append(self.target)

    monkeypatch.setattr(module.threading, "Thread", DeferredThread)
    monkeypatch.setattr(module, "operation", lambda key, resource, body: observed.append((key, resource, body)))
    key = str(uuid4())
    module.schedule_mcp_refresh(key, [
        {"id": "first", "enabled": True, "status": "unverified", "version": "v1"},
        {"id": "second", "enabled": True, "status": "ready", "refresh_due": True, "version": "v2", "discovered_at": 123},
    ])
    for target in pending:
        target()
    assert [(body["name"], body["version"]) for _, _, body in observed] == [("first", "v1"), ("second", "v2")]
    assert all(owner == key and resource == "personal-mcp" and body["operation"] == "mcp_test" for owner, resource, body in observed)
    assert observed[1][2]["catalog_discovered_at"] == 123
    assert not module.MCP_REFRESHING


def test_stop_and_catalog_do_not_wait_for_business_call_and_queued_calls_reauthorize(
    manager, monkeypatch
):
    module, runtime, calls, entered = manager
    key, first, second = [str(uuid4()) for _ in range(3)]
    allowed = {first: True, second: True}
    monkeypatch.setattr(
        module, "authorize_mcp", lambda auth: allowed[auth['authorization']["binding_id"]]
    )
    with ThreadPoolExecutor(max_workers=3) as pool:
        active = pool.submit(module.operation, key, "personal-mcp", payload(key, first))
        assert entered.wait(2)
        queued = pool.submit(
            module.operation,
            key,
            "personal-mcp",
            payload(key, second, tool="fast", request="call-2"),
        )
        deadline = time.monotonic() + 2
        while len(runtime.ACTIVE) < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert len(runtime.ACTIVE) == 2
        assert module.operation(key, "personal-mcp", {"operation": "mcp_list"}) == {
            "mcp": []
        }
        allowed[second] = False
        started = time.monotonic()
        assert module.operation(key, "stop-binding", {"binding_id": first})["fenced"]
        assert time.monotonic() - started < 1
        assert active.result()["uncertain"]
        assert "失效" in queued.result()["error"]
    assert len(calls) == 1


@pytest.mark.parametrize('maintenance', [True, False])
def test_refresh_defers_or_waits_without_cancelling_inflight_call(manager, monkeypatch, maintenance):
    module, runtime, calls, entered = manager
    key, binding = str(uuid4()), str(uuid4())
    release = threading.Event()
    original = runtime.Worker.response

    def response(worker, cancelled=None, timeout=None):
        if worker.ready is not None and worker.pending.get("tool") == "slow":
            assert release.wait(4)
            assert not worker.closed.is_set() and not cancelled.is_set()
            return {"result": {"value": "finished"}}
        return original(worker, cancelled, timeout)

    monkeypatch.setattr(runtime.Worker, "response", response)
    with ThreadPoolExecutor(max_workers=2) as pool:
        active = pool.submit(module.operation, key, "personal-mcp", payload(key, binding))
        assert entered.wait(2)
        worker = runtime.WORKERS[(key, "demo")]
        request = {"operation": "mcp_test", "name": "demo", "version": "v1", "maintenance": maintenance}
        refresh = pool.submit(module.operation, key, "personal-mcp", request)
        try:
            if maintenance:
                assert refresh.result(timeout=1)["code"] == "MCP_BUSY"
            else:
                deadline = time.monotonic() + 2
                while len([call for call in runtime.ACTIVE if call.key == key]) < 2 and not refresh.done() and time.monotonic() < deadline:
                    time.sleep(.01)
                assert not refresh.done()
            assert not worker.closed.is_set()
        finally:
            release.set()
        assert active.result()["result"]["value"] == "finished"
        refresh.result()
        if maintenance:
            assert module.operation(key, "personal-mcp", request)["result"]["value"] == "ok"
    assert worker.closed.is_set() and runtime.WORKERS[(key, "demo")] is not worker
    assert [call["operation"] for call in calls] == ["mcp_call", "mcp_test"]


def test_background_refresh_defers_when_preflight_used_connection_budget(manager):
    module, runtime, calls, _ = manager
    key, binding = str(uuid4()), str(uuid4())
    module.operation(key, "personal-mcp", payload(key, binding, tool="fast"))
    worker = runtime.WORKERS[(key, "demo")]
    result = module.operation(key, "personal-mcp", {
        "operation": "mcp_test", "name": "demo", "version": "v1", "maintenance": True,
        "deadline_ms": int(time.time() * 1000) + 1000,
    })
    assert result["code"] == "MCP_BUSY"
    assert not worker.closed.is_set()
    assert len(calls) == 1


def test_refresh_failure_records_cache_failure_but_capacity_wait_does_not(manager, monkeypatch):
    module, runtime, _, _ = manager
    writes = []
    original = module.docker
    def docker(*args, stdin=None, **kwargs):
        if stdin is not None and json.loads(stdin).get("operation") == "mcp_cache_failure":
            writes.append(json.loads(stdin))
            return SimpleNamespace(returncode=0, stdout='{}')
        return original(*args, stdin=stdin, **kwargs)
    monkeypatch.setattr(module, "docker", docker)
    request = {"operation": "mcp_test", "name": "demo", "version": "v1", "maintenance": True, "catalog_discovered_at": 123}
    monkeypatch.setattr(runtime, "invoke", lambda *a, **k: {"error": "busy", "code": "MCP_BUSY"})
    module.operation(str(uuid4()), "personal-mcp", request)
    assert not writes
    monkeypatch.setattr(runtime, "invoke", lambda *a, **k: {"error": "discovery failed"})
    module.operation(str(uuid4()), "personal-mcp", request)
    assert writes == [{"operation": "mcp_cache_failure", "name": "demo", "version": "v1", "discovered_at": 123}]


def test_stop_cancels_only_its_binding_and_other_server_can_complete(manager):
    module, _, calls, entered = manager
    key, first, second = [str(uuid4()) for _ in range(3)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        active = pool.submit(module.operation, key, "personal-mcp", payload(key, first))
        assert entered.wait(2)
        other = {**payload(key, second, tool="fast", request="call-2"), "name": "other"}
        other['authorization']['resource_id'] = 'personal:mcp:other:fast'
        assert module.operation(key, "personal-mcp", other)["result"]["value"] == "ok"
        module.operation(key, "stop-binding", {"binding_id": second})
        assert not active.done()
        module.operation(key, "stop-binding", {"binding_id": first})
        assert active.result()["uncertain"]
    assert len(calls) == 2


def test_stop_during_final_authorization_prevents_dispatch(manager, monkeypatch):
    module, _, calls, _ = manager
    key, binding = str(uuid4()), str(uuid4())
    checking, resume = threading.Event(), threading.Event()
    checks = 0

    def authorize(_):
        nonlocal checks
        checks += 1
        if checks == 2:
            checking.set()
            assert resume.wait(3)
        return True

    monkeypatch.setattr(module, "authorize_mcp", authorize)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(
            module.operation,
            key,
            "personal-mcp",
            payload(key, binding, tool="fast"),
        )
        try:
            assert checking.wait(2)
            assert module.operation(key, "stop-binding", {"binding_id": binding})[
                "fenced"
            ]
        finally:
            resume.set()
        assert "未执行" in pending.result()["error"]
    assert not calls


def test_new_grant_can_repeat_same_tool_call_without_replay_suppression(manager, monkeypatch):
    module, _, calls, _ = manager
    key, binding = str(uuid4()), str(uuid4())
    request = payload(key, binding, tool='fast')
    request['authorization']['jti'] = 'nonce-one'
    consumed, actions = set(), []
    def authorize(callback):
        actions.append(callback['action'])
        nonce = callback['authorization']['jti']
        if callback['action'] == 'validate':
            return True
        if nonce in consumed:
            return False
        consumed.add(nonce)
        return True
    monkeypatch.setattr(module, 'authorize_mcp', authorize)
    first = module.operation(key, 'personal-mcp', request)
    request['authorization']['jti'] = 'nonce-two'
    assert module.operation(key, 'personal-mcp', request) == first
    assert len(calls) == 2
    assert actions == ['validate', 'consume', 'validate', 'consume']
    assert consumed == {'nonce-one', 'nonce-two'}


@pytest.mark.parametrize('field,value', [('tool', 'other'), ('arguments', {'x': 1}), ('manifest_version', 'm2'), ('request_key', 'other'), ('deadline_ms', 1)])
def test_payload_cannot_change_signed_operation(manager, field, value):
    module, _, calls, _ = manager
    key, binding = str(uuid4()), str(uuid4())
    request = payload(key, binding, tool='fast')
    request[field] = value
    with pytest.raises(ValueError):
        module.operation(key, 'personal-mcp', request)
    assert not calls


def test_java_grant_fixture_reaches_worker_and_has_exact_callbacks(manager, monkeypatch):
    module, _, calls, _ = manager
    fixture = json.loads((Path(__file__).parent / 'fixtures' / 'mcp-grant-v2.json').read_text(encoding='utf-8'))
    monkeypatch.setattr(time, 'time', lambda: fixture['issued_at_ms'] / 1000)
    callbacks = []
    monkeypatch.setattr(module, 'authorize_mcp', lambda request: (callbacks.append(request), True)[1])
    result = module.operation(fixture['authorization']['workspace_id'], 'personal-mcp', fixture['manager_payload'])
    assert result['result']['value'] == 'ok'
    assert callbacks == [fixture['validate_callback'], fixture['consume_callback']]
    assert len(calls) == 1


def test_grant_does_not_equate_boolean_and_number(manager):
    module, _, calls, _ = manager
    key, binding = str(uuid4()), str(uuid4())
    request = payload(key, binding, tool='fast')
    request['arguments'] = {'confirm': 1}
    request['authorization']['arguments'] = {'confirm': True}
    with pytest.raises(ValueError):
        module.operation(key, 'personal-mcp', request)
    assert not calls


def test_expired_deadline_never_creates_worker_or_dispatches(manager):
    module, _, calls, _ = manager
    key, binding = str(uuid4()), str(uuid4())
    request = payload(key, binding, tool='fast')
    request['deadline_ms'] = request['authorization']['deadline_ms'] = int(time.time() * 1000) - 1
    assert '未执行' in module.operation(key, 'personal-mcp', request)['error']
    assert not calls


def test_worker_wire_payload_keeps_utf8_arguments_within_frame_limit():
    from io import BytesIO
    from mcp_runtime import Worker
    worker = object.__new__(Worker)
    worker.close_guard = threading.Lock()
    worker.write_guard = threading.Lock()
    worker.process = SimpleNamespace(stdin=BytesIO())
    arguments = {'query': '中' * 340000}
    request = {'operation': 'mcp_call', 'tool': 'search', 'arguments': arguments,
               'manifest_version': 'm1', 'authorization': {'arguments': arguments, 'signature': 'secret'}}
    assert Worker.send(worker, request) is None
    encoded = worker.process.stdin.getvalue()
    assert len(encoded) < 2 * 1024 * 1024
    decoded = json.loads(encoded)
    assert decoded['arguments'] == arguments
    assert 'authorization' not in decoded


def test_stop_does_not_confirm_unfinished_personal_worker(manager):
    module, runtime, _, _ = manager
    key, binding = str(uuid4()), str(uuid4())
    class PendingWorker:
        stopped = False
        def close(self, *, deadline=None):
            return self.stopped
    worker = PendingWorker()
    runtime.CLOSING[worker] = (key, 'demo', binding)
    assert module.operation(key, 'stop-binding', {'binding_id': binding})['fenced'] is False
    assert module.operation(key, 'stop-binding', {'binding_id': binding})['fenced'] is False
    worker.stopped = True
    assert module.operation(key, 'stop-binding', {'binding_id': binding})['fenced'] is True
    assert worker not in runtime.CLOSING


def test_real_worker_close_keeps_unconfirmed_client_for_later_check():
    import subprocess
    from io import BytesIO
    from unittest.mock import Mock
    from mcp_runtime import Worker
    worker = object.__new__(Worker)
    worker.close_guard, worker.closed = threading.Lock(), False
    worker.process = SimpleNamespace(stdin=BytesIO(), returncode=None,
        wait=Mock(side_effect=subprocess.TimeoutExpired('docker', 5)), terminate=Mock())
    assert worker.close() is False
    worker.process.terminate.assert_not_called()


def test_cleanup_works_when_new_threads_cannot_start(manager, monkeypatch):
    _, runtime, _, _ = manager
    key = str(uuid4())
    class Closing:
        def close(self, *, deadline=None): return True
    worker = Closing()
    runtime.CLOSING[worker] = (key, 'demo', None)
    monkeypatch.setattr(threading.Thread, 'start', lambda self: (_ for _ in ()).throw(RuntimeError('cannot start thread')))
    assert runtime.close_workers([worker])
    assert worker not in runtime.CLOSING


def test_catalog_thread_failure_does_not_leave_permanent_refresh_marker(manager, monkeypatch):
    module, _, _, _ = manager
    key = str(uuid4())
    monkeypatch.setattr(threading.Thread, 'start', lambda self: (_ for _ in ()).throw(RuntimeError('cannot start thread')))
    module.schedule_mcp_refresh(key, [{'enabled':True,'status':'unverified','version':'v1','id':'demo'}])
    assert (key, 'demo') not in module.MCP_REFRESHING


def test_reader_start_failure_closes_pipe_and_retains_partial_worker(monkeypatch):
    from io import BytesIO
    import mcp_runtime as runtime
    process = SimpleNamespace(stdin=BytesIO(), stdout=BytesIO())
    monkeypatch.setattr(runtime.subprocess, 'Popen', lambda *args, **kwargs: process)
    monkeypatch.setattr(threading.Thread, 'start', lambda self: (_ for _ in ()).throw(RuntimeError('cannot start thread')))
    with pytest.raises(runtime.WorkerStartError) as error:
        runtime.Worker('sandbox', 'demo', 'v1', 5)
    assert process.stdin.closed
    assert error.value.worker.process is process
    assert len(error.value.worker.token) == 32


def test_idle_cache_reaper_retains_active_workers_and_limits_idle_owner_connections(manager):
    _, runtime, _, _ = manager
    key = str(uuid4())
    identities = [(key, str(index)) for index in range(6)]
    for identity in identities:
        runtime.WORKERS[identity] = runtime.Worker('sandbox', identity[1], 'v1', 5)
        runtime.LAST_USED[identity] = time.monotonic()
    busy = type('Busy', (), {'key':key,'name':'0'})()
    runtime.ACTIVE.add(busy)
    try:
        runtime.reap_workers(max_owner_workers=4)
        assert len(runtime.WORKERS) == 4
        assert identities[0] in runtime.WORKERS
        assert not runtime.CLOSING
    finally:
        runtime.ACTIVE.discard(busy)


def test_saturated_business_capacity_keeps_root_cancel_available(manager, monkeypatch):
    from io import BytesIO
    from unittest.mock import Mock
    module, _, _, _ = manager
    capacity = threading.BoundedSemaphore(1)
    capacity.acquire()
    monkeypatch.setattr(module, 'OPERATION_CAPACITY', capacity)
    operation = Mock(return_value={'fenced': True})
    monkeypatch.setattr(module, 'operation', operation)
    def request(action, token=module.TOKEN):
        handler = object.__new__(module.Handler)
        body = json.dumps({'binding_id': str(uuid4())}).encode()
        handler.path = '/sandboxes/' + str(uuid4()) + '/' + action
        handler.headers = {'Authorization': 'Bearer ' + token, 'Content-Length': str(len(body))}
        handler.rfile, handler.wfile = BytesIO(body), BytesIO()
        handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
        handler.do_POST()
        return handler.send_response.call_args.args[0]
    assert request('personal-mcp') == 503
    assert request('stop-binding') == 200
    assert request('stop-binding', 'invalid') == 403
    assert operation.call_count == 1
    capacity.release()


def test_stop_plain_text_or_known_complete_tool_is_not_uncertain(manager):
    module, _, _, _ = manager
    key, text_binding, known_binding = [str(uuid4()) for _ in range(3)]
    assert module.operation(key, 'stop-binding', {'binding_id': text_binding}) == {'stopped': 0, 'fenced': True, 'uncertain': False}
    module.operation(key, 'personal-mcp', payload(key, known_binding, tool='fast'))
    result = module.operation(key, 'stop-binding', {'binding_id': known_binding})
    assert result['fenced'] is True and result['uncertain'] is False
    assert module.operation(key, 'stop-binding', {'binding_id': known_binding})['uncertain'] is False


def test_stop_still_cancels_when_outcome_database_is_unavailable(manager, monkeypatch):
    import sqlite3
    import mcp_outcomes
    module, _, _, _ = manager
    monkeypatch.setattr(mcp_outcomes, 'has_unconfirmed',
                        lambda *_: (_ for _ in ()).throw(sqlite3.OperationalError('locked')))
    key, binding = str(uuid4()), str(uuid4())
    result = module.operation(key, 'stop-binding', {'binding_id': binding})
    assert result['fenced'] is True and result['uncertain'] is True


def test_confirmed_tool_result_survives_outcome_cleanup_error(manager, monkeypatch):
    import sqlite3
    module, runtime, _, _ = manager
    monkeypatch.setattr(runtime, 'complete_call',
                        lambda *_: (_ for _ in ()).throw(sqlite3.OperationalError('locked')))
    key, binding = str(uuid4()), str(uuid4())
    result = module.operation(key, 'personal-mcp', payload(key, binding, tool='fast'))
    assert result['result']['value'] == 'ok'
    assert module.operation(key, 'stop-binding', {'binding_id': binding})['uncertain'] is True


def test_late_stop_after_definitive_tool_response_clears_marker(manager, monkeypatch):
    module, runtime, _, _ = manager
    original_worker = runtime.Worker
    class LateStopWorker(original_worker):
        def response(self, cancelled=None, timeout=None):
            result = super().response(cancelled, timeout)
            if 'result' in result:
                cancelled.set()
            return result
    monkeypatch.setattr(runtime, 'Worker', LateStopWorker)
    key, binding = str(uuid4()), str(uuid4())
    result = module.operation(key, 'personal-mcp', payload(key, binding, tool='fast'))
    assert result['result']['value'] == 'ok'
    assert module.operation(key, 'stop-binding', {'binding_id': binding})['uncertain'] is False


def test_stop_reports_inflight_uncertainty_without_blocking_later_calls(manager):
    module, _, _, entered = manager
    key, binding = str(uuid4()), str(uuid4())
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(module.operation, key, 'personal-mcp', payload(key, binding))
        assert entered.wait(2)
        result = module.operation(key, 'stop-binding', {'binding_id': binding})
        assert result['fenced'] is True and result['uncertain'] is True
        assert pending.result()['uncertain']
    assert module.operation(key, 'stop-binding', {'binding_id': binding})['uncertain'] is True
    assert module.operation(key, 'personal-mcp', payload(key, binding, tool='fast'))['result']['value'] == 'ok'


def test_cancelled_run_is_rejected_by_current_authorization(manager, monkeypatch):
    module, _, calls, _ = manager
    key, binding = str(uuid4()), str(uuid4())
    assert module.operation(key, 'stop-binding', {'binding_id': binding})['uncertain'] is False
    monkeypatch.setattr(module, 'authorize_mcp', lambda _: False)
    result = module.operation(key, 'personal-mcp', payload(key, binding, tool='fast'))
    assert '未执行' in result['error']
    assert not calls
    assert module.operation(key, 'stop-binding', {'binding_id': binding})['uncertain'] is False


def test_cancel_before_send_does_not_dispatch(manager):
    _, runtime, _, _ = manager
    call = SimpleNamespace(cancelled=threading.Event(), dispatched=threading.Event(),
                           dispatch_started=threading.Event(), dispatch_done=threading.Event())
    call.cancelled.set()
    assert '未执行' in runtime.send_checked(call, lambda _: pytest.fail('must not send'))['error']
    assert call.dispatch_done.is_set()
    assert not call.dispatched.is_set()
