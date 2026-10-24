"""Sandbox-local supervisor for one memory call; EOF fences its process group."""
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from mcp_policy import get as mcp_limit



def group_running(group):
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if int(fields[2]) == group and fields[0] != 'Z':
                return True
        except FileNotFoundError:
            pass
    return False


def serve(source):
    print('{"ready":true}', flush=True)
    raw = sys.stdin.buffer.readline(mcp_limit('request_bytes') + 1)
    if not raw or len(raw) > mcp_limit('request_bytes') or not raw.endswith(b'\n'):
        print('{"process_group_fenced":true,"output":{"error":"Memory operation was not dispatched"}}', flush=True)
        return
    request = json.loads(raw)
    cancelled = threading.Event()
    # The sole child is a separate group. Never send a signal to another owner
    # process or infer a process from a caller-supplied PID/path.
    child = subprocess.Popen([sys.executable, '-I', '-S', '-u', '-c', source],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, start_new_session=True)
    guard = threading.Lock()
    done = threading.Event()

    def stop():
        with guard:
            if not done.is_set():
                cancelled.set()
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def monitor():
        # The manager sends exactly one line, then keeps stdin open until a
        # result or cancellation. A lost manager connection is cancellation.
        os.read(sys.stdin.fileno(), 1)
        stop()

    timeout = max(0.001, min(mcp_limit('max_call_seconds'), float(request.get('remaining_seconds', mcp_limit('call_timeout_seconds')))))
    timer = threading.Timer(timeout, stop)
    timer.daemon = True
    try:
        threading.Thread(target=monitor, daemon=True).start()
        timer.start()
        child.stdin.write(json.dumps({'tool': request['tool'], 'arguments': request['arguments']}, ensure_ascii=False).encode())
        child.stdin.close()
        # Bound captured output while still draining or killing the child.
        output = child.stdout.read(mcp_limit('response_bytes') + 1)
        if len(output) > mcp_limit('response_bytes'):
            stop()
        child.wait()
        with guard:
            done.set()
        if cancelled.is_set() or child.returncode or len(output) > mcp_limit('response_bytes'):
            result = {'error': '记忆调用已停止或失败，执行结果未知，请先核实状态', 'uncertain': True}
        else:
            result = json.loads(output)
    except (ValueError, OSError, RuntimeError):
        stop()
        child.wait()
        result = {'error': '记忆调用结果未知，请先核实状态', 'uncertain': True}
    finally:
        timer.cancel()
        with guard:
            # Even a successful engine may have left a subprocess behind.
            # Fence the complete group before acknowledging supervisor exit.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            done.set()
        child.stdin.close()
        child.stdout.close()
    until = time.monotonic() + 2
    try:
        while group_running(child.pid) and time.monotonic() < until:
            time.sleep(.01)
        fenced = not group_running(child.pid)
    except (OSError, ValueError):
        fenced = False
    if not fenced:
        result = {'error': 'Memory process group exit was not confirmed', 'uncertain': True}
    print(json.dumps({'process_group_fenced': fenced, 'output': result}, ensure_ascii=False), flush=True)
