"""Skill import control using the existing MCP worker, fencing and receipts."""
import json
import re
import subprocess
import threading
import time

from mcp_runtime import Worker, WorkerStartError, module_source, policy

MODULES = ('file_ops', 'resource_ops', 'binary_upload', 'skill_imports')
CALLS = {}
GUARD = threading.Lock()


def token(payload):
    value = payload.get('import_id')
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
        raise ValueError('技能导入标识无效')
    return value


def control(container, payload, *, cancel=False):
    """Remote receipts, rather than Docker-client exit, settle stopped imports."""
    value = token(payload)
    source = module_source(*MODULES, 'mcp_exec')
    source += 'import json; '
    source += ('confirmed=sys.modules["mcp_exec"].fence_worker(' + repr(value) + '); ' if cancel else 'confirmed=True; ')
    source += 'print(json.dumps(sys.modules["skill_imports"].status(' + repr(payload)
    source += ',cancel=' + repr(cancel) + ',confirmed=confirmed)))'
    try:
        result = subprocess.run(['docker', 'exec', '--user', '1000', container,
                                 '/usr/local/bin/python', '-I', '-S', '-c', source],
                                capture_output=True, timeout=5)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return {'import_id': value, 'status': 'unknown', 'uncertain': True,
            'error': '导入结果待确认，请刷新技能列表后重试查询'}


def cancel(key, container, payload):
    identity = key, token(payload)
    with GUARD:
        call = CALLS.get(identity)
        if call is not None:
            call['cancelled'].set()
            worker = call.get('worker')
        else:
            worker = None
    if worker is not None:
        worker.close()
    # Also tombstone a not-yet-started worker, including after manager restart.
    return control(container, payload, cancel=True)


def status(key, container, payload):
    result = control(container, payload)
    with GUARD:
        starting = (key, token(payload)) in CALLS
    if starting and result['status'] in {'pending', 'ready'}:
        result = {'import_id': token(payload), 'status': 'running'}
    return result


def invoke(key, container, payload, *, on_finish=lambda: None):
    """Admit once, then let short status requests observe the durable result."""
    try:
        value = token(payload)
    except ValueError:
        on_finish()
        raise
    try:
        current = control(container, payload)
    except BaseException:
        on_finish()
        raise
    if current['status'] != 'ready':
        on_finish()
        return current
    identity = key, value
    with GUARD:
        duplicate = identity in CALLS
        if not duplicate:
            call = {'cancelled': threading.Event(), 'worker': None,
                    'on_finish': on_finish, 'closing': False,
                    'close_lock': threading.Lock(), 'workspace_fenced': False}
            CALLS[identity] = call
    if duplicate:
        on_finish()
        return status(key, container, payload)
    try:
        threading.Thread(target=_invoke, args=(key, container, payload, call), daemon=True).start()
    except RuntimeError:
        with GUARD:
            CALLS.pop(identity, None)
        on_finish()
        raise
    return {'import_id': value, 'status': 'running'}


def _invoke(key, container, payload, call):
    value = token(payload)
    identity = key, value
    worker = None
    try:
        if call['cancelled'].is_set():
            return
        source = module_source(*MODULES)
        source += 'import json; print(json.dumps({"ready":True}),flush=True); '
        source += 'request=json.loads(sys.stdin.readline()); '
        source += 'print(json.dumps(sys.modules["skill_imports"].run(request["arguments"])),flush=True)'
        worker = Worker(container, value, 'skill-import', 600, source=source,
                        interpreter='/usr/local/bin/python', token=value)
        with GUARD:
            call['worker'] = worker
            if call.get('workspace_fenced'):
                worker.fenced.set()
        ready = worker.response(call['cancelled'])
        if ready.get('ready') is not True or call['cancelled'].is_set():
            worker.close()
            return control(container, payload, cancel=True)
        failure = worker.send({'operation': 'skill_import', 'arguments': payload}, call['cancelled'])
        result = failure or worker.response(call['cancelled'], timeout=600)
        if result.get('uncertain') or call['cancelled'].is_set():
            worker.close()
            return control(container, payload, cancel=True)
        return result
    except WorkerStartError as error:
        worker = error.worker
        worker.close()
        return control(container, payload, cancel=True)
    except (OSError, ValueError, RuntimeError):
        if worker is not None:
            worker.close()
        return control(container, payload, cancel=True)
    finally:
        with GUARD:
            call['worker'] = worker
            call['closing'] = True
        finish(identity, call)


def finish(identity, call):
    """Retain capacity and the worker until its supervisor confirms exit."""
    if not call['close_lock'].acquire(blocking=False):
        return
    try:
        worker = call.get('worker')
        if worker is not None:
            if call.get('workspace_fenced'):
                worker.fenced.set()
            if not worker.close() and not call.get('workspace_fenced'):
                return
        with GUARD:
            if CALLS.get(identity) is not call:
                return
            CALLS.pop(identity)
        call['on_finish']()
    finally:
        call['close_lock'].release()


def fence_workspace(key):
    """Called only after Docker proves the owner's sandbox has stopped."""
    with GUARD:
        calls = [(identity, call) for identity, call in CALLS.items() if identity[0] == key]
        for _, call in calls:
            call['cancelled'].set()
            call['workspace_fenced'] = True
            worker = call.get('worker')
            if worker is not None:
                worker.fenced.set()
    # Active startup/dispatch threads finish through their normal finally block;
    # cancellation prevents a late startup from submitting the import.
    for identity, call in calls:
        if call['closing']:
            finish(identity, call)


def reap_calls():
    with GUARD:
        closing = [(identity, call) for identity, call in CALLS.items() if call['closing']]
    deadline = time.monotonic() + policy('cleanup_timeout_seconds')
    for identity, call in sorted(closing, key=lambda item: getattr(item[1].get('worker'), 'last_close_attempt', 0)):
        if time.monotonic() >= deadline:
            break
        try:
            finish(identity, call)
        except (OSError, RuntimeError):
            continue
