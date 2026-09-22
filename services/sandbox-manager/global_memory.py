"""Platform memory backed by dsh-memory, always executed in the owner's sandbox."""
import json
import os
import sys
import time
import threading
import subprocess
import queue
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REVISION = "bf846ebffca0d33c6d3b1468e12e16c7358fd715"
VERSION = "1-" + REVISION[:12]
SERVER_ID = "global-memory"
SOURCE = "/opt/gxzs-global-memory/" + REVISION
ROOT = "/home/dify/.gxzs-global-memory"
ACTIVE = set()
GUARD = threading.RLock()


class MemoryWorker:
    def __init__(self, container):
        from mcp_runtime import Worker
        engine = Path(__file__).read_text(encoding='utf-8')
        supervisor = Path(__file__).with_name('memory_exec.py').read_text(encoding='utf-8')
        source = supervisor + '\nserve(' + repr(engine) + ')\n'
        self.process = subprocess.Popen(['docker', 'exec', '--user', '1000', '-i', container,
            '/usr/bin/env', '-i', 'HOME=/home/dify', 'LANG=C.UTF-8', 'PATH=/usr/local/bin:/usr/bin:/bin',
            '/usr/local/bin/python', '-I', '-S', '-u', '-c', source], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.responses, self.timeout = queue.Queue(maxsize=2), 60
        self.fenced = threading.Event()
        self.close_guard, self.closed = threading.Lock(), False
        threading.Thread(target=Worker._read, args=(self,), daemon=True).start()

    def response(self, cancelled=None, timeout=None):
        from mcp_runtime import Worker
        response = Worker.response(self, cancelled, timeout)
        if 'process_group_fenced' in response:
            if response['process_group_fenced'] is True:
                self.fenced.set()
            return response['output']
        return response

    def send(self, tool, arguments, remaining, cancelled=None, on_dispatch=None):
        from mcp_runtime import write_request
        return write_request(self.process, {'tool': tool, 'arguments': arguments, 'remaining_seconds': remaining}, cancelled, timeout=min(5, remaining), guard=self.close_guard, on_dispatch=on_dispatch)

    def close(self):
        with self.close_guard:
            if not self.closed:
                self.closed = True
                try:
                    self.process.stdin.close()
                except OSError:
                    pass
        try:
            self.process.wait(timeout=6)
            # Require the trusted sandbox supervisor's acknowledgment, not
            # merely disappearance of the local Docker client process.
            until = time.monotonic() + 1
            while not self.fenced.is_set() and time.monotonic() < until:
                try:
                    response = self.responses.get(timeout=.05)
                    if response.get('process_group_fenced') is True:
                        self.fenced.set()
                except queue.Empty:
                    pass
            return self.process.returncode == 0 and self.fenced.is_set()
        except subprocess.TimeoutExpired:
            # Killing the Docker client is not proof the sandbox group exited.
            return False


class MemoryCall:
    def __init__(self, key, binding):
        self.key, self.binding = key, binding
        self.cancelled, self.worker = threading.Event(), None
        self.dispatch_started, self.dispatch_done, self.dispatched = threading.Event(), threading.Event(), threading.Event()


def invalidate(key, binding=None):
    with GUARD:
        calls = [call for call in ACTIVE if call.key == key and (binding is None or call.binding == binding)]
        for call in calls:
            call.cancelled.set()
    def close(call):
        confirmed = call.worker is None or call.worker.close()
        if confirmed and call.worker is not None:
            with GUARD:
                ACTIVE.discard(call)
        return confirmed
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(calls)))) as pool:
        confirmed = all(list(pool.map(close, calls)))
    from mcp_runtime import wait_dispatch
    wait_dispatch(calls)
    return confirmed


def fence_workspace(key):
    """Only after Docker confirms the entire owner sandbox has stopped."""
    with GUARD:
        for call in list(ACTIVE):
            if call.key == key:
                call.cancelled.set()
                ACTIVE.discard(call)


def statistics():
    with GUARD:
        return {'active_calls': len(ACTIVE), 'cancel_pending': sum(call.cancelled.is_set() for call in ACTIVE)}


def catalog(source=SOURCE):
    import hashlib
    sys.path.insert(0, source)
    from md_cg.mcp_server import KERNEL_TOOLS
    tools = KERNEL_TOOLS
    manifest = hashlib.sha256(json.dumps(tools, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"id": SERVER_ID, "name": "全局记忆", "version": VERSION, "manifest_version": manifest, "tools": tools}


def validate(name, arguments):
    if name not in {"cg", "stg"} or not isinstance(arguments, dict):
        raise ValueError("记忆工具或参数无效")
    if len(json.dumps(arguments).encode()) > 1024 * 1024:
        raise ValueError("记忆参数超过 1 MiB")
    if any(key in arguments for key in ("root", "source", "owner_id", "workspace_id")):
        raise ValueError("工具参数不能指定记忆存储或用户身份")


def execute(name, arguments, *, root=ROOT, source=SOURCE):
    """root/source are deployment inputs, never accepted from tool arguments."""
    validate(name, arguments)
    sys.path.insert(0, source)
    from md_cg import tokens
    from md_cg.mdcos import MdCGSecure
    from md_cg.mcp_server import call_tool
    from md_cg.fsutil import FileLock

    directory = Path(root)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise ValueError("记忆目录不能是符号链接")
    with FileLock(str(directory / "platform.lock")):
        # Native text writes require a rulebook; use a basic credential exclusion
        # policy rather than bypassing upstream's write/verification pipeline.
        policy = directory / "policy.json"
        if not policy.exists():
            policy.write_text(json.dumps({"required": [r"\S"], "forbidden": [
                r"(?i)(?:password|passwd|api[_ -]?key|access[_ -]?token|密码|令牌)\s*[:=：]\s*\S+",
                r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
            ]}), encoding="utf-8")
        os.environ["MDCG_POLICY_FILE"] = str(policy)
        token_path = directory / "tokens.json"
        secret_path = directory / "token"
        if not secret_path.exists():
            issued = tokens.issue("designer", actor="global-memory", tenant="sandbox-owner",
                                  clearance="internal", delegable=False,
                                  layers_allow=["knowledge", "contextual", "structural", "self", "goals", "unresolved", "rejected"],
                                  ops_allow=["info", "route", "read", "write", "forget", "recent", "goal", "identity", "verify"], path=str(token_path))
            fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(issued["token"])
        principal = tokens.verify_token(secret_path.read_text(), path=str(token_path))
        graph = MdCGSecure(str(directory / "data"), principal=principal, autoflush=1)
        try:
            value = call_tool(graph, name, arguments)
            return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
                    "isError": isinstance(value, dict) and (bool(value.get("error")) or value.get("ok") is False)}
        finally:
            graph.close()


def operate(key, payload, *, docker, ensure, identity, lock, authorize, journal, worker_factory=None):
    from mcp_authorization import validate_grant
    descriptor = catalog()
    if payload.get("operation") == "catalog":
        # Advertise only when the pinned runtime has been included in this image.
        if not (Path(SOURCE) / "md_cg" / "mdcos.py").is_file():
            return {"tools": []}
        return descriptor
    if payload.get("operation") != "call":
        raise ValueError("未知记忆操作")
    deadline = payload.get('deadline_ms', int(time.time() * 1000) + 350_000)
    if not isinstance(deadline, (int, float)) or deadline > time.time() * 1000 + 350_000:
        raise ValueError('Invalid memory deadline')
    if payload.get("version") != descriptor["version"] or payload.get("manifest_version") != descriptor["manifest_version"]:
        return {"conflict": True}
    tool, arguments = payload.get("tool"), payload.get("arguments")
    validate(tool, arguments)
    grant = payload.get("authorization") or {}
    binding = validate_grant(key, payload, 'global:mcp:' + SERVER_ID + ':' + tool)
    call = MemoryCall(key, binding)
    with GUARD:
        if len(ACTIVE) >= 32 or sum(item.key == key for item in ACTIVE) >= 8:
            return {'error': '记忆调用达到并发上限，本次操作未执行', 'code': 'MCP_BUSY'}
        ACTIVE.add(call)
    digest = None
    try:
        if not authorize({"authorization": grant, "action": "validate"}):
            return {"error": "记忆调用授权已失效，本次操作未执行"}
        if deadline <= time.time() * 1000:
            return {"error": "记忆调用已过期，本次操作未执行", "code": "MCP_DEADLINE_EXCEEDED"}
        reservation = {field: payload[field] for field in ("tool", "arguments", "version", "manifest_version", "request_key")}
        previous = journal.lookup(key, reservation)
        if previous is not None:
            return previous
        with lock(key):
            if call.cancelled.is_set():
                return {'error': '记忆调用已停止，本次操作未执行'}
            ensure(key)
            container, _ = identity(key)
            check = docker("exec", "--user", "0", container, "test", "-f", SOURCE + "/.ready", check=False)
            if check.returncode:
                # Only preparation holds the workspace lock; business execution
                # is supervised separately and can always be cancelled.
                docker("exec", "--user", "0", container, "mkdir", "-p", SOURCE)
                docker("cp", SOURCE + "/.", container + ":" + SOURCE)
                docker("exec", "--user", "0", container, "touch", SOURCE + "/.ready")
        with GUARD:
            if call.cancelled.is_set():
                return {'error': '记忆调用已停止，本次操作未执行'}
            call.worker = (worker_factory or MemoryWorker)(container)
        ready = call.worker.response(call.cancelled, timeout=min(10, max(0, (deadline - time.time() * 1000) / 1000)))
        if not ready.get('ready'):
            return ready
        digest, previous = journal.begin(key, reservation)
        if previous is not None:
            return previous
        if not authorize({"authorization": grant, "action": "consume"}):
            result = {"error": "记忆调用授权已失效，本次操作未执行"}
            journal.finish(digest, result)
            return result
        try:
            with GUARD:
                remaining = min(60, (deadline - time.time() * 1000) / 1000)
                if call.cancelled.is_set() or remaining <= 0:
                    output = {'error': '记忆调用已停止或过期，本次操作未执行'}
                else:
                    output = None
            if output is None:
                from mcp_runtime import send_bound
                output = send_bound(call, journal, digest, lambda on_dispatch: call.worker.send(tool, arguments, remaining, call.cancelled, on_dispatch))
            if output is None:
                output = call.worker.response(call.cancelled, timeout=max(0, remaining))
        except Exception:
            output = {"error": "记忆调用结果未知，请先检索核实，勿重复写入", "uncertain": True}
        journal.finish(digest, output)
        return output
    finally:
        confirmed = call.worker is None or call.worker.close()
        with GUARD:
            if confirmed:
                ACTIVE.discard(call)


def install():
    import io
    import tarfile
    from urllib.request import urlopen
    target = Path(SOURCE)
    url = "https://codeload.github.com/FuRongJun-1999/dsh-memory/tar.gz/" + REVISION
    with urlopen(url, timeout=120) as response:
        data = response.read(50 * 1024 * 1024 + 1)
    if len(data) > 50 * 1024 * 1024:
        raise ValueError("Memory source archive exceeds limit")
    prefix = "dsh-memory-" + REVISION + "/"
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for item in archive:
            relative = item.name.removeprefix(prefix)
            if not item.name.startswith(prefix) or not (relative.startswith("md_cg/") or relative == "LICENSE"):
                continue
            if not item.isfile() or ".." in Path(relative).parts:
                continue
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(item) as source:
                destination.write_bytes(source.read())
            destination.chmod(0o644)
    if not (target / "md_cg/mdcos.py").is_file():
        raise ValueError("Missing memory runtime")


if __name__ == "__main__":
    if sys.argv[1:] == ["--install"]:
        install()
    else:
        request = json.load(sys.stdin)
        try:
            result = execute(request["tool"], request["arguments"])
        except Exception:
            result = {"isError": True, "content": [{"type": "text", "text": "记忆操作失败，未确认完成，请稍后核实。"}]}
        print(json.dumps(result, ensure_ascii=False))
