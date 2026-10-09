"""Private container control plane; exposes no arbitrary Docker or shell operation."""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import re
import sqlite3
from pathlib import Path
import subprocess
import threading
import time
import uuid
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from urllib.request import ProxyHandler, Request, build_opener

from admission import Admission
from owner_auth import authorize as authorize_request


LOGGER = logging.getLogger(__name__)

TOKEN = os.environ["WORKBENCH_SANDBOX_MANAGER_TOKEN"]
IMAGE = os.environ.get("WORKBENCH_SANDBOX_IMAGE", "langgenius/dify-agent-local-sandbox:1.17.1")
NETWORK = os.environ.get("WORKBENCH_SANDBOX_NETWORK", "dify-workbench-sandboxes")
PREFIX = os.environ.get("WORKBENCH_SANDBOX_PREFIX", "dify-wb-dev")
STATE = Path(os.environ.get("WORKBENCH_MANAGER_STATE", "/state"))
STATE.mkdir(parents=True, exist_ok=True)
os.chmod(STATE, 0o700)
LOCKS = {}
LOCKS_GUARD = threading.Lock()
REQUEST_CONTEXT = threading.local()
OPERATION_CAPACITY = threading.BoundedSemaphore(int(os.environ.get('WORKBENCH_MANAGER_MAX_OPERATIONS', '24')))
CONTROL_ACTIONS = frozenset({'stop-binding', 'fence-binding', 'schedule', 'runtime-epoch', 'touch', 'diagnostics'})
MAX_BODY = 30 * 1024 * 1024
ADMISSION = Admission(str(STATE / 'admission.sqlite3'))
MCP_API_URL = os.environ.get("WORKBENCH_MCP_API_URL", "http://wb-api:5001").rstrip("/")
HEALTH = {'reaper': 0.0, 'hosts': 0.0}
HEALTH_GUARD = threading.Lock()
MCP_REFRESH_GUARD = threading.Lock()
MCP_REFRESHING = set()
MCP_REFRESH_ATTEMPTS = {}
INSTALL_TIMEOUT = int(os.environ.get('WORKBENCH_ENVIRONMENT_TIMEOUT_SECONDS', '900'))
OPERATION_RETENTION = int(os.environ.get('WORKBENCH_OPERATION_RETENTION_SECONDS', str(7 * 86400)))
# Manager-owned scripts never inherit a user's interpreter, import path or
# site initialization. User tasks keep their personal-environment-first PATH.
MANAGER_PYTHON = ("/usr/local/bin/python", "-I", "-S")


def schedule_mcp_refresh(key, items):
    """Refresh expired personal catalogs without making list reads wait for a provider."""
    for item in items:
        if not isinstance(item, dict) or not item.get("enabled") or item.get("status") != "unverified" or not item.get("version"):
            continue
        identity = key, item["id"]
        with MCP_REFRESH_GUARD:
            if (len(MCP_REFRESHING) >= 8 or identity in MCP_REFRESHING
                    or time.monotonic() - MCP_REFRESH_ATTEMPTS.get(identity, -float("inf")) < 30):
                continue
            if len(MCP_REFRESH_ATTEMPTS) > 1024:
                cutoff = time.monotonic() - 60
                for previous, attempted in list(MCP_REFRESH_ATTEMPTS.items()):
                    if attempted < cutoff and previous not in MCP_REFRESHING:
                        MCP_REFRESH_ATTEMPTS.pop(previous, None)
            MCP_REFRESH_ATTEMPTS[identity] = time.monotonic()
            MCP_REFRESHING.add(identity)

        def refresh(target=identity):
            try:
                operation(target[0], "personal-mcp", {"operation": "mcp_test", "name": target[1],
                                                      "deadline_ms": int(time.time() * 1000) + 30_000})
            except Exception:
                LOGGER.warning("Personal MCP catalog refresh failed for %s", target[1])
            finally:
                with MCP_REFRESH_GUARD:
                    MCP_REFRESHING.discard(target)

        threading.Thread(target=refresh, name="mcp-catalog-refresh", daemon=True).start()


def docker(*args, stdin=None, timeout=90, check=True):
    result = subprocess.run(["docker", *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        # Never echo command arguments (which may contain the sandbox auth token).
        raise RuntimeError(result.stderr[-2000:] or "Docker operation failed")
    return result


class SandboxUpdatePending(RuntimeError):
    pass


def tick(worker):
    with HEALTH_GUARD:
        HEALTH[worker] = time.monotonic()


def network_name(key):
    return NETWORK + '-' + hashlib.sha256(key.encode()).hexdigest()[:16]


def ensure_network(key):
    """Create one owner bridge; never attach the manager or another owner."""
    key = str(uuid.UUID(key))
    name = network_name(key)
    result = docker('network', 'inspect', name, check=False)
    if result.returncode:
        docker('network', 'create', '--driver', 'bridge', '--label', 'workbench=' + PREFIX,
               '--label', 'gxzs.workspace=' + key, name)
        result = docker('network', 'inspect', name)
    info = json.loads(result.stdout)[0]
    labels = info.get('Labels') or {}
    if labels.get('workbench') != PREFIX or labels.get('gxzs.workspace') != key:
        raise ValueError('Owner network identity mismatch')
    return name


@contextmanager
def lock(key):
    with LOCKS_GUARD:
        entry = LOCKS.setdefault(key, [threading.RLock(), 0])
        entry[1] += 1
        mutex = entry[0]
    try:
        with mutex:
            context = getattr(REQUEST_CONTEXT, "owner", None)
            if context is not None:
                headers, workspace, action = context
                if workspace != key:
                    raise PermissionError("Manager workspace mismatch")
                authorize_request(headers, TOKEN, HOSTS.root, workspace, action)
            yield
    finally:
        with LOCKS_GUARD:
            entry[1] -= 1
            if entry[1] == 0 and LOCKS.get(key) is entry:
                LOCKS.pop(key, None)


def identity(key):
    key = str(uuid.UUID(key))
    name = PREFIX + "-" + key
    token = hmac.new(TOKEN.encode(), key.encode(), hashlib.sha256).hexdigest()
    return name, token


def touch(key):
    (STATE / key).touch()


def operation_file(key, request_id):
    digest = hashlib.sha256((key + ":" + request_id).encode()).hexdigest()
    return STATE / ("op-" + digest), PREFIX + "-install-" + digest[:24]


def save_operation(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    os.replace(temporary, path)


def ensure(key):
    name, token = identity(key)
    with lock(key):
        network = ensure_network(key)
        record = HOSTS.root / key / 'host.json'
        home_volume = None
        if record.exists():
            host = json.loads(record.read_text(encoding='utf-8'))
            home_volume = host.get('home_volume')
            if host.get('workspace_id') != key or not isinstance(home_volume, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]+', home_volume):
                raise ValueError('Invalid owner attachment volume')
        attachment_mount = (['--mount', 'type=volume,source=' + home_volume
                             + ',destination=/srv/dsh/attachments,volume-subpath=attachments,readonly'] if home_volume else [])
        info = docker("inspect", name, check=False)
        if not info.returncode:
            existing = json.loads(info.stdout)[0]
            attached = set((existing.get('NetworkSettings', {}).get('Networks') or {}).keys())
            mounted_home = (existing['Config'].get('Labels') or {}).get('gxzs.attachment-home')
            if existing["Config"]["Image"] != IMAGE or attached != {network} or mounted_home != home_volume:
                if existing["State"]["Running"]:
                    # Do not execute privileged helpers in a previous image.
                    # Deployment drains its runs before stopping/recreating it.
                    raise SandboxUpdatePending("个人沙箱正在更新，请稍后重试；数据和环境已保留")
                # Keep the stopped container as a rollback reference and reuse all owner volumes.
                docker("rename", name, name + "-previous-" + existing["Id"][:12])
                info = docker("inspect", name, check=False)
        if info.returncode:
            if home_volume:
                docker('volume', 'create', '--label', 'gxzs.owner=' + host['owner_id'], home_volume)
                docker('run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', MANAGER_PYTHON[0],
                       '-v', home_volume + ':/srv/dsh', IMAGE, *MANAGER_PYTHON[1:], '-c',
                       "import os; p='/srv/dsh/attachments'; "
                       "assert not os.path.islink(p), 'Attachment root cannot be a symlink'; "
                       "os.makedirs(p,exist_ok=True); os.chown(p,1000,1000); os.chmod(p,0o700)")
            for suffix in ("home", "files", "env"):
                docker("volume", "create", "--label", "workbench=" + PREFIX, name + "-" + suffix)
            docker("run", "--rm", "--user", "0", "--network", "none", "--entrypoint", MANAGER_PYTHON[0],
                   "-v", name + "-home:/home/dify", "-v", name + "-files:/workspace", "-v", name + "-env:/opt/user-env",
                   IMAGE, *MANAGER_PYTHON[1:], "-c", "import os; paths=['/home/dify','/workspace','/workspace/conversations','/workspace/" + key + "','/opt/user-env']; "
                   "[(os.makedirs(p,exist_ok=True),os.chown(p,1000,1000)) for p in paths]")
            # Existing personal venvs gain the immutable office fallback without replacing their packages.
            docker("run", "--rm", "--user", "1000", "--network", "none", "--entrypoint", MANAGER_PYTHON[0],
                   "-v", name + "-env:/opt/user-env", IMAGE, *MANAGER_PYTHON[1:], "-c",
                   "from pathlib import Path; site=Path('/opt/user-env/current/python/lib/python3.12/site-packages'); "
                   "base=Path('/opt/office/python/lib/python3.12/site-packages'); "
                   "(site/'workbench_office.pth').write_text(str(base)+'\\n') if site.exists() and base.exists() else None")
            docker("create", "--name", name, "--label", "workbench=" + PREFIX,
                   '--label', 'gxzs.workspace=' + key, "--network", network,
                   *(['--label', 'gxzs.attachment-home=' + home_volume] if home_volume else []), *attachment_mount,
                   '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
                   "--cpus", os.environ.get("WORKBENCH_SANDBOX_CPUS", "1"),
                   "--memory", os.environ.get("WORKBENCH_SANDBOX_MEMORY", "3g"),
                   "--memory-swap", os.environ.get("WORKBENCH_SANDBOX_MEMORY", "3g"), "--pids-limit", "256",
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                   "-v", name + "-home:/home/dify", "-v", name + "-files:/workspace",
                   "-v", name + "-env:/opt/user-env:ro",
                   "-e", "SHELLCTL_AUTH_TOKEN=" + token,
                   "-e", "PATH=/opt/user-env/current/python/bin:/opt/office/python/bin:/opt/user-env/current/node/node_modules/.bin:/opt/office/node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
                   "-e", "NODE_PATH=/opt/user-env/current/node/node_modules:/opt/office/node/node_modules", IMAGE)
        docker("start", name)
        docker("exec", "--user", "0", name, *MANAGER_PYTHON, "-c",
               "import os; os.makedirs('/opt/workbench-global', mode=0o755, exist_ok=True)")
        touch(key)
        return {"endpoint": "http://" + name + ":5004", "auth_token": token}


def runtime_epoch():
    # One fixed, single-process Agent backend is the deployment authority.
    name = os.environ["WORKBENCH_RUNTIME_CONTAINER"]
    info = json.loads(docker("inspect", name).stdout)[0]
    epoch = hashlib.sha256((info["Id"] + ":" + info["State"]["StartedAt"]).encode()).hexdigest()
    return {"epoch": epoch, "running": info["State"]["Running"]}


def stop_binding(key, binding):
    from planning import InspectionAdmission, stop_inspections

    binding = str(uuid.UUID(binding))
    inspection_count = stop_inspections(key, binding, docker=docker, prefix=PREFIX,
                                        admission=InspectionAdmission(STATE, lambda value: lock('planning:' + value)))
    name, _ = identity(key)
    info = docker("inspect", name, check=False)
    if info.returncode or not json.loads(info.stdout)[0]["State"]["Running"]:
        return {"stopped": inspection_count}
    script = Path(__file__).with_name("stop_jobs.py").read_text()
    result = docker("exec", "--user", "1000", "-i", name, *MANAGER_PYTHON, "-c", script,
                    stdin=json.dumps({"binding_id": binding}))
    output = json.loads(result.stdout)
    output["stopped"] = output.get("stopped", 0) + inspection_count
    return output


def authorize_mcp(payload):
    """Only the configured API can confirm a currently owned execution."""
    context = getattr(REQUEST_CONTEXT, "owner", None)
    if context is not None:
        with lock(context[1]):
            pass
    request = Request(MCP_API_URL + "/internal/ai/mcp/authorize",
                      data=json.dumps(payload).encode(), method="POST",
                      headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    try:
        with build_opener(ProxyHandler({})).open(request, timeout=5) as response:
            return json.loads(response.read(1024)).get("authorized") is True
    except Exception:
        return False


def operation(key, action, payload):
    name, _ = identity(key)
    if action == "global-memory":
        from global_memory import operate
        return operate(key, payload, docker=docker, ensure=ensure, identity=identity,
                       lock=lock, authorize=authorize_mcp)
    if action == 'ensure-host':
        return HOSTS.ensure(key, payload)
    if action == 'replace-host':
        return HOSTS.replace(key, payload)
    if action == 'diagnostics':
        from mcp_runtime import statistics
        from global_memory import statistics as memory_statistics
        return {"mcp": statistics(), "memory": memory_statistics(), "workspace_locks": len(LOCKS)}
    if action == 'schedule':
        return HOSTS.schedule(key, payload)
    if action == "runtime-epoch":
        return runtime_epoch()
    if action in ("stop-binding", "fence-binding"):
        # MCP cancellation never waits for a workspace operation or tool call.
        # The epoch check still owns permission to fence an apparently live run.
        if action == "fence-binding":
            previous = payload.get("epoch", "")
            if len(previous) != 64 or any(ch not in "0123456789abcdef" for ch in previous):
                raise ValueError("Invalid runtime epoch")
            current = runtime_epoch()
            if current["running"] and current["epoch"] == previous:
                return {"fenced": False}
        from mcp_runtime import invalidate, binding_inflight as mcp_inflight
        from global_memory import invalidate as cancel_memory, binding_inflight as memory_inflight
        from mcp_outcomes import has_unconfirmed

        binding = str(uuid.UUID(payload['binding_id']))
        try:
            uncertain = has_unconfirmed(key, binding)
        except (sqlite3.Error, OSError):
            LOGGER.exception('Unable to read MCP outcome state during stop')
            uncertain = True
        uncertain = uncertain or mcp_inflight(key, binding) or memory_inflight(key, binding)
        with ThreadPoolExecutor(max_workers=2) as pool:
            mcp_cancel = pool.submit(invalidate, key, binding=binding)
            memory_cancel = pool.submit(cancel_memory, key, binding=binding)
            mcp_stopped, memory_stopped = mcp_cancel.result(), memory_cancel.result()
        result = stop_binding(key, payload["binding_id"])
        return {**result, "fenced": memory_stopped and mcp_stopped,
                'uncertain': uncertain}
    if action == "ensure":
        return ensure(key)
    if action == "touch":
        touch(key)
        return {"ok": True}
    if action in ("plan-admission", "plan-inspect"):
        from planning import InspectionAdmission, inspect_plan

        admission = InspectionAdmission(STATE, lambda value: lock('planning:' + value))
        if action == "plan-admission":
            return {"ticket": admission.ticket(key, payload["binding_id"])}
        return inspect_plan(
            key, payload, docker=docker, ensure=ensure, identity=identity,
            image=IMAGE, prefix=PREFIX, manager_python=MANAGER_PYTHON, admission=admission,
        )
    if action == "personal-mcp":
        from mcp_runtime import invalidate, invoke, module_source

        allowed = {"mcp_list", "mcp_read", "mcp_save", "mcp_delete", "mcp_toggle", "mcp_pin", "mcp_test", "mcp_call"}
        if payload.get("operation") not in allowed:
            raise ValueError("Unsupported MCP operation")
        with lock(key):
            ensure(key)
            request = payload
            if payload["operation"] in {"mcp_test", "mcp_call"}:
                request = {"operation": "mcp_probe", "name": payload.get("name")}
            source = module_source("file_ops", "resource_ops", "mcp_ops")
            source += "import json; print(json.dumps(sys.modules['mcp_ops'].personal_mcp(json.load(sys.stdin))))"
            result = docker("exec", "--user", "1000", "-i", name, *MANAGER_PYTHON, "-c", source,
                            stdin=json.dumps(request), check=False)
            if result.returncode:
                # Parse errors and tracebacks may include user-supplied secrets.
                raise ValueError("MCP 配置操作失败，请检查 JSON、路径和版本")
            output = json.loads(result.stdout)
            touch(key)
        if payload["operation"] in {"mcp_save", "mcp_delete", "mcp_toggle"} and not output.get("conflict"):
            invalidate(key, payload["name"])
        if payload["operation"] in {"mcp_test", "mcp_call"}:
            output = invoke(key, name, payload, output, authorize=authorize_mcp)
        elif payload["operation"] == "mcp_list":
            schedule_mcp_refresh(key, output.get("mcp", []))
        touch(key)
        return output
    if action == "office-preview":
        # No owner volumes, credentials, network or writable image are exposed.
        preview_name = PREFIX + "-preview-" + uuid.uuid4().hex
        with lock(key):
            try:
                script = Path(__file__).with_name("office_preview.py").read_text()
                result = docker("run", "--rm", "--name", preview_name, "--network", "none",
                                "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=256m",
                                "--user", "1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                                "--memory", "1g", "--cpus", "1", "--pids-limit", "128", "-e", "HOME=/tmp",
                                "--entrypoint", MANAGER_PYTHON[0], "-i", IMAGE, *MANAGER_PYTHON[1:], "-c", script,
                                stdin=json.dumps(payload), timeout=55, check=False)
                output = json.loads(result.stdout or "{}")
                if result.returncode or not output.get("data"):
                    raise ValueError(output.get("error", "文档排版失败"))
                return output
            except subprocess.TimeoutExpired as error:
                raise ValueError("文档排版超时，请下载原文件查看") from error
            finally:
                docker("rm", "-f", preview_name, check=False)
    if action == "files":
        with lock(key):
            ensure(key)
            script = Path(__file__).with_name("file_ops.py").read_text()
            result = docker("exec", "--user", "1000", "-i", name, *MANAGER_PYTHON, "-c", script,
                            stdin=json.dumps(payload), check=False)
            output = json.loads(result.stdout or "{}")
            if result.returncode and not output.get("conflict"):
                raise ValueError(output.get("error", "File operation failed"))
            return output
    if action in ("personal-resources", "global-resources"):
        with lock(key):
            ensure(key)
            if action == "personal-resources" and payload.get("operation") == "global_install":
                raise ValueError("Global resources are read-only")
            if action == "global-resources" and payload.get("operation") != "global_install":
                raise ValueError("Unsupported global resource operation")
            helper = Path(__file__).with_name("file_ops.py").read_text()
            script = Path(__file__).with_name("resource_ops.py").read_text()
            source = (
                "import types,sys; helper=types.ModuleType('file_ops'); exec(" + repr(helper)
                + ",helper.__dict__); sys.modules['file_ops']=helper; exec(" + repr(script) + ")"
            )
            result = docker("exec", "--user", "0" if action == "global-resources" else "1000", "-i",
                            name, *MANAGER_PYTHON, "-c", source, stdin=json.dumps(payload), check=False)
            output = json.loads(result.stdout or "{}")
            if result.returncode and not output.get("conflict"):
                raise ValueError(output.get("error", "Resource operation failed"))
            return output
    if action == "environment":
        with lock(key):
            ensure(key)
            request_id = payload.get("request_id", "")
            if not request_id or len(request_id) > 128:
                raise ValueError("Environment update requires a stable request ID")
            record, installer = operation_file(key, request_id)
            if record.exists():
                return operation(key, "environment-status", {"request_id": request_id})
            installing = {"status": "installing", "deadline": time.time() + INSTALL_TIMEOUT + 30}
            save_operation(record, installing)
            script = Path(__file__).with_name("environment.py").read_text()
            # No Home, files, Docker socket or credentials are mounted into the installer.
            try:
                result = docker("run", "--rm", "--name", installer, "--user", "1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                    "--memory", "1g", "--cpus", "1", "--pids-limit", "256", "--entrypoint", MANAGER_PYTHON[0],
                    "-v", name + "-env:/opt/user-env", "-i", IMAGE, *MANAGER_PYTHON[1:], "-c", script,
                    stdin=json.dumps(payload), timeout=INSTALL_TIMEOUT)
                output = json.loads(result.stdout)
            except subprocess.TimeoutExpired:
                # The installer may still be running. Keep the gate closed until its outcome is known.
                return installing
            except Exception as error:
                # Installer stderr contains package diagnostics, never sandbox credentials.
                record.with_suffix(".error.log").write_text(str(error)[-12000:])
                output = {"status": "failed", "message": "安装失败，原共享环境已保留。"}
            save_operation(record, output)
            return output
    if action == "environment-status":
        record, installer = operation_file(key, payload.get("request_id", ""))
        if not record.exists():
            return {"status": "failed", "message": "安装请求未执行，原环境已保留。"}
        value = json.loads(record.read_text())
        if value.get("status") != "installing":
            return value
        result = docker("inspect", "--format", "{{.State.Running}}", installer, check=False)
        if result.returncode == 0 and result.stdout.strip() == "true":
            if time.time() > float(value.get('deadline', 0)):
                docker('rm', '-f', installer, check=False)
                value = {"status": "failed", "message": "安装超时，原环境已保留。"}
                save_operation(record, value)
            return value
        # Recover a switch that completed just before a manager restart.
        current = docker("exec", "--user", "1000", name, *MANAGER_PYTHON, "-c",
                         "from pathlib import Path; p=Path('/opt/user-env/current/request.json'); print(p.read_text() if p.exists() else '{}')", check=False)
        try:
            applied = json.loads(current.stdout).get("request_id") == payload.get("request_id")
        except ValueError:
            applied = False
        value = {"status": "ready" if applied else "failed", "message": "环境已更新。" if applied else "安装中断，原环境已保留。"}
        save_operation(record, value)
        return value
    if action == "clean-binding":
        from planning import scratch_name

        binding = str(uuid.UUID(payload["binding_id"]))
        with lock(key):
            stop_binding(key, binding)
            ensure(key)
            docker("exec", "--user", "1000", name, *MANAGER_PYTHON, "-c",
                   "import shutil; shutil.rmtree('/home/dify/" + binding + "',ignore_errors=True); "
                   "shutil.rmtree('/workspace/conversations/" + binding + "',ignore_errors=True)")
            docker("volume", "rm", scratch_name(name, binding), check=False)
            return {"ok": True}
    raise ValueError("Unsupported operation")


from hosts import Hosts
HOSTS = Hosts(STATE, docker, ensure, identity, lock, ADMISSION, ensure_network)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path != '/healthz':
            self.send_error(404)
            return
        errors = []
        now = time.monotonic()
        with HEALTH_GUARD:
            workers = dict(HEALTH)
        for worker, seen in workers.items():
            if seen <= 0 or now - seen > 120:
                errors.append(worker + '_stale')
        try:
            if not ADMISSION.ping():
                errors.append('admission_unavailable')
        except Exception:
            errors.append('admission_unavailable')
        try:
            docker('version', '--format', '{{.Server.Version}}', timeout=5)
        except Exception:
            errors.append('docker_unavailable')
        data = json.dumps({'ok': not errors, 'errors': errors}).encode()
        self.send_response(200 if not errors else 503)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        code = 200
        admitted = False
        request_id = uuid.uuid4().hex[:12]
        key = action = role = 'unresolved'
        try:
            parts = self.path.strip("/").split("/")
            if len(parts) != 3 or parts[0] != "sandboxes":
                raise ValueError("Unsupported route")
            key = str(uuid.UUID(parts[1]))
            action = parts[2]
            # Hold the workspace lock only for identity validation. Provisioning
            # and replacement revoke old identities before any destructive step.
            # Root cancellation must reach in-flight process supervisors even
            # while another operation owns the workspace preparation lock.
            if hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
                role = 'root'
            else:
                with lock(key):
                    role = authorize_request(self.headers, TOKEN, HOSTS.root, key, parts[2])
            if role == 'owner':
                REQUEST_CONTEXT.owner = (self.headers, key, parts[2])
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= MAX_BODY:
                raise ValueError("Request too large")
            payload = json.loads(self.rfile.read(size) or "{}")
            if not isinstance(payload, dict):
                raise ValueError('Request must be an object')
            if parts[2] not in CONTROL_ACTIONS:
                admitted = OPERATION_CAPACITY.acquire(blocking=False)
                if not admitted:
                    raise CapacityError('Sandbox manager is busy; operation was not started')
            output = operation(key, parts[2], payload)
            if output.get("conflict"):
                code = 409
        except CapacityError as error:
            code, output = 503, {'error': str(error), 'code': 'MANAGER_BUSY'}
        except SandboxUpdatePending as error:
            code, output = 503, {'error': str(error), 'code': 'SANDBOX_UPDATING', 'retry_after': 5}
        except PermissionError as error:
            code, output = 403, {"error": str(error), "code": "MANAGER_FORBIDDEN"}
        except (ValueError, OSError) as error:
            code, output = 400, {"error": str(error)}
        except Exception:
            # Keep the full traceback server-side with a correlation id, but
            # never log request bodies, authorization headers or user files.
            LOGGER.exception('Sandbox request failed request_id=%s workspace=%s action=%s role=%s',
                             request_id, key, action, role)
            code, output = 503, {"error": "Sandbox operation failed; current data and environment retained",
                                 "request_id": request_id}
        finally:
            REQUEST_CONTEXT.owner = None
            if admitted:
                OPERATION_CAPACITY.release()
        data = json.dumps(output).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class CapacityError(RuntimeError):
    pass


class BoundedHTTPServer(ThreadingHTTPServer):
    """Bound retained request bodies and long-running operation threads."""
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self.capacity = threading.BoundedSemaphore(int(os.environ.get("WORKBENCH_MANAGER_MAX_REQUESTS", "32")))
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.capacity.acquire(blocking=False):
            try:
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nRetry-After: 1\r\nConnection: close\r\n\r\n')
            finally:
                self.shutdown_request(request)
            return
        request.settimeout(30)
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.capacity.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.capacity.release()


def reap_operations(now=None):
    now = now or time.time()
    for record in STATE.glob('op-*'):
        if not record.is_file() or len(record.name) != 67 or record.name[3:].strip('0123456789abcdef'):
            continue
        try:
            value = json.loads(record.read_text())
            if value.get('status') == 'installing' and now > float(value.get('deadline', 0)):
                installer = PREFIX + '-install-' + record.name[3:27]
                docker('rm', '-f', installer, check=False)
                save_operation(record, {'status': 'failed', 'message': '安装超时，原环境已保留。'})
                value = {'status': 'failed'}
            if value.get('status') != 'installing' and now - record.stat().st_mtime > OPERATION_RETENTION:
                record.unlink(missing_ok=True)
                record.with_suffix('.error.log').unlink(missing_ok=True)
        except (ValueError, OSError, sqlite3.Error):
            LOGGER.warning('Failed to reap operation record %s', record.name, exc_info=True)


def reap():
    while True:
        tick('reaper')
        try:
            ADMISSION.prune(time.time() - OPERATION_RETENTION)
            reap_operations()
            from mcp_runtime import reap_workers
            reap_workers()
            for item in STATE.iterdir():
                try:
                    key = str(uuid.UUID(item.name))
                    with lock(key):
                        # Managed hosts and their sandboxes share one lifecycle.
                        if (HOSTS.root / key / 'host.json').exists():
                            continue
                        if time.time() - item.stat().st_mtime > 1800:
                            from mcp_runtime import invalidate

                            invalidate(key)
                            name, _ = identity(key)
                            docker("stop", "--time", "10", name, check=False)
                except (ValueError, OSError):
                    continue
        except Exception:
            # A malformed record or transient Docker failure must not kill GC.
            LOGGER.exception('Sandbox reaper cycle failed')
        tick('reaper')
        time.sleep(30)


def maintain_hosts():
    while True:
        tick('hosts')
        try:
            HOSTS.maintain()
        except Exception:
            # One unexpected cycle must not permanently kill self-healing.
            LOGGER.exception('Host maintenance cycle failed')
        tick('hosts')
        time.sleep(10)


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get('WORKBENCH_MANAGER_LOG_LEVEL', 'INFO'),
                        format='%(asctime)s %(levelname)s %(name)s %(message)s')
    if len(TOKEN) < 32:
        raise ValueError("Manager token must contain at least 32 characters")
    threading.Thread(target=reap, daemon=True).start()
    threading.Thread(target=maintain_hosts, daemon=True).start()
    BoundedHTTPServer(("0.0.0.0", 5010), Handler).serve_forever()
