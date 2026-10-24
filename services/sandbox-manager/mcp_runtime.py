"""Manager-side lifecycle of sandbox-local MCP workers; no MCP code runs here."""

import json
import logging
import math
import queue
import sqlite3
import subprocess
import threading
import time
import os
import selectors
import io
from contextlib import nullcontext
from pathlib import Path
from uuid import UUID, uuid4
from mcp_policy import get as policy, current as resource_policy
from mcp_authorization import validate_grant
from mcp_outcomes import record_pending, complete_call
from mcp_isolation import TrustedWorkerContainer, TRUSTED_PATH, TRUSTED_NODE_PATH, discover_orphans, workspace_live
from mcp_exec import command_source

WORKERS = {}
GUARD = threading.RLock()
CALL_LOCKS = {}
ACTIVE = set()
LAST_USED = {}
CLOSING = {}
STARTING = set()
ORPHAN_SCAN_FIRST = True
PATH = "/opt/user-env/current/python/bin:/opt/office/python/bin:/opt/user-env/current/node/node_modules/.bin:/opt/office/node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"


def write_request(process, request, cancelled=None, timeout=None, guard=None, on_dispatch=None):
    timeout = policy('write_timeout_seconds') if timeout is None else timeout
    encoded = json.dumps(request, ensure_ascii=False).encode('utf-8') + b'\n'
    if len(encoded) > policy('request_bytes'):
        return {'error': 'MCP 请求超过运行时限制，本次操作未执行', 'code': 'MCP_REQUEST_TOO_LARGE'}
    fd = None
    try:
        if isinstance(process.stdin, io.BytesIO):
            process.stdin.write(encoded)
            if on_dispatch:
                on_dispatch()
            return None
        with guard if guard is not None else nullcontext():
            fd = os.dup(process.stdin.fileno())
        os.set_blocking(fd, False)
        remaining = memoryview(encoded)
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            selector.register(fd, selectors.EVENT_WRITE)
            while remaining:
                if (cancelled is not None and cancelled.is_set()) or time.monotonic() >= deadline:
                    return {'error': 'MCP 请求发送已停止，执行结果未知', 'uncertain': True}
                if selector.select(min(.1, max(0, deadline - time.monotonic()))):
                    try:
                        count = os.write(fd, remaining[:65536])
                        if count and on_dispatch:
                            on_dispatch()
                        remaining = remaining[count:]
                    except BlockingIOError:
                        pass
        return None
    except (BrokenPipeError, OSError, ValueError):
        return {'error': 'MCP 连接中断，执行结果未知；请先核实外部状态', 'uncertain': True}
    finally:
        if fd is not None:
            os.close(fd)


def module_source(*names):
    base = Path(__file__).parent
    source = "import types,sys; "
    for name in names:
        source += f"module=types.ModuleType({name!r}); sys.modules[{name!r}]=module; exec({(base / (name + '.py')).read_text()!r},module.__dict__); "
    return source


class WorkerStartError(RuntimeError):
    def __init__(self, worker):
        super().__init__('MCP worker could not start')
        self.worker = worker


class Worker:
    def __init__(self, container, name, version, timeout, *, source=None, interpreter='/opt/workbench-mcp/bin/python', configuration=None, token=None, workspace=None, deadline=None):
        deadline = time.monotonic() + policy('startup_timeout_seconds') if deadline is None else deadline
        if source is None:
            source = module_source("mcp_policy", "file_ops", "resource_ops", "mcp_ops", "mcp_protocol", "mcp_task_transport")
            source += "sys.modules['mcp_policy'].configure(" + repr(resource_policy()) + "); "
            source += (Path(__file__).with_name("mcp_worker.py")).read_text()
        supervisor = Path(__file__).with_name('mcp_exec.py').read_text()
        self.token, self.container, self.interpreter = token or uuid4().hex, container, interpreter
        start_deadline = time.time() + max(0, min(policy('startup_timeout_seconds'), deadline - time.monotonic()))
        source = supervisor + '\nsupervise(' + repr(source) + ',' + repr([name, version] + (["global"] if configuration is not None else [])) + ',' + repr(self.token) + ',' + repr(start_deadline) + ',' + repr(resource_policy()) + ')\n'
        self.version, self.timeout = version, timeout
        self.responses = queue.Queue(maxsize=2)
        self.pending_responses = {}
        self.pending_guard = threading.Lock()
        self.write_guard = threading.Lock()
        self.eof = threading.Event()
        self.close_guard = threading.Lock()
        self.cleanup_guard = threading.Lock()
        self.last_close_attempt = 0
        self.closed = False
        self.fenced = threading.Event()
        self.process = None
        self.ready = None
        self.isolation = None
        try:
            if configuration is not None:
                self.isolation = TrustedWorkerContainer(workspace, self.token, name)
                self.isolation.start(deadline)
                self.container = container = self.isolation.name
            if time.monotonic() >= deadline:
                raise RuntimeError('MCP startup deadline expired')
            self.process = subprocess.Popen(
            [
                "docker",
                "exec",
                "--user",
                "1000",
                "-i",
                container,
                "/usr/bin/env",
                "-i",
                "HOME=/home/gxzs",
                "LANG=C.UTF-8",
                "PATH=" + (TRUSTED_PATH if configuration is not None else PATH),
                "NODE_PATH=" + (TRUSTED_NODE_PATH if configuration is not None else '/opt/user-env/current/node/node_modules:/opt/office/node/node_modules'),
                interpreter,
                "-I",
                "-u",
                "-c",
                command_source(source),
                name,
                version,
                'gxzs-mcp-worker:' + self.token,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
            threading.Thread(target=self._read, daemon=True).start()
            if configuration is not None:
                failure = write_request(self.process, configuration, timeout=max(0, min(policy('write_timeout_seconds'), deadline - time.monotonic())))
                if failure:
                    raise RuntimeError('MCP bootstrap failed')
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            if self.process is not None:
                try:
                    self.process.stdin.close()
                except (OSError, ValueError):
                    pass
            raise WorkerStartError(self) from error

    def _read(self):
        try:
            while line := self.process.stdout.readline(policy('response_bytes') + 1):
                if len(line) > policy('response_bytes') or not line.endswith(b"\n"):
                    break
                response = json.loads(line)
                if not isinstance(response, dict):
                    break
                if response.get('worker_group_fenced') is True and response.get('worker_id') == self.token:
                    self.fenced.set()
                    continue
                request_id = response.pop('request_id', None)
                if request_id is not None:
                    with self.pending_guard:
                        target = self.pending_responses.get(request_id)
                    if target is not None:
                        target.put(response, timeout=1)
                else:
                    self.responses.put(response, timeout=1)
        except (ValueError, OSError, queue.Full):
            pass
        finally:
            self.eof.set()
            with self.pending_guard:
                for target in self.pending_responses.values():
                    try:
                        target.put_nowait({'error': 'MCP 连接已关闭', 'uncertain': True})
                    except queue.Full:
                        pass
            try:
                self.responses.put(
                    {
                        "error": "MCP 连接已关闭，执行结果未知；请先核实外部状态",
                        "uncertain": True,
                    },
                    timeout=1,
                )
            except queue.Full:
                pass

    def response(self, cancelled=None, timeout=None, *, request_id=None):
        deadline = time.monotonic() + (
            self.timeout + policy('response_grace_seconds') if timeout is None else timeout
        )
        while time.monotonic() < deadline:
            if cancelled is not None and cancelled.is_set():
                return {
                    "error": "MCP 调用已停止，执行结果未知；请先核实外部状态",
                    "uncertain": True,
                }
            try:
                target = self.responses if request_id is None else self.pending_responses[request_id]
                return target.get(
                    timeout=min(0.1, max(0.001, deadline - time.monotonic()))
                )
            except queue.Empty:
                continue
        return {
            "error": "MCP 响应超时，执行结果未知；请先核实外部状态",
            "uncertain": True,
        }

    def send(self, payload, cancelled=None, on_dispatch=None):
        # Runtime credentials never enter a user MCP worker.
        request = {key: payload[key] for key in ('operation', 'tool', 'arguments', 'manifest_version', 'deadline_ms', 'method', 'params', 'request_id') if key in payload}
        timeout = policy('write_timeout_seconds')
        if 'deadline_ms' in request:
            timeout = min(timeout, max(0, request['deadline_ms'] / 1000 - time.time()))
        started = time.monotonic()
        if not self.write_guard.acquire(timeout=max(0, timeout)):
            return {'error': 'MCP 请求未发出，本次操作未执行', 'code': 'MCP_BUSY'}
        try:
            return write_request(self.process, request, cancelled, timeout=max(0, timeout - (time.monotonic() - started)), guard=self.close_guard, on_dispatch=on_dispatch)
        finally:
            self.write_guard.release()

    def close(self, *, deadline=None):
        # Closing is retried by the existing reaper; no cleanup thread needs to
        # be created and repeated probes cannot pile up for the same worker.
        cleanup_guard = getattr(self, 'cleanup_guard', None)
        if cleanup_guard is not None and not cleanup_guard.acquire(blocking=False):
            return False
        try:
            self.last_close_attempt = time.monotonic()
            deadline = self.last_close_attempt + policy('cleanup_timeout_seconds') if deadline is None else deadline
            if self.process is None:
                return self.isolation.close(deadline=deadline) if self.isolation is not None else True
            with self.close_guard:
                if not self.closed:
                    self.closed = True
                    try:
                        self.process.stdin.close()
                    except (OSError, ValueError):
                        pass
            try:
                self.process.wait(timeout=max(0, min(.2, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
            confirmed = self.isolation.close(deadline=deadline) if getattr(self, 'isolation', None) is not None else bool(getattr(self, 'fenced', None) and self.fenced.is_set())
            if not confirmed and getattr(self, 'isolation', None) is None and getattr(self, 'token', None):
                source = Path(__file__).with_name('mcp_exec.py').read_text()
                source += '\nprint(json.dumps({"worker_group_fenced":fence_worker(' + repr(self.token) + '),"worker_id":' + repr(self.token) + '}))\n'
                try:
                    result = subprocess.run(['docker', 'exec', '--user', '1000', self.container,
                                             self.interpreter, '-I', '-u', '-c', source],
                                            capture_output=True, timeout=max(.001, min(2.5, deadline - time.monotonic())))
                    receipt = json.loads(result.stdout)
                    confirmed = (result.returncode == 0 and isinstance(receipt, dict)
                                 and receipt.get('worker_group_fenced') is True and receipt.get('worker_id') == self.token)
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    confirmed = False
            if confirmed:
                # Only a remote exit receipt authorizes local transport cleanup.
                if self.process.poll() is None:
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=.2)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait(timeout=.2)
                self.process.stdout.close()
            return confirmed
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return False
        finally:
            if cleanup_guard is not None:
                cleanup_guard.release()


class Invocation:
    def __init__(self, key, payload):
        self.key, self.name = key, payload["name"]
        self.call_id = uuid4().hex
        self.cancelled, self.worker = threading.Event(), None
        self.dispatch_started, self.dispatch_done, self.dispatched = threading.Event(), threading.Event(), threading.Event()
        budget = policy('catalog_timeout_seconds') if payload['operation'] == 'mcp_test' else policy('max_call_seconds')
        supplied_deadline = payload.get('deadline_ms', int(time.time() * 1000 + budget * 1000))
        if type(supplied_deadline) not in (int, float) or not math.isfinite(supplied_deadline) or supplied_deadline > time.time() * 1000 + budget * 1000:
            raise ValueError('Invalid MCP deadline')
        self.deadline = time.monotonic() + max(0, (supplied_deadline - time.time() * 1000) / 1000)
        authorization = payload.get("authorization") or {}
        self.binding = authorization.get("binding_id")
        if payload["operation"] in {"mcp_call", "mcp_request", "mcp_task"}:
            resource = ('global:mcp:' + payload['server_id']) if payload.get('scope') == 'global' else 'personal:mcp:' + self.name
            if payload["operation"] in {"mcp_call", "mcp_task"}:
                resource += ':' + payload['tool']
            self.binding = validate_grant(key, payload, resource)


def close_workers(workers, *, deadline=None):
    workers = set(workers)
    finished = {}
    deadline = time.monotonic() + policy('cleanup_timeout_seconds') if deadline is None else deadline
    for worker in sorted(workers, key=lambda item: getattr(item, 'last_close_attempt', 0)):
        if time.monotonic() >= deadline:
            break
        try:
            finished[worker] = worker.close(deadline=deadline) is True
        except Exception:
            finished[worker] = False
            logging.getLogger(__name__).exception('Unable to fence MCP worker')
    with GUARD:
        for worker, confirmed in finished.items():
            if confirmed:
                CLOSING.pop(worker, None)
    return len(finished) == len(workers) and all(finished.values())


def retire(worker, key, name, binding=None):
    with GUARD:
        if WORKERS.get((key, name)) is worker:
            WORKERS.pop((key, name), None)
        CLOSING[worker] = (key, name, binding)
    return close_workers([worker])


def invalidate(key, name=None, *, binding=None):
    """Cancel matching queued/in-flight calls without acquiring their call lock."""
    workers, calls = [], []
    with GUARD:
        for worker, (workspace, server, run) in CLOSING.items():
            if workspace == key and (name is None or server == name) and (binding is None or run is None or run == binding):
                workers.append(worker)
        for call in list(ACTIVE):
            if (
                call.key == key
                and (name is None or call.name == name)
                and (binding is None or call.binding == binding)
            ):
                call.cancelled.set()
                calls.append(call)
                if call.worker is not None:
                    workers.append(call.worker)
                    CLOSING[call.worker] = (key, call.name, call.binding)
        for identity, worker in list(WORKERS.items()):
            if (
                identity[0] == key
                and (name is None or identity[1] == name)
                and (binding is None or worker in workers)
            ):
                worker = WORKERS.pop(identity)
                workers.append(worker)
                CLOSING.setdefault(worker, (key, identity[1], binding))
    confirmed = close_workers(workers)
    wait_dispatch(calls)
    return confirmed


def wait_dispatch(calls):
    deadline = time.monotonic() + 1
    for call in calls:
        if call.dispatch_started.is_set():
            call.dispatch_done.wait(max(0, deadline - time.monotonic()))


def binding_inflight(key, binding):
    with GUARD:
        return any(call.key == key and call.binding == binding for call in ACTIVE)


def send_checked(call, send):
    """Order cancellation against a single send without suppressing later calls."""
    call.dispatch_started.set()
    try:
        if call.cancelled.is_set():
            return {'error': 'MCP 调用已停止，本次操作未执行'}
        try:
            return send(call.dispatched.set)
        except Exception:
            return {'error': 'MCP 请求发送失败，执行结果未知' if call.dispatched.is_set() else 'MCP 请求未发出，本次操作未执行',
                    'uncertain': call.dispatched.is_set()}
    finally:
        call.dispatch_done.set()


def invoke(key, container, payload, state, *, authorize=None):
    name = payload["name"]
    if payload.get("version") != state["version"]:
        return {"conflict": True}
    if payload["operation"] in {"mcp_call", "mcp_request", "mcp_task"} and not state["enabled"]:
        return {"error": "个人 MCP 已停用"}
    call = Invocation(key, payload)
    identity = key, name
    with GUARD:
        existing = WORKERS.get(identity)
        call.control = (payload['operation'] == 'mcp_task' and payload.get('method') == 'tasks/cancel'
                        and existing is not None and payload.get('connection_id') == existing.token)
        if call.control and any(getattr(active, 'control', False) and active.key == key and active.name == name for active in ACTIVE):
            return {'error': 'MCP 取消请求正在处理', 'code': 'MCP_BUSY'}
        if not call.control and not capacity_available(key):
            return {"error": "MCP 并发请求已达到上限，本次操作未执行", "code": "MCP_BUSY"}
        mutex = CALL_LOCKS.setdefault(identity, threading.Lock())
        ACTIVE.add(call)
    acquired, worker = False, None
    tracked, outcome_uncertain = False, True
    try:
        maintenance = payload["operation"] == "mcp_test" and payload.get("maintenance") is True
        if call.control:
            # The existing connection accepts one concurrent cancel even when
            # ordinary admission is full. It cannot create another worker.
            pass
        elif maintenance:
            # Background discovery can retry later; waiting behind a business
            # call would consume its connection budget and fake a plugin outage.
            acquired = mutex.acquire(blocking=False)
        else:
            deadline = call.deadline
            while not call.cancelled.is_set() and time.monotonic() < deadline:
                if mutex.acquire(timeout=0.1):
                    acquired = True
                    break
        if call.cancelled.is_set():
            return {"error": "MCP 执行已失效，本次操作未执行"}
        if not acquired and not call.control:
            return {"error": "此 MCP 正忙，本次操作未执行，请稍后再试", "code": "MCP_BUSY"}
        if maintenance and call.deadline - time.monotonic() < policy('startup_timeout_seconds'):
            return {"error": "MCP 刷新准备耗时过长，稍后重试", "code": "MCP_BUSY"}
        if payload["operation"] in {"mcp_call", "mcp_request", "mcp_task"} and (
            authorize is None or not authorize({"authorization": payload["authorization"], "action": "validate"})
        ):
            return {"error": "MCP 当前任务或执行已失效，本次操作未执行"}
        with GUARD:
            worker = WORKERS.get(identity)
        if worker and (
            worker.version != state["version"] or worker.process.poll() is not None
            or payload["operation"] == "mcp_test" and payload.get('scope') != 'global'
            and getattr(worker, "tasks_active_until", 0) < time.time() * 1000
        ):
            # Discovery now owns this plugin's call lock. Reconnect only after
            # the preceding call has settled; never cancel it to refresh metadata.
            with GUARD:
                WORKERS.pop(identity, None)
            retire(worker, key, name, call.binding)
            worker = None
        if payload.get('connection_id') and (worker is None or worker.token != payload['connection_id']):
            return {'error': 'MCP 任务连接已失效，请核实外部状态'}
        if worker is None:
            if call.cancelled.is_set() or time.monotonic() >= call.deadline:
                return {'error': 'MCP 执行已失效，本次操作未执行'}
            # Closing a previous worker may also consume the remaining budget.
            # Do not start a shortened discovery and invalidate a healthy cache.
            if maintenance and call.deadline - time.monotonic() < policy('startup_timeout_seconds'):
                return {"error": "MCP 刷新准备耗时过长，稍后重试", "code": "MCP_BUSY"}
            if 'configuration' in state:
                with GUARD:
                    pending = any(workspace == key and (server == name or server is None)
                                  for workspace, server, _ in CLOSING.values())
                if pending:
                    return {'error': 'MCP 上一个连接尚未确认关闭，本次操作未执行', 'code': 'MCP_BUSY'}
                cleanup_deadline = min(call.deadline, time.monotonic() + policy('cleanup_timeout_seconds'))
                if not collect_orphans(cleanup_deadline, key):
                    return {'error': 'MCP 上一个连接正在核对，本次操作未执行', 'code': 'MCP_BUSY'}
                with GUARD:
                    predecessors = [old for old, (workspace, server, _) in CLOSING.items()
                                    if workspace == key and (server == name or server is None)]
                if not close_workers(predecessors, deadline=cleanup_deadline):
                    return {'error': 'MCP 上一个连接尚未确认关闭，本次操作未执行', 'code': 'MCP_BUSY'}
            with GUARD:
                if call.cancelled.is_set() or time.monotonic() >= call.deadline:
                    return {'error': 'MCP 执行已失效，本次操作未执行'}
                if any(workspace == key and (server == name or server is None)
                       for workspace, server, _ in CLOSING.values()):
                    return {'error': 'MCP 上一个连接尚未确认关闭，本次操作未执行', 'code': 'MCP_BUSY'}
                if len(WORKERS) + len(STARTING) + len(CLOSING) >= policy('max_connections'):
                    return {"error": "MCP 连接容量暂满，本次操作未执行", "code": "MCP_BUSY"}
                STARTING.add(call)
            try:
                worker_options = {"configuration": state["configuration"], "workspace": key, "deadline": call.deadline} if "configuration" in state else {'deadline': call.deadline}
                worker = Worker(container, name, state["version"], state["timeout"], **worker_options)
            except WorkerStartError as error:
                retire(error.worker, key, name, call.binding)
                return {"error": "MCP 连接启动失败，本次操作未执行，请稍后重试", "code": "MCP_START_FAILED"}
            with GUARD:
                call.worker = worker
            worker.ready = worker.response(call.cancelled, timeout=max(0, min(policy('startup_timeout_seconds'), call.deadline - time.monotonic())))
            if not worker.ready.get("ready"):
                retire(worker, key, name, call.binding)
                return worker.ready
            with GUARD:
                if not call.cancelled.is_set():
                    WORKERS[identity] = worker
        with GUARD:
            call.worker = worker
        if call.cancelled.is_set() or time.monotonic() >= call.deadline:
            retire(worker, key, name, call.binding)
            return {"error": "MCP 执行已失效，本次操作未执行"}
        if payload["operation"] in {"mcp_call", "mcp_request", "mcp_task"}:
            if authorize is None or not authorize({"authorization": payload["authorization"], "action": "consume"}):
                return {"error": "MCP 当前任务或执行已失效，本次操作未执行"}
            # Commit before any pipe write: a manager crash after dispatch must
            # remain visible to a later stop, without restricting another call.
            if not (payload['operation'] == 'mcp_task' and payload.get('method') in {'tasks/get', 'tasks/result'}):
                record_pending(key, call.binding, call.call_id)
                tracked = True
        # This short critical section orders dispatch against stop/config changes.
        # External connection, authorization and response waits never hold it.
        with GUARD:
            if call.cancelled.is_set() or time.monotonic() >= call.deadline:
                result = {"error": "MCP 执行已失效，本次操作未执行"}
            else:
                result = None
        # Non-blocking pipe IO must never hold the cross-owner cancellation lock.
        request_id = call.call_id if payload['operation'] == 'mcp_task' else None
        awaiting_response = False
        if request_id is not None:
            with worker.pending_guard:
                worker.pending_responses[request_id] = queue.Queue(maxsize=1)
        try:
            if result is None:
                outbound = {**payload, 'request_id': request_id} if request_id is not None else payload
                result = send_checked(call, lambda on_dispatch: worker.send(outbound, call.cancelled, on_dispatch))
            if result is None:
                awaiting_response = True
                options = {'request_id': request_id} if request_id is not None else {}
                result = worker.response(call.cancelled, timeout=max(0, min(state['timeout'] + policy('response_grace_seconds'), call.deadline - time.monotonic())), **options)
        finally:
            if request_id is not None:
                with worker.pending_guard:
                    worker.pending_responses.pop(request_id, None)
        # A read deadline cancels that SDK request, not the external Task.
        read_timeout = (payload['operation'] == 'mcp_task' and payload.get('method') in {'tasks/get', 'tasks/result'}
                        and awaiting_response and result.get('uncertain') and time.monotonic() >= call.deadline
                        and not call.cancelled.is_set() and not worker.eof.is_set() and worker.process.poll() is None)
        if read_timeout:
            result = {'error': 'MCP 任务查询超时，任务仍可查询或取消', 'code': 'MCP_TASK_TIMEOUT'}
        if result.get("uncertain") or result.get("conflict") or result.pop('connection_lost', False) or call.cancelled.is_set():
            with GUARD:
                if WORKERS.get(identity) is worker:
                    WORKERS.pop(identity)
            retire(worker, key, name, call.binding)
        if payload['operation'] == 'mcp_task' and 'result' in result:
            worker.tasks_active_until = result.pop('tasks_active_until', 0)
            result['connection_id'] = worker.token
        if payload['operation'] == 'mcp_test' and result.get('ready'):
            worker.ready = result
        # A late stop cannot turn a definitive response back into uncertainty.
        outcome_uncertain = bool(result.get("uncertain"))
        return result
    finally:
        try:
            if tracked and not outcome_uncertain:
                try:
                    complete_call(key, call.binding, call.call_id)
                except (sqlite3.Error, OSError):
                    logging.getLogger(__name__).exception('Unable to clear confirmed MCP outcome')
        finally:
            with GUARD:
                ACTIVE.discard(call)
                STARTING.discard(call)
                LAST_USED[identity] = time.monotonic()
            if acquired:
                mutex.release()
            with GUARD:
                if not any((active.key, active.name) == identity for active in ACTIVE):
                    CALL_LOCKS.pop(identity, None)


def cancel_task(key, payload, *, authorize):
    """Control on an existing connection needs neither provisioning nor probing."""
    with GUARD:
        worker = WORKERS.get((key, payload.get('name')))
        if worker is None or not payload.get('connection_id') or payload['connection_id'] != worker.token:
            return {'error': 'MCP 任务连接已失效，请核实外部状态'}
        state = {'version': worker.version, 'enabled': True, 'timeout': worker.timeout}
        container = worker.container
    return invoke(key, container, payload, state, authorize=authorize)


def capacity_available(key):
    # Both manager execution channels share one admission budget. The caller
    # holds GUARD; acquire the memory lock second everywhere to avoid inversion.
    from global_memory import ACTIVE as memory_calls, GUARD as memory_guard
    with memory_guard:
        total = len(ACTIVE) + len(CLOSING) + len(memory_calls)
        owner = sum(call.key == key for call in ACTIVE) + sum(item[0] == key for item in CLOSING.values()) + sum(call.key == key for call in memory_calls)
        return total < policy('max_active_calls') and owner < policy('max_owner_calls')


def statistics():
    with GUARD:
        return {"active_calls": len(ACTIVE), "workers": len(WORKERS), "closing_workers": len(CLOSING), "call_locks": len(CALL_LOCKS)}


def reap_workers(idle_seconds=None, max_workers=None, max_owner_workers=None):
    global ORPHAN_SCAN_FIRST
    deadline = time.monotonic() + policy('cleanup_timeout_seconds')
    idle_seconds = policy('idle_seconds') if idle_seconds is None else idle_seconds
    max_workers = policy('max_idle_connections') if max_workers is None else max_workers
    max_owner_workers = policy('max_owner_idle_connections') if max_owner_workers is None else max_owner_workers
    expired = []
    with GUARD:
        busy = {(call.key, call.name) for call in ACTIVE}
        owner_counts = {}
        for key, _ in WORKERS:
            owner_counts[key] = owner_counts.get(key, 0) + 1
        for identity in sorted(WORKERS, key=lambda item: LAST_USED.get(item, 0)):
            if identity not in busy and getattr(WORKERS[identity], "tasks_active_until", 0) < time.time() * 1000 and (len(WORKERS) > max_workers or owner_counts[identity[0]] > max_owner_workers or time.monotonic() - LAST_USED.get(identity, 0) > idle_seconds):
                worker = WORKERS.pop(identity)
                owner_counts[identity[0]] -= 1
                expired.append(worker)
                CLOSING[worker] = (identity[0], identity[1], None)
                LAST_USED.pop(identity, None)
        for identity in list(LAST_USED):
            if identity not in WORKERS and identity not in busy:
                LAST_USED.pop(identity, None)
        expired.extend(CLOSING)
    scan_first = ORPHAN_SCAN_FIRST
    ORPHAN_SCAN_FIRST = not scan_first
    # Alternate priority so a slow inventory or one unconfirmed close cannot
    # indefinitely prevent the other half of the same bounded sweep.
    if scan_first:
        collect_orphans(deadline)
    with GUARD:
        expired.extend(CLOSING)
    close_workers(expired, deadline=deadline)
    if not scan_first:
        collect_orphans(deadline)


def collect_orphans(deadline, workspace=None):
    if time.monotonic() >= deadline:
        return False
    orphans, confirmed = discover_orphans(deadline, workspace)
    with GUARD:
        for orphan in orphans:
            CLOSING[orphan] = (orphan.workspace, orphan.server, None)
    return confirmed


def fence_workspace(key):
    """Only after Docker confirms the entire owner sandbox has stopped."""
    deadline = time.monotonic() + policy('cleanup_timeout_seconds')
    inventory_confirmed = collect_orphans(deadline, key)
    isolated = []
    with GUARD:
        for call in ACTIVE:
            if call.key == key:
                call.cancelled.set()
        for worker, (workspace, _, _) in list(CLOSING.items()):
            if workspace == key:
                if isinstance(worker, TrustedWorkerContainer) or getattr(worker, 'isolation', None) is not None:
                    isolated.append(worker)
                else:
                    CLOSING.pop(worker, None)
        for identity in list(WORKERS):
            if identity[0] == key:
                worker = WORKERS.pop(identity)
                if getattr(worker, 'isolation', None) is not None:
                    CLOSING.setdefault(worker, (key, identity[1], None))
                    isolated.append(worker)
        starting = any(call.key == key for call in STARTING)
    closed = close_workers(isolated, deadline=deadline)
    return inventory_confirmed and not starting and closed and not workspace_live(key)
