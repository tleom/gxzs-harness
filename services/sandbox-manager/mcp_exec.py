"""Persistent MCP worker supervisor: acknowledge the sandbox process group exit."""
import os
import ctypes
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


def descendants(parent):
    processes = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            processes[int(entry.name)] = (int(fields[1]), fields[0])
        except FileNotFoundError:
            pass
    owned = {parent}
    while True:
        found = {pid for pid, (ppid, _) in processes.items() if ppid in owned}
        if found <= owned:
            return {pid for pid in owned - {parent} if processes[pid][1] != 'Z'}
        owned.update(found)


def supervise(source, args):
    # The MCP SDK launches stdio servers in their own session. Adopt orphaned
    # descendants so fencing includes those groups, without touching unrelated
    # processes in this owner's sandbox.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'Cannot supervise MCP descendants')
    child = subprocess.Popen([sys.executable, '-I', '-u', '-c', source, *args],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, start_new_session=True)

    guard = threading.Lock()

    def stop():
        with guard:
            until = time.monotonic() + 2
            while True:
                owned = descendants(os.getpid())
                if not owned:
                    return True
                for pid in owned:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if time.monotonic() >= until:
                    return False
                time.sleep(.01)

    def forward():
        try:
            while data := os.read(sys.stdin.fileno(), 65536):
                child.stdin.write(data)
                child.stdin.flush()
        except (OSError, ValueError):
            pass
        finally:
            stop()

    threading.Thread(target=forward, daemon=True).start()
    try:
        while data := os.read(child.stdout.fileno(), 65536):
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    finally:
        fenced = stop()
        child.wait()
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
    print('{"worker_group_fenced":' + ('true' if fenced else 'false') + '}', flush=True)
