"""Sandbox-local MCP supervisor; confirm descendant exit even after lost IO."""
import ctypes
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:  # Importable by the manager's portable unit tests.
    fcntl = None

STATE = Path('/tmp/.gxzs-mcp-workers')


class WorkerStopped(Exception):
    pass


def descendants(parent):
    processes = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            processes[int(entry.name)] = (int(fields[1]), fields[0])
        except (FileNotFoundError, ProcessLookupError):
            pass
    owned = {parent}
    while True:
        found = {pid for pid, (ppid, _) in processes.items() if ppid in owned}
        if found <= owned:
            return {pid for pid in owned - {parent} if processes[pid][1] != 'Z'}
        owned.update(found)


def process_start(pid):
    return (Path('/proc') / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()[19]


@contextmanager
def worker_record(token):
    if not re.fullmatch('[a-f0-9]{32}', token):
        raise ValueError('Invalid MCP worker identity')
    STATE.mkdir(mode=0o700, exist_ok=True)
    folder = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        if os.fstat(folder).st_uid != os.getuid():
            raise ValueError('Invalid MCP worker state owner')
        lock = os.open('state.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=folder)
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise ValueError('Invalid MCP worker state lock')
        deadline = time.monotonic() + .5
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('MCP worker state busy')
                time.sleep(.01)
        yield folder
    finally:
        if lock is not None:
            os.close(lock)
        os.close(folder)


def read_record(folder, token):
    try:
        fd = os.open(token + '.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=folder)
    except FileNotFoundError:
        return None
    with os.fdopen(fd) as source:
        return json.loads(source.read(4096))


def save_record(folder, token, value):
    fd = os.open(token + '.tmp', os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW,
                 0o600, dir_fd=folder)
    with os.fdopen(fd, 'w') as target:
        json.dump(value, target)
    os.replace(token + '.tmp', token + '.json', src_dir_fd=folder, dst_dir_fd=folder)


def fence_worker(token):
    """An absent start record becomes a tombstone, excluding late Docker exec."""
    with worker_record(token) as folder:
        record = read_record(folder, token)
        if record is None or record.get('fenced') is True:
            save_record(folder, token, {'fenced': True, 'finished_at': time.time()})
            return True
        pid = record['pid']
        # pidfd prevents a recycled PID from receiving the shutdown signal.
        if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            return False
        try:
            handle = os.pidfd_open(pid)
        except ProcessLookupError:
            return False  # A dead supervisor alone cannot prove child exit.
        try:
            marker = ('gxzs-mcp-worker:' + token).encode()
            command = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
            if process_start(pid) != record['started'] or marker not in command:
                return False
            signal.pidfd_send_signal(handle, signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError):
            return False
        finally:
            os.close(handle)
    deadline = time.monotonic() + .8
    while time.monotonic() < deadline:
        with worker_record(token) as folder:
            if (read_record(folder, token) or {}).get('fenced') is True:
                return True
        time.sleep(.02)
    return False


def prune_records():
    # Completed receipts outlive the 25-second launch deadline. Never discard
    # unfinished records or infer completion merely from their age.
    if not STATE.exists():
        return
    for path in STATE.glob('*.json'):
        token = path.stem
        try:
            if path.stat().st_mtime >= time.time() - 3600:
                continue
            with worker_record(token) as folder:
                record = read_record(folder, token) or {}
                if record.get('fenced') is True and record.get('finished_at', time.time()) < time.time() - 3600:
                    os.unlink(token + '.json', dir_fd=folder)
        except (OSError, ValueError, TimeoutError):
            pass


def emit(receipt):
    remaining = memoryview((json.dumps(receipt) + '\n').encode())
    deadline = time.monotonic() + .5
    try:
        while remaining and time.monotonic() < deadline:
            try:
                remaining = remaining[os.write(sys.stdout.fileno(), remaining):]
            except BlockingIOError:
                time.sleep(.01)
    except (BrokenPipeError, OSError):
        pass  # The durable receipt also works when stdout has disconnected.


def supervise(source, args, token=None, start_deadline=None):
    # MCP stdio servers may detach. Adopt their descendants for scoped fencing.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot supervise MCP descendants')
    child, fenced = None, False
    previous = {}

    def interrupted(*_):
        # selectors treats InterruptedError as a retryable interrupted syscall.
        raise WorkerStopped('MCP worker stopped')

    try:
        for signum in (signal.SIGTERM, signal.SIGHUP):
            previous[signum] = signal.signal(signum, interrupted)
        os.set_blocking(sys.stdout.fileno(), False)
        if token is not None:
            prune_records()
            with worker_record(token) as folder:
                if (read_record(folder, token) or {}).get('fenced') is True or time.time() >= start_deadline:
                    fenced = True
                    return
                save_record(folder, token, {'pid': os.getpid(), 'started': process_start(os.getpid()), 'fenced': False})
        child = subprocess.Popen([sys.executable, '-I', '-u', '-c', source, *args],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, start_new_session=True)
        # One event loop forwards both directions. Cleanup never needs a new
        # Python thread when the sandbox is already at its PID/TID limit.
        descriptors = {'input': sys.stdin.fileno(), 'output': child.stdout.fileno(),
                       'worker': child.stdin.fileno(), 'host': sys.stdout.fileno()}
        for fd in descriptors.values():
            os.set_blocking(fd, False)
        source_open, sink_open = True, True
        incoming, outgoing = bytearray(), bytearray()
        with selectors.DefaultSelector() as selector:
            registered = {}
            while source_open or outgoing:
                wanted = {}
                if len(incoming) < 2 * 1024 * 1024:
                    wanted['input'] = selectors.EVENT_READ
                if source_open and len(outgoing) < 16 * 1024 * 1024:
                    wanted['output'] = selectors.EVENT_READ
                if incoming and sink_open:
                    wanted['worker'] = selectors.EVENT_WRITE
                if outgoing:
                    wanted['host'] = selectors.EVENT_WRITE
                for name in set(registered) - set(wanted):
                    selector.unregister(descriptors[name])
                    registered.pop(name)
                for name, event in wanted.items():
                    if name not in registered:
                        selector.register(descriptors[name], event, name)
                        registered[name] = event
                for key, _ in selector.select(.1):
                    name = key.data
                    try:
                        if name in ('input', 'output'):
                            data = os.read(key.fd, 65536)
                            if not data:
                                if name == 'input':
                                    return
                                source_open = False
                            else:
                                (incoming if name == 'input' else outgoing).extend(data)
                        else:
                            buffer = incoming if name == 'worker' else outgoing
                            count = os.write(key.fd, buffer[:65536])
                            del buffer[:count]
                    except BlockingIOError:
                        pass
                    except BrokenPipeError:
                        if name == 'worker':
                            incoming.clear()
                            sink_open = False
                        else:
                            return
    except (WorkerStopped, OSError, ValueError):
        pass
    finally:
        for signum in previous:
            signal.signal(signum, signal.SIG_IGN)
        deadline = time.monotonic() + 2
        while True:
            owned = descendants(os.getpid())
            if not owned:
                fenced = True
                break
            for pid in owned:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if time.monotonic() >= deadline:
                break
            time.sleep(.01)
        if child is not None:
            try:
                child.wait(timeout=.2)
            except subprocess.TimeoutExpired:
                fenced = False
            child.stdin.close()
            child.stdout.close()
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
        if token is not None:
            with worker_record(token) as folder:
                record = read_record(folder, token) or {}
                record.update(fenced=fenced, finished_at=time.time())
                save_record(folder, token, record)
        receipt = {'worker_group_fenced': fenced}
        if token is not None:
            receipt['worker_id'] = token
        emit(receipt)
        for signum, handler in previous.items():
            signal.signal(signum, handler)
