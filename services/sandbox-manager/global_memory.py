"""Platform memory backed by dsh-memory, always executed in the owner's sandbox."""
import json
import os
import sys
import time
import threading
import subprocess
import queue
import copy
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REVISION = "bf846ebffca0d33c6d3b1468e12e16c7358fd715"
VERSION = "2-" + REVISION[:12]
SERVER_ID = "global-memory"
SOURCE = "/opt/gxzs-global-memory/" + REVISION
ROOT = "/home/dify/.gxzs-global-memory"
ACTIVE = set()
GUARD = threading.RLock()
CG_OPS = ("info", "route", "read", "write", "forget", "recent", "goal", "identity", "verify")
STG_OPS = ("relation", "timeline", "anchors", "consistency")
LAYERS = ("knowledge", "contextual", "structural", "self", "goals", "unresolved", "rejected")
IDENTITY_ACTIONS = ("observe", "trait", "profile", "positions", "catalog", "history")
ACTION_HELP = ("identity: observe 记录主体事实(content+subject_id)，trait 记录特征(trait+subject_id)，"
               "profile/positions/catalog/history 查询；没有 add 或 anchor。"
               "goal: add/list/status/set_status；recent: add/append/remember/list/clear；"
               "forget: forget/restore。普通事实请用 op=write，不需要 action。")


class MemoryInputError(ValueError):
    """A platform precondition rejected before invoking the memory engine."""


def error_result(message, *, uncertain=False):
    return {"isError": True, "uncertain": uncertain,
            "code": "MEMORY_RESULT_UNKNOWN" if uncertain else "MEMORY_INVALID_ARGUMENTS",
            "content": [{"type": "text", "text": message}]}


def tool_result(name, arguments, value):
    failed = isinstance(value, dict) and (bool(value.get("error")) or value.get("ok") is False)
    # cg.info returns bucket_health at its root. Its ok flag describes index
    # health, not whether the diagnostic operation ran. Recognize that specific
    # report shape; malformed reports and actual engine errors remain failures.
    health_warning = (
        name == "cg" and arguments.get("op") == "info" and isinstance(value, dict)
        and value.get("ok") is False and "error" not in value
        and all(type(value.get(key)) is int and value[key] >= 0 for key in ("buckets", "nodes", "total_nodes"))
        and isinstance(value.get("os"), dict)
        and isinstance(value.get("problems"), list) and bool(value["problems"])
        and all(isinstance(problem, str) for problem in value["problems"])
    )
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
            "isError": failed and not health_warning}


def platform_tools(upstream):
    """Publish the capabilities of our restricted owner principal, not upstream admin tools."""
    tools = copy.deepcopy(upstream)
    for tool in tools:
        properties = tool["inputSchema"]["properties"]
        ops = CG_OPS if tool["name"] == "cg" else STG_OPS
        properties["op"] = {"type": "string", "enum": list(ops), "description": "必填；明确选择操作，不会按其他参数猜测。"}
        properties["layer"] = {"type": "string", "enum": list(LAYERS), "description": "默认 knowledge；用户事实和偏好使用 knowledge。平台不开放 anchor 写入。"}
        if tool["name"] == "cg":
            tool["description"] = (
                "当前用户跨会话记忆，必须显式传 op。常用："
                "写入 {\"op\":\"write\",\"content\":\"用户希望使用中文\",\"content_kind\":\"text\",\"layer\":\"knowledge\"}；"
                "检索 {\"op\":\"read\",\"query\":\"语言偏好\"}；"
                "更正已有事实：read 得到节点 id 后，以相同 node_id 调用 write 并提供完整新 content，勿重复创建。"
                "只开放 info/route/read/write/forget/recent/goal/identity/verify。" + ACTION_HELP +
                "写入结果 committed=true 才表示正式记忆已提交；committed=false 或审核拒绝/待审核不得声称已记住。"
                "结果未知时先按 node_id 或内容检索核实，勿重放写入。")
            properties["action"] = {"type": "string", "description": ACTION_HELP}
            properties["content"] = {**properties["content"], "description": "op=write 必填，完整记忆正文；修改时同时提供已有 node_id。普通文字同时传 content_kind=text。"}
            properties["node_id"] = {**properties["node_id"], "description": "已有节点 id；read 读取，write 更新同一节点，forget 遗忘。"}
        else:
            tool["description"] = "查询当前用户记忆的时间与空间关系；必须显式传 op：relation(节点 a+b)、timeline、anchors 或 consistency。"
    return tools


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


def binding_inflight(key, binding):
    with GUARD:
        return any(call.key == key and call.binding == binding for call in ACTIVE)


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
    tools = platform_tools(KERNEL_TOOLS)
    manifest = hashlib.sha256(json.dumps(tools, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"id": SERVER_ID, "name": "全局记忆", "version": VERSION, "manifest_version": manifest, "tools": tools}


def validate(name, arguments):
    if name not in {"cg", "stg"} or not isinstance(arguments, dict):
        raise MemoryInputError("记忆工具或参数无效")
    if len(json.dumps(arguments).encode()) > 1024 * 1024:
        raise MemoryInputError("记忆参数超过 1 MiB")
    if any(key in arguments for key in ("root", "source", "owner_id", "workspace_id")):
        raise MemoryInputError("工具参数不能指定记忆存储或用户身份")
    ops = CG_OPS if name == "cg" else STG_OPS
    if arguments.get("op") not in ops:
        raise MemoryInputError("op 为必填参数，允许：" + ", ".join(ops) + "。本次操作未执行。")
    if "layer" in arguments and arguments["layer"] not in LAYERS:
        raise MemoryInputError("平台不开放该记忆层；普通事实或偏好请使用 layer=knowledge。本次操作未执行。")
    if name == "cg" and arguments["op"] == "identity":
        action = arguments.get("action", "profile")
        if action not in IDENTITY_ACTIONS:
            raise MemoryInputError("identity 的 action 允许：" + ", ".join(IDENTITY_ACTIONS) + "；记录普通事实也可用 op=write。本次操作未执行。")
    if name == "cg" and arguments["op"] == "write":
        if not isinstance(arguments.get("content"), str) or not arguments["content"].strip():
            raise MemoryInputError("op=write 需要非空 content；普通文字同时传 content_kind=text。本次操作未执行。")


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
                                  layers_allow=list(LAYERS), ops_allow=list(CG_OPS), path=str(token_path))
            fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as stream:
                stream.write(issued["token"])
        principal = tokens.verify_token(secret_path.read_text(), path=str(token_path))
        graph = MdCGSecure(str(directory / "data"), principal=principal, autoflush=1)
        value = None
        try:
            value = call_tool(graph, name, arguments)
        finally:
            try:
                graph.close()
            except Exception:
                # A known committed write must not become an apparent failed
                # write merely because later index flush/cleanup raised.
                if isinstance(value, dict) and value.get("committed") is True:
                    value["warning"] = "记忆已提交，但后续同步未确认；可按节点 id 核实当前状态。"
                else:
                    raise
        return tool_result(name, arguments, value)


def run_request(request, *, root=ROOT, source=SOURCE):
    try:
        return execute(request["tool"], request["arguments"], root=root, source=source)
    except MemoryInputError as error:
        return error_result(str(error))
    except Exception:
        # The engine can raise after writing the node or its audit ledger.
        # Neither a ValueError nor an AccessDenied proves rollback here.
        return error_result("记忆调用结果未知，可按节点 id 或内容检索核实后再决定是否重试。", uncertain=True)


def operate(key, payload, *, docker, ensure, identity, lock, authorize, worker_factory=None):
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
    try:
        validate(tool, arguments)
    except MemoryInputError as error:
        return error_result(str(error))
    grant = payload.get("authorization") or {}
    binding = validate_grant(key, payload, 'global:mcp:' + SERVER_ID + ':' + tool)
    call = MemoryCall(key, binding)
    with GUARD:
        if len(ACTIVE) >= 32 or sum(item.key == key for item in ACTIVE) >= 8:
            return {'error': '记忆调用达到并发上限，本次操作未执行', 'code': 'MCP_BUSY'}
        ACTIVE.add(call)
    try:
        if not authorize({"authorization": grant, "action": "validate"}):
            return {"error": "记忆调用授权已失效，本次操作未执行"}
        if deadline <= time.time() * 1000:
            return {"error": "记忆调用已过期，本次操作未执行", "code": "MCP_DEADLINE_EXCEEDED"}
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
        if not authorize({"authorization": grant, "action": "consume"}):
            return {"error": "记忆调用授权已失效，本次操作未执行"}
        try:
            with GUARD:
                remaining = min(60, (deadline - time.time() * 1000) / 1000)
                if call.cancelled.is_set() or remaining <= 0:
                    output = {'error': '记忆调用已停止或过期，本次操作未执行'}
                else:
                    output = None
            if output is None:
                from mcp_runtime import send_checked
                output = send_checked(call, lambda on_dispatch: call.worker.send(tool, arguments, remaining, call.cancelled, on_dispatch))
            if output is None:
                output = call.worker.response(call.cancelled, timeout=max(0, remaining))
        except Exception:
            output = {"error": "记忆调用结果未知，可检索核实后重试", "uncertain": True}
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
        result = run_request(request)
        print(json.dumps(result, ensure_ascii=False))
