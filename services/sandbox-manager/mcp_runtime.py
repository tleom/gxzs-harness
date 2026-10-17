"""Manager-side lifecycle of sandbox-local MCP workers; no MCP code runs here."""

import json
import logging
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
from mcp_authorization import validate_grant
from mcp_outcomes import record_pending, complete_call

MAX_LINE = 8 * 1024 * 1024 + 1
WORKERS = {}
GUARD = threading.RLock()
CALL_LOCKS = {}
ACTIVE = set()
LAST_USED = {}
CLOSING = {}
STARTING = set()
PATH = "/opt/user-env/current/python/bin:/opt/office/python/bin:/opt/user-env/current/node/node_modules/.bin:/opt/office/node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"


def write_request(process, request, cancelled=None, timeout=5, guard=None, on_dispatch=None):
    encoded = json.dumps(request, ensure_ascii=False).encode('utf-8') + b'\n'
    if len(encoded) > 2 * 1024 * 1024:
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
    def __init__(self, container, name, version, timeout, *, source=None, interpreter='/opt/workbench-mcp/bin/python'):
        if source is None:
            source = module_source("file_ops", "resource_ops", "mcp_ops")
            source += (Path(__file__).with_name("mcp_worker.py")).read_text()
        supervisor = Path(__file__).with_name('mcp_exec.py').read_text()
        self.token, self.container, self.interpreter = uuid4().hex, container, interpreter
        source = supervisor + '\nsupervise(' + repr(source) + ',' + repr([name, version]) + ',' + repr(self.token) + ',' + repr(time.time() + 25) + ')\n'
        self.version, self.timeout = version, timeout
        self.responses = queue.Queue(maxsize=2)
        self.close_guard = threading.Lock()
        self.cleanup_guard = threading.Lock()
        self.last_close_attempt = 0
        self.closed = False
        self.fenced = threading.Event()
        self.process = None
        self.ready = None
        try:
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
                "PATH=" + PATH,
                "NODE_PATH=/opt/user-env/current/node/node_modules:/opt/office/node/node_modules",
                interpreter,
                "-I",
                "-u",
                "-c",
                source,
                name,
                version,
                'gxzs-mcp-worker:' + self.token,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
            threading.Thread(target=self._read, daemon=True).start()
        except (OSError, RuntimeError) as error:
            if self.process is not None:
                try:
                    self.process.stdin.close()
                except (OSError, ValueError):
                    pass
            raise WorkerStartError(self) from error

    def _read(self):
        try:
            while line := self.process.stdout.readline(MAX_LINE):
                if len(line) >= MAX_LINE or not line.endswith(b"\n"):
                    break
                response = json.loads(line)
                if not isinstance(response, dict):
                    break
                if response.get('worker_group_fenced') is True and response.get('worker_id') == self.token:
                    self.fenced.set()
                    continue
                self.responses.put(response, timeout=1)
        except (ValueError, OSError, queue.Full):
            pass
        finally:
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

    def response(self, cancelled=None, timeout=None):
        deadline = time.monotonic() + (
            self.timeout + 15 if timeout is None else timeout
        )
        while time.monotonic() < deadline:
            if cancelled is not None and cancelled.is_set():
                return {
                    "error": "MCP 调用已停止，执行结果未知；请先核实外部状态",
                    "uncertain": True,
                }
            try:
                return self.responses.get(
                    timeout=min(0.1, max(0.001, deadline - time.monotonic()))
                )
            except queue.Empty:
                continue
        return {
            "error": "MCP 响应超时，执行结果未知；请先核实外部状态",
            "uncertain": True,
        }

    def send(self, payload, cancelled=None, on_dispatch=None):
        # Runtime credentials never enter a user MCP worker. UTF-8 encoding also
        # keeps an allowed 1 MiB Chinese argument within the 2 MiB input frame.
        request = {key: payload[key] for key in ('operation', 'tool', 'arguments', 'manifest_version', 'deadline_ms') if key in payload}
        return write_request(self.process, request, cancelled, guard=self.close_guard, on_dispatch=on_dispatch)

    def close(self):
        if self.process is None:
            return True
        with self.close_guard:
            if not self.closed:
                self.closed = True
                try:
                    self.process.stdin.close()
                except (OSError, ValueError):
                    pass
        # Closing is retried by the existing reaper; no cleanup thread needs to
        # be created and repeated probes cannot pile up for the same worker.
        cleanup_guard = getattr(self, 'cleanup_guard', None)
        if cleanup_guard is not None and not cleanup_guard.acquire(blocking=False):
            return False
        try:
            self.last_close_attempt = time.monotonic()
            try:
                self.process.wait(timeout=.2)
            except subprocess.TimeoutExpired:
                pass
            confirmed = bool(getattr(self, 'fenced', None) and self.fenced.is_set())
            if not confirmed and getattr(self, 'token', None):
                source = Path(__file__).with_name('mcp_exec.py').read_text()
                source += '\nprint(json.dumps({"worker_group_fenced":fence_worker(' + repr(self.token) + '),"worker_id":' + repr(self.token) + '}))\n'
                try:
                    result = subprocess.run(['docker', 'exec', '--user', '1000', self.container,
                                             self.interpreter, '-I', '-u', '-c', source],
                                            capture_output=True, timeout=2.5)
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
        supplied_deadline = payload.get('deadline_ms', int(time.time() * 1000) + 350_000)
        if not isinstance(supplied_deadline, (int, float)) or supplied_deadline > time.time() * 1000 + 350_000:
            raise ValueError('Invalid MCP deadline')
        self.deadline = time.monotonic() + max(0, (supplied_deadline - time.time() * 1000) / 1000)
        authorization = payload.get("authorization") or {}
        self.binding = authorization.get("binding_id")
        if payload["operation"] == "mcp_call":
            self.binding = validate_grant(key, payload, 'personal:mcp:' + self.name + ':' + payload['tool'])


def close_workers(workers):
    workers = set(workers)
    finished = {}
    deadline = time.monotonic() + 6
    for worker in sorted(workers, key=lambda item: getattr(item, 'last_close_attempt', 0)):
        if time.monotonic() >= deadline:
            break
        try:
            finished[worker] = worker.close() is True
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
    if payload["operation"] == "mcp_call" and not state["enabled"]:
        return {"error": "个人 MCP 已停用"}
    call = Invocation(key, payload)
    identity = key, name
    with GUARD:
        if (len(ACTIVE) + len(CLOSING) >= 64
                or sum(active.key == key for active in ACTIVE) + sum(item[0] == key for item in CLOSING.values()) >= 8):
            return {"error": "MCP 并发请求已达到上限，本次操作未执行", "code": "MCP_BUSY"}
        mutex = CALL_LOCKS.setdefault(identity, threading.Lock())
        ACTIVE.add(call)
    acquired, worker = False, None
    tracked, outcome_uncertain = False, True
    try:
        maintenance = payload["operation"] == "mcp_test" and payload.get("maintenance") is True
        if maintenance:
            # Background discovery can retry later; waiting behind a business
            # call would consume its connection budget and fake a plugin outage.
            acquired = mutex.acquire(blocking=False)
        else:
            deadline = min(time.monotonic() + 20, call.deadline)
            while not call.cancelled.is_set() and time.monotonic() < deadline:
                if mutex.acquire(timeout=0.1):
                    acquired = True
                    break
        if call.cancelled.is_set():
            return {"error": "MCP 执行已失效，本次操作未执行"}
        if not acquired:
            return {"error": "此 MCP 正忙，本次操作未执行，请稍后再试", "code": "MCP_BUSY"}
        if maintenance and call.deadline - time.monotonic() < 25:
            return {"error": "MCP 刷新准备耗时过长，稍后重试", "code": "MCP_BUSY"}
        if payload["operation"] == "mcp_call" and (
            authorize is None or not authorize({"authorization": payload["authorization"], "action": "validate"})
        ):
            return {"error": "MCP 当前任务或执行已失效，本次操作未执行"}
        with GUARD:
            worker = WORKERS.get(identity)
        if worker and (
            worker.version != state["version"] or worker.process.poll() is not None
            or payload["operation"] == "mcp_test"
        ):
            # Discovery now owns this plugin's call lock. Reconnect only after
            # the preceding call has settled; never cancel it to refresh metadata.
            with GUARD:
                WORKERS.pop(identity, None)
            retire(worker, key, name, call.binding)
            worker = None
        if worker is None:
            # Closing a previous worker may also consume the remaining budget.
            # Do not start a shortened discovery and invalidate a healthy cache.
            if maintenance and call.deadline - time.monotonic() < 25:
                return {"error": "MCP 刷新准备耗时过长，稍后重试", "code": "MCP_BUSY"}
            with GUARD:
                if len(WORKERS) + len(STARTING) + len(CLOSING) >= 64:
                    return {"error": "MCP 连接容量暂满，本次操作未执行", "code": "MCP_BUSY"}
                STARTING.add(call)
            try:
                worker = Worker(container, name, state["version"], state["timeout"])
            except WorkerStartError as error:
                retire(error.worker, key, name, call.binding)
                return {"error": "MCP 连接启动失败，本次操作未执行，请稍后重试", "code": "MCP_START_FAILED"}
            with GUARD:
                call.worker = worker
            worker.ready = worker.response(call.cancelled, timeout=max(0, min(25, call.deadline - time.monotonic())))
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
        if payload["operation"] == "mcp_call":
            if authorize is None or not authorize({"authorization": payload["authorization"], "action": "consume"}):
                return {"error": "MCP 当前任务或执行已失效，本次操作未执行"}
            # Commit before any pipe write: a manager crash after dispatch must
            # remain visible to a later stop, without restricting another call.
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
        if result is None:
            result = send_checked(call, lambda on_dispatch: worker.send(payload, call.cancelled, on_dispatch))
        if result is None:
            result = worker.response(call.cancelled, timeout=max(0, min(state['timeout'] + 15, call.deadline - time.monotonic())))
        if result.get("uncertain") or result.get("conflict") or call.cancelled.is_set():
            with GUARD:
                if WORKERS.get(identity) is worker:
                    WORKERS.pop(identity)
            retire(worker, key, name, call.binding)
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


def statistics():
    with GUARD:
        return {"active_calls": len(ACTIVE), "workers": len(WORKERS), "closing_workers": len(CLOSING), "call_locks": len(CALL_LOCKS)}


def reap_workers(idle_seconds=300, max_workers=32, max_owner_workers=4):
    expired = []
    with GUARD:
        busy = {(call.key, call.name) for call in ACTIVE}
        owner_counts = {}
        for key, _ in WORKERS:
            owner_counts[key] = owner_counts.get(key, 0) + 1
        for identity in sorted(WORKERS, key=lambda item: LAST_USED.get(item, 0)):
            if identity not in busy and (len(WORKERS) > max_workers or owner_counts[identity[0]] > max_owner_workers or time.monotonic() - LAST_USED.get(identity, 0) > idle_seconds):
                worker = WORKERS.pop(identity)
                owner_counts[identity[0]] -= 1
                expired.append(worker)
                CLOSING[worker] = (identity[0], identity[1], None)
                LAST_USED.pop(identity, None)
        for identity in list(LAST_USED):
            if identity not in WORKERS and identity not in busy:
                LAST_USED.pop(identity, None)
        expired.extend(CLOSING)
    close_workers(expired)


def fence_workspace(key):
    """Only after Docker confirms the entire owner sandbox has stopped."""
    with GUARD:
        for call in ACTIVE:
            if call.key == key:
                call.cancelled.set()
        for worker, (workspace, _, _) in list(CLOSING.items()):
            if workspace == key:
                CLOSING.pop(worker, None)
        for identity in list(WORKERS):
            if identity[0] == key:
                WORKERS.pop(identity, None)
