"""Real Linux memory supervisor, including descendant process cancellation."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time

import pytest

pytestmark = pytest.mark.skipif(os.name != 'posix', reason='Requires Linux process groups')


def launch(source, arguments=None, seconds=60):
    base = str(Path(__file__).resolve().parents[1])
    code = f'import sys; sys.path.insert(0,{base!r}); from memory_exec import serve; serve({source!r})'
    process = subprocess.Popen([sys.executable, '-I', '-u', '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        assert selector.select(5), 'supervisor did not initialize'
    assert json.loads(process.stdout.readline()) == {'ready': True}
    process.stdin.write(json.dumps({'tool': 'cg', 'arguments': arguments or {}, 'remaining_seconds': seconds}).encode() + b'\n')
    process.stdin.flush()
    return process


def running(pid):
    try:
        # A killed descendant may briefly be a zombie awaiting PID 1 reaping;
        # zombies have exited and cannot retain files or continue business work.
        return Path(f'/proc/{pid}/stat').read_text().split()[2] != 'Z'
    except FileNotFoundError:
        return False


def test_eof_kills_memory_process_and_its_descendant(tmp_path):
    marker = tmp_path / 'pids.json'
    engine = '''import json,os,subprocess,sys,time
from pathlib import Path
request=json.load(sys.stdin)
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'])
Path(request['arguments']['marker']).write_text(json.dumps([os.getpid(),child.pid]))
time.sleep(120)
'''
    process = launch(engine, {'marker': str(marker)})
    try:
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert marker.exists()
        pids = json.loads(marker.read_text())
        assert all(running(pid) for pid in pids)
        process.stdin.close()
        process.wait(timeout=5)
        assert process.returncode == 0, process.stderr.read().decode()
        result = json.loads(process.stdout.readline())
        assert result['process_group_fenced'] is True
        assert result['output']['uncertain']
        assert not any(running(pid) for pid in pids)
    finally:
        if process.poll() is None:
            process.stdin.close()
            process.wait(timeout=5)


def test_deadline_stops_engine_and_reports_unknown():
    process = launch('import time; time.sleep(120)', seconds=.1)
    process.wait(timeout=5)
    assert process.returncode == 0, process.stderr.read().decode()
    result = json.loads(process.stdout.readline())
    assert result['process_group_fenced'] is True
    assert result['output']['uncertain']
    process.stdin.close()


def test_success_returns_result_and_exits_with_open_manager_pipe():
    process = launch('import json,sys; request=json.load(sys.stdin); print(json.dumps({"value":request["arguments"]["value"]}))', {'value': '中文'})
    process.wait(timeout=5)
    assert process.returncode == 0, process.stderr.read().decode()
    assert json.loads(process.stdout.readline()) == {'process_group_fenced': True, 'output': {'value': '中文'}}
    process.stdin.close()


def test_result_size_is_bounded():
    process = launch('print("x" * (2 * 1024 * 1024))')
    process.wait(timeout=5)
    assert process.returncode == 0, process.stderr.read().decode()
    assert json.loads(process.stdout.readline())['output']['uncertain']
    process.stdin.close()


def test_success_fences_descendant_before_ack(tmp_path):
    marker = tmp_path / 'child'
    engine = '''import json,subprocess,sys
from pathlib import Path
request=json.load(sys.stdin)
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
Path(request['arguments']['marker']).write_text(str(child.pid))
print('{"ok":true}')
'''
    process = launch(engine, {'marker': str(marker)})
    process.wait(timeout=5)
    result = json.loads(process.stdout.readline())
    assert result == {'process_group_fenced': True, 'output': {'ok': True}}
    assert not running(int(marker.read_text()))
    process.stdin.close()


def test_blocked_pipe_writer_is_bounded_and_cancellable():
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from mcp_runtime import write_request
    child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'], stdin=subprocess.PIPE)
    cancelled = threading.Event()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(write_request, child, {'arguments': {'text': 'x' * 1000000}}, cancelled, .25)
            assert pending.result(timeout=1)['uncertain']
            pending = pool.submit(write_request, child, {'arguments': {'text': 'x' * 1000000}}, cancelled, 5)
            cancelled.set()
            assert pending.result(timeout=1)['uncertain']
    finally:
        child.kill()
        child.wait()
