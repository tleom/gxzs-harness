"""Private container control plane; exposes no arbitrary Docker or shell operation."""
import hashlib
import errno
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
from resource_limits import cgroup_args, owner_cgroup, ResourceUnavailable, storage_status
from owner_networks import OwnerNetworks
from owner_auth import authorize as authorize_request
from office_conversions import OfficeConversions
from runtime_names import volume_prefix
from global_skills import mount_arguments as global_skill_mounts, matches_mount


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
OFFICE_CONVERSIONS = OfficeConversions()
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
        if (not isinstance(item, dict) or not item.get("enabled") or not item.get("version")
                or not (item.get("status") == "unverified" or item.get("refresh_due") is True)):
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

        def refresh(target=identity, version=item["version"], discovered_at=item.get("discovered_at")):
            try:
                operation(target[0], "personal-mcp", {"operation": "mcp_test", "name": target[1],
                                                      "version": version,
                                                      "maintenance": True,
                                                      "catalog_discovered_at": discovered_at,
                                                      "deadline_ms": int(time.time() * 1000) + 30_000})
            except Exception:
                LOGGER.warning("Personal MCP catalog refresh failed for %s", target[1])
            finally:
                with MCP_REFRESH_GUARD:
                    MCP_REFRESHING.discard(target)

        try:
            threading.Thread(target=refresh, name="mcp-catalog-refresh", daemon=True).start()
        except (RuntimeError, OSError):
            with MCP_REFRESH_GUARD:
                MCP_REFRESHING.discard(identity)
            LOGGER.warning('Unable to start personal MCP catalog refresh')


def docker(*args, stdin=None, timeout=90, check=True):
    try:
        from docker_inspect import inspect_local
        result = inspect_local(args, timeout) if stdin is None else None
        if result is None:
            result = subprocess.run(["docker", *args], input=stdin, capture_output=True, text=True, timeout=timeout)
    except OSError as error:
        if error.errno == errno.EAGAIN:
            raise ResourceUnavailable('沙盒管理服务暂时无法创建进程或线程，请稍后重试；数据已保留') from error
        raise
    if check and result.returncode:
        if any(marker in result.stderr.lower() for marker in ('resource temporarily unavailable', 'unable to spawn stage', 'pthread_create')):
            raise ResourceUnavailable('沙盒暂时无法创建进程或线程，请稍后重试；数据已保留')
        # Never echo command arguments (which may contain the sandbox auth token).
        raise RuntimeError(result.stderr[-2000:] or "Docker operation failed")
    return result


class SandboxUpdatePending(RuntimeError):
    pass


def tick(worker):
    with HEALTH_GUARD:
        HEALTH[worker] = time.monotonic()


OWNER_NETWORKS = OwnerNetworks(STATE, NETWORK, PREFIX, lambda *args, **kwargs: docker(*args, **kwargs),
                               os.environ.get('WORKBENCH_SANDBOX_ADDRESS_POOL'),
                               os.environ.get('WORKBENCH_SANDBOX_SUBNET_PREFIX', '27'))


def network_name(key):
    return OWNER_NETWORKS.name(key)


def ensure_network(key):
    return OWNER_NETWORKS.ensure(key)


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
    record = STATE / 'hosts' / key / 'host.json'
    if record.exists():
        name = json.loads(record.read_text()).get('sandbox_name') or name
    token = hmac.new(TOKEN.encode(), key.encode(), hashlib.sha256).hexdigest()
    return name, token


def storage_identity(key):
    key = str(uuid.UUID(key))
    record = STATE / 'hosts' / key / 'host.json'
    host = json.loads(record.read_text()) if record.exists() else {}
    return volume_prefix(host, PREFIX + '-' + key)


def touch(key):
    (STATE / key).touch()


def operation_file(key, request_id):
    digest = hashlib.sha256((key + ":" + request_id).encode()).hexdigest()
    return STATE / ("op-" + digest), PREFIX + "-install-" + digest[:24]


def save_operation(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    os.replace(temporary, path)


def environment_status(key, request_id, *, now=None):
    """Inspect outside the owner lock; never infer rollback from a lost client."""
    now = time.time() if now is None else now
    record, installer = operation_file(key, request_id)
    with lock(key):
        if not record.exists():
            return {'status': 'failed', 'message': '安装请求未执行'}
        value = json.loads(record.read_text())
        if value.get('status') not in {'installing', 'unknown'}:
            return value
    unknown = {**value, 'status': 'unknown', 'message': '安装结果待核实，请查询状态后再更新环境'}
    try:
        def inspect():
            result = docker('inspect', installer, check=False, timeout=5)
            if result.returncode:
                message = getattr(result, 'stderr', '').lower()
                if 'no such object' in message or 'no such container' in message:
                    return None
                raise ValueError('Installer state is unknown')
            return json.loads(result.stdout)[0]
        info = inspect()
        stopped = False
        if info and info.get('State', {}).get('Running') is True:
            if now <= float(value.get('deadline', 0)):
                return value
            docker('stop', '--time', '5', installer, timeout=15)
            info = inspect()
            if info and info.get('State', {}).get('Running') is not False:
                raise ValueError('Installer stop is unconfirmed')
            stopped = True
        elif info is not None and info.get('State', {}).get('Running') is not False:
            raise ValueError('Installer state is unknown')
        elif info is not None:
            # Docker may have created the container while its start request is
            # still delayed. Running=false alone cannot fence that late start.
            stopped = info.get('State', {}).get('Status') in {'exited', 'dead'}
            if not stopped:
                raise ValueError('Installer start or exit is unconfirmed')
        elif info is None and now <= float(value.get('deadline', 0)) and value.get('status') == 'installing':
            # The request may have persisted just before starting docker run.
            return value
        name, _ = identity(key)
        current = docker('exec', '--user', '1000', name, *MANAGER_PYTHON, '-c',
                         "from pathlib import Path; p=Path('/opt/user-env/current/request.json'); print(p.read_text() if p.exists() else '{}')",
                         check=False, timeout=10)
        if current.returncode:
            raise ValueError('Current environment cannot be inspected')
        applied = json.loads(current.stdout).get('request_id') == request_id
        # An absent --rm container without this commit receipt may also mean
        # docker run has not reached the daemon yet. Keep the durable gate until
        # there is positive completion/stop evidence, not just an expired clock.
        output = ({**value, 'status': 'ready' if applied else 'failed',
                   'message': '环境已更新' if applied else '安装未完成，请检查共享环境'}
                  if applied or stopped else unknown)
    except (ValueError, OSError, subprocess.SubprocessError):
        output = unknown
    with lock(key):
        latest = json.loads(record.read_text())
        if latest.get('status') not in {'installing', 'unknown'}:
            return latest
        save_operation(record, output)
    return output


def ensure(key, *, track_activity=True, allow_existing_image=False):
    skills_mount = global_skill_mounts()
    pids_limit = int(os.environ.get('WORKBENCH_SANDBOX_PIDS_LIMIT', '1024'))
    if pids_limit <= 0:
        raise ValueError('WORKBENCH_SANDBOX_PIDS_LIMIT must be positive')
    name, token = identity(key)
    with lock(key):
        name, token = identity(key)
        network = ensure_network(key)
        record = HOSTS.root / key / 'host.json'
        home_volume = None
        host = {}
        if record.exists():
            host = json.loads(record.read_text(encoding='utf-8'))
            if ('profile_upgrade' in host and (host.get('state') == 'fencing'
                    or host['profile_upgrade'].get('phase') in {'fencing', 'preparing', 'prepared'})):
                raise SandboxUpdatePending('个人工作台正在准备配置升级；原环境保持停止')
            home_volume = host.get('home_volume')
            if host.get('workspace_id') != key or not isinstance(home_volume, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]+', home_volume):
                raise ValueError('Invalid owner attachment volume')
        volumes = volume_prefix(host, name)
        attachment_mount = (['--mount', 'type=volume,source=' + home_volume
                             + ',destination=/srv/dsh/attachments,volume-subpath=attachments,readonly'] if home_volume else [])
        info = docker("inspect", name, check=False)
        if record.exists() and 'profile_upgrade' in host and (info.returncode or not json.loads(info.stdout)[0]['State']['Running']):
            raise SandboxUpdatePending('个人工作台正在准备配置升级；不能重启原环境')
        if not info.returncode:
            existing = json.loads(info.stdout)[0]
            if host.get('sandbox_name') and (existing.get('Config', {}).get('Labels') or {}).get('gxzs.workspace') != key:
                raise ValueError('Sandbox container name belongs to another workspace')
            attached = set((existing.get('NetworkSettings', {}).get('Networks') or {}).keys())
            mounted_home = (existing['Config'].get('Labels') or {}).get('gxzs.attachment-home')
            # Bootstrap catalog reads must remain available while a running owner
            # awaits its drained image rollout. All isolation and upgrade fences
            # still apply; stopped containers continue through normal replacement.
            keep_running_image = allow_existing_image and existing['State']['Running']
            if ((existing["Config"]["Image"] != IMAGE and not keep_running_image)
                    or not matches_mount(existing)
                    or attached != {network} or mounted_home != home_volume
                    or (existing.get('HostConfig', {}).get('CgroupParent') or '') != owner_cgroup(key)):
                if existing["State"]["Running"]:
                    # Do not execute privileged helpers in a previous image.
                    # Deployment drains its runs before stopping/recreating it.
                    raise SandboxUpdatePending("个人沙箱正在更新，请稍后重试；数据和环境已保留")
                # Keep the stopped container as a rollback reference and reuse all owner volumes.
                docker("rename", name, name + "-previous-" + existing["Id"][:12])
                info = docker("inspect", name, check=False)
            elif existing.get('HostConfig', {}).get('PidsLimit') != pids_limit:
                previous = existing.get('HostConfig', {}).get('PidsLimit') or 0
                if existing['State']['Running'] and (previous <= 0 or previous > pids_limit):
                    raise SandboxUpdatePending("个人沙箱正在更新，请稍后重试；数据和环境已保留")
                # Raising the task/thread allowance needs no container restart.
                docker('update', '--pids-limit', str(pids_limit), name)
        if info.returncode:
            if home_volume:
                docker('volume', 'create', '--label', 'gxzs.owner=' + host['owner_id'], home_volume)
                docker('run', '--rm', *cgroup_args(key), '--memory', '256m', '--cpus', '1', '--pids-limit', '128',
                       '--user', '0', '--network', 'none', '--entrypoint', MANAGER_PYTHON[0],
                       '-v', home_volume + ':/srv/dsh', IMAGE, *MANAGER_PYTHON[1:], '-c',
                       "import os; p='/srv/dsh/attachments'; "
                       "assert not os.path.islink(p), 'Attachment root cannot be a symlink'; "
                       "os.chown('/srv/dsh',1000,1000); "
                       "os.makedirs(p,exist_ok=True); os.chown(p,1000,1000); os.chmod(p,0o700)")
            for suffix in ("home", "files", "env"):
                docker("volume", "create", "--label", "workbench=" + PREFIX, volumes + "-" + suffix)
            docker("run", "--rm", *cgroup_args(key), '--memory', '256m', '--cpus', '1', '--pids-limit', '128',
                   "--user", "0", "--network", "none", "--entrypoint", MANAGER_PYTHON[0],
                   "-v", volumes + "-home:/home/gxzs", "-v", volumes + "-files:/workspace", "-v", volumes + "-env:/opt/user-env",
                   IMAGE, *MANAGER_PYTHON[1:], "-c", "import os; paths=['/home/gxzs','/workspace','/workspace/conversations','/opt/user-env']; "
                   "[(os.makedirs(p,exist_ok=True),os.chown(p,1000,1000)) for p in paths]")
            # Existing personal venvs gain the immutable office fallback without replacing their packages.
            docker("run", "--rm", *cgroup_args(key), '--memory', '256m', '--cpus', '1', '--pids-limit', '128',
                   "--user", "1000", "--network", "none", "--entrypoint", MANAGER_PYTHON[0],
                   "-v", volumes + "-env:/opt/user-env", IMAGE, *MANAGER_PYTHON[1:], "-c",
                   "from pathlib import Path; site=Path('/opt/user-env/current/python/lib/python3.12/site-packages'); "
                   "base=Path('/opt/office/python/lib/python3.12/site-packages'); "
                   "(site/'workbench_office.pth').write_text(str(base)+'\\n') if site.exists() and base.exists() else None")
            docker("create", "--name", name, "--label", "workbench=" + PREFIX,
                   '--label', 'gxzs.workspace=' + key, "--network", network, *cgroup_args(key),
                   *(['--label', 'gxzs.account=' + host['account_name']] if host.get('account_name') else []),
                   *(['--label', 'gxzs.attachment-home=' + home_volume] if home_volume else []), *attachment_mount,
                   '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
                   "--cpus", os.environ.get("WORKBENCH_SANDBOX_CPUS", "1"),
                   "--memory", os.environ.get("WORKBENCH_SANDBOX_MEMORY", "3g"),
                   "--memory-swap", os.environ.get("WORKBENCH_SANDBOX_MEMORY", "3g"), "--pids-limit", str(pids_limit),
                   "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                   "-v", volumes + "-home:/home/gxzs", "-v", volumes + "-files:/workspace",
                   "-v", volumes + "-env:/opt/user-env:ro", *skills_mount,
                   "-e", "SHELLCTL_AUTH_TOKEN=" + token,
                   "-e", "PATH=/opt/user-env/current/python/bin:/opt/office/python/bin:/opt/user-env/current/node/node_modules/.bin:/opt/office/node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
                   "-e", "NODE_PATH=/opt/user-env/current/node/node_modules:/opt/office/node/node_modules", IMAGE)
        if info.returncode or not existing['State']['Running']:
            docker("start", name)
            docker("exec", "--user", "0", name, *MANAGER_PYTHON, "-c",
                   "import os; os.makedirs('/opt/workbench-global', mode=0o755, exist_ok=True)")
        if track_activity or info.returncode or not existing['State']['Running']:
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
    if action == 'profile-upgrade':
        return HOSTS.profile_upgrade(key, payload)
    if action == 'host-settings':
        if payload != {'operation': 'check'}:
            raise ValueError('Unsupported Host settings operation')
        # This lock also revalidates the owner/generation. The caller counts
        # its write before this check; replace marks draining before probing.
        with lock(key):
            record = json.loads((HOSTS.root / key / 'host.json').read_text(encoding='utf-8'))
            if record.get('state') not in {'ready', 'provisioning'}:
                raise SandboxUpdatePending('工作台正在维护，请稍后保存设置')
            return {'writable': True}
    if action == 'diagnostics':
        from mcp_runtime import statistics
        from global_memory import statistics as memory_statistics
        return {"mcp": statistics(), "memory": memory_statistics(), "workspace_locks": len(LOCKS),
                "storage": storage_status(STATE)}
    if action == 'schedule':
        required = {'owner_id', 'generation', 'instance_id', 'run_id', 'chat_id', 'action'}
        if not required.issubset(payload):
            raise ValueError('Scheduling request missing host or task identity; operation was not started')
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
            key, payload, docker=docker, ensure=ensure, identity=identity, storage_identity=storage_identity,
            image=IMAGE, prefix=PREFIX, manager_python=MANAGER_PYTHON, admission=admission,
        )
    if action == "personal-mcp":
        from mcp_runtime import invalidate, invoke, module_source

        allowed = {"mcp_list", "mcp_read", "mcp_save", "mcp_delete", "mcp_toggle", "mcp_reorder", "mcp_test", "mcp_call"}
        if payload.get("operation") not in allowed:
            raise ValueError("Unsupported MCP operation")
        tracked = payload['operation'] != 'mcp_list' and payload.get('maintenance') is not True
        with lock(key):
            record = HOSTS.root / key / 'host.json'
            if payload.get('maintenance') is True and record.exists() and json.loads(record.read_text(encoding='utf-8')).get('state') == 'stopped':
                raise ResourceUnavailable('个人工作环境已休眠，维护请求稍后重试', 'HOST_IDLE', 30)
            ensure(key, track_activity=tracked, allow_existing_image=payload['operation'] == 'mcp_list')
            name, _ = identity(key)
            request = payload
            if payload["operation"] in {"mcp_test", "mcp_call"}:
                request = {"operation": "mcp_probe", "name": payload.get("name")}
                if payload["operation"] == "mcp_test":
                    request["include_discovery_state"] = True
            source = module_source("file_ops", "resource_ops", "mcp_ops")
            source += "import json; print(json.dumps(sys.modules['mcp_ops'].personal_mcp(json.load(sys.stdin))))"
            result = docker("exec", "--user", "1000", "-i", name, *MANAGER_PYTHON, "-c", source,
                            stdin=json.dumps(request), check=False)
            if result.returncode:
                # Parse errors and tracebacks may include user-supplied secrets.
                raise ValueError("MCP 配置操作失败，请检查 JSON、路径和版本")
            output = json.loads(result.stdout)
            if tracked:
                touch(key)
        if payload["operation"] in {"mcp_save", "mcp_delete", "mcp_toggle"} and not output.get("conflict"):
            invalidate(key, payload["name"])
        if payload["operation"] in {"mcp_test", "mcp_call"}:
            discovered_at = payload.get("catalog_discovered_at", output.get("discovered_at"))
            output = invoke(key, name, payload, output, authorize=authorize_mcp)
            if (payload["operation"] == "mcp_test"
                    and output.get("error") and output.get("code") != "MCP_BUSY"
                    and discovered_at is not None):
                failure = {"operation": "mcp_cache_failure", "name": payload["name"],
                           "version": payload["version"], "discovered_at": discovered_at}
                # Only the owning sandbox can invalidate its unchanged cache.
                # The expected timestamp protects a concurrently completed refresh.
                with lock(key):
                    result = docker("exec", "--user", "1000", "-i", name, *MANAGER_PYTHON, "-c", source,
                                    stdin=json.dumps(failure), check=False)
                    if result.returncode:
                        LOGGER.warning("Unable to record personal MCP discovery failure")
        elif payload["operation"] == "mcp_list":
            schedule_mcp_refresh(key, output.get("mcp", []))
        if tracked:
            touch(key)
        return output
    if action == "office-preview":
        if payload.get('operation') == 'cancel':
            return OFFICE_CONVERSIONS.cancel(key, payload.get('request_id'))
        with lock(key):
            touch(key)
        # No owner volumes, credentials, network or writable image are exposed.
        image = docker('image', 'inspect', '--format', '{{.Id}}', IMAGE).stdout.strip()
        requested_path = payload.get('path')
        if requested_path is not None:
            with lock(key):
                metadata = operation(key, 'files', {'operation': 'stat', 'path': requested_path})
            if metadata.get('kind') != 'file' or metadata.get('size', 0) > 20 * 1024 * 1024 or not metadata.get('version'):
                raise ValueError('文件不存在或超过 20 MiB 预览范围')
            payload = {**payload, 'name': metadata['name'], 'source_digest': metadata['version']}
        def convert(job):
            preview_name = PREFIX + "-preview-" + uuid.uuid4().hex
            try:
                document = payload
                if requested_path is not None:
                    with lock(key):
                        document = operation(key, 'files', {'operation': 'get', 'path': requested_path})
                    if document.get('version') != payload['source_digest']:
                        raise ValueError('文件已改变，请刷新后重试')
                script = Path(__file__).with_name("office_preview.py").read_text()
                docker("create", "--rm", "--name", preview_name, *cgroup_args(key), "--network", "none",
                                "--read-only", "--tmpfs", "/tmp:rw,nosuid,noexec,size=256m",
                                "--user", "1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                                "--memory", "1g", "--cpus", "1", "--pids-limit", "128", "-e", "HOME=/tmp",
                                "--entrypoint", MANAGER_PYTHON[0], "-i", image, *MANAGER_PYTHON[1:], "-c", script)
                with OFFICE_CONVERSIONS.lock:
                    job.stop = lambda: docker("rm", "-f", preview_name, check=False)
                if job.cancelled.is_set():
                    raise ValueError('文档预览已取消')
                result = docker('start', '--attach', '--interactive', preview_name,
                                stdin=json.dumps(document), timeout=55, check=False)
                output = json.loads(result.stdout or "{}")
                if result.returncode or not output.get("data"):
                    raise ValueError(output.get("error", "文档排版失败"))
                return output
            except subprocess.TimeoutExpired as error:
                raise ValueError("文档排版超时，请下载原文件查看") from error
            finally:
                docker("rm", "-f", preview_name, check=False)
        output = OFFICE_CONVERSIONS.convert(key, payload, image, convert)
        with lock(key):
            touch(key)  # Revalidate the owner generation and record actual preview activity.
        return output
    if action == "files":
        with lock(key):
            ensure(key)
            name, _ = identity(key)
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
            name, _ = identity(key)
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
            name, _ = identity(key)
            host_record = HOSTS.root / key / 'host.json'
            volumes = volume_prefix(json.loads(host_record.read_text()) if host_record.exists() else {}, name)
            request_id = payload.get("request_id", "")
            if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
                raise ValueError("Environment update requires a stable request ID")
            record, installer = operation_file(key, request_id)
            existing = record.exists()
            if not existing:
                for pending in STATE.glob('op-*'):
                    if len(pending.name) != 67 or not pending.is_file():
                        continue
                    state = json.loads(pending.read_text())
                    if (state.get('workspace_id') in {None, key}
                            and state.get('status') in {'installing', 'unknown'}):
                        raise ResourceUnavailable('共享环境更新尚未确认完成', 'ENVIRONMENT_UPDATE_PENDING', 5)
                installing = {'status': 'installing', 'deadline': time.time() + INSTALL_TIMEOUT + 30,
                              'workspace_id': key, 'request_id': request_id}
                save_operation(record, installing)
        if existing:
            return environment_status(key, request_id)
        script = Path(__file__).with_name("environment.py").read_text()
        # The durable gate serializes installers, while owner control/stop can
        # still acquire its lock during this bounded, long-running operation.
        try:
            result = docker("run", "--rm", "--name", installer, *cgroup_args(key), "--user", "1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--memory", "1g", "--cpus", "1", "--pids-limit", "256", "--entrypoint", MANAGER_PYTHON[0],
                "-v", volumes + "-env:/opt/user-env", "-i", IMAGE, *MANAGER_PYTHON[1:], "-c", script,
                stdin=json.dumps(payload), timeout=INSTALL_TIMEOUT)
            output = json.loads(result.stdout)
            if not isinstance(output, dict) or output.get('status') != 'ready':
                raise ValueError('Installer completion was not confirmed')
        except subprocess.TimeoutExpired:
            return installing
        except Exception as error:
            record.with_suffix(".error.log").write_text(str(error)[-12000:])
            output = {'status': 'unknown', 'message': '安装结果待核实，请查询状态后再更新环境'}
        with lock(key):
            latest = json.loads(record.read_text())
            if latest.get('status') in {'installing', 'unknown'}:
                save_operation(record, {**installing, **output})
            else:
                output = latest
        return output
    if action == "environment-status":
        return environment_status(key, payload.get('request_id', ''))
    if action == "clean-binding":
        from planning import scratch_name

        binding = str(uuid.UUID(payload["binding_id"]))
        with lock(key):
            stop_binding(key, binding)
            ensure(key)
            name, _ = identity(key)
            docker("exec", "--user", "1000", name, *MANAGER_PYTHON, "-c",
                   "import shutil; shutil.rmtree('/home/gxzs/" + binding + "',ignore_errors=True); "
                   "shutil.rmtree('/workspace/conversations/" + binding + "',ignore_errors=True)")
            docker("volume", "rm", scratch_name(storage_identity(key), binding), check=False)
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
        self.write_json(200 if not errors else 503, data, action='healthz')

    def write_json(self, code, data, request_id=None, action='unresolved'):
        try:
            # Each worker serves one request. Explicitly prohibit connection
            # reuse: Java HTTP clients may otherwise pool this HTTP/1.0 socket
            # and send the next mutation while the worker is closing it.
            self.close_connection = True
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # Only the final downstream socket write is handled here. Operation
            # failures above retain their actual error status and diagnostics.
            LOGGER.debug('Sandbox client response closed request_id=%s action=%s', request_id, action)

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
            if self.headers.get('Transfer-Encoding'):
                raise ValueError('Transfer-Encoding is not supported; send a fixed Content-Length')
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= MAX_BODY:
                raise ValueError("Request too large")
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError('Incomplete request body; operation was not started')
            payload = json.loads(body or "{}")
            if not isinstance(payload, dict):
                raise ValueError('Request must be an object')
            if parts[2] not in CONTROL_ACTIONS and not (parts[2] == 'office-preview' and payload.get('operation') == 'cancel'):
                admitted = OPERATION_CAPACITY.acquire(blocking=False)
                if not admitted:
                    raise CapacityError('Sandbox manager is busy; operation was not started')
            output = operation(key, parts[2], payload)
            if output.get("conflict"):
                code = 409
        except CapacityError as error:
            code, output = 503, {'error': str(error), 'code': 'MANAGER_BUSY', 'retry_after': 1}
        except ResourceUnavailable as error:
            code, output = 503, {'error': str(error), 'code': error.code, 'retry_after': error.retry_after}
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
        if code >= 400:
            output.setdefault('request_id', request_id)
        data = json.dumps(output).encode()
        self.write_json(code, data, request_id=request_id, action=action)


class CapacityError(RuntimeError):
    pass


class BoundedHTTPServer(ThreadingHTTPServer):
    """Bound retained request bodies and long-running operation threads."""
    daemon_threads = True
    # A scheduler burst can contain four requests per owner. Keep sockets in
    # the kernel backlog while the existing bounded worker pool drains.
    request_queue_size = 128

    def __init__(self, *args, **kwargs):
        self.capacity = threading.BoundedSemaphore(int(os.environ.get("WORKBENCH_MANAGER_MAX_REQUESTS", "32")))
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        # Short control requests commonly free a worker within milliseconds.
        # A bounded wait absorbs bursts without increasing threads or bodies;
        # sustained saturation still returns the existing retryable 503.
        if not self.capacity.acquire(timeout=0.1):
            self.reject_request(request, 'MANAGER_BUSY', '沙盒管理服务繁忙，本次操作未开始，请稍后重试')
            return
        try:
            request.settimeout(30)
            super().process_request(request, client_address)
        except (RuntimeError, OSError) as error:
            self.capacity.release()
            if isinstance(error, OSError) and error.errno != errno.EAGAIN:
                raise
            self.reject_request(request, 'RESOURCE_BUSY', '沙盒管理服务暂时无法创建请求线程，本次操作未开始，请稍后重试')
        except BaseException:
            self.capacity.release()
            raise

    def reject_request(self, request, code, message):
        try:
            request.settimeout(1)
            body = json.dumps({'error': message, 'code': code, 'retry_after': 1,
                               'request_id': uuid.uuid4().hex[:12]}).encode()
            headers = ('HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: '
                       + str(len(body)) + '\r\nRetry-After: 1\r\nConnection: close\r\n\r\n').encode()
            request.sendall(headers + body)
        except (BrokenPipeError, ConnectionResetError):
            LOGGER.debug('Sandbox client response closed while rejecting request code=%s', code)
        finally:
            self.shutdown_request(request)

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
            if value.get('status') in {'installing', 'unknown'} and now > float(value.get('deadline', 0)):
                if value.get('workspace_id') and value.get('request_id'):
                    value = environment_status(value['workspace_id'], value['request_id'], now=now)
                else:
                    # Old records cannot identify their environment commit. Keep
                    # the receipt for operator reconciliation rather than TTL it.
                    value = {**value, 'status': 'unknown', 'message': '历史安装结果待核实'}
                    save_operation(record, value)
            if value.get('status') in {'ready', 'failed'} and now - record.stat().st_mtime > OPERATION_RETENTION:
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
            from global_memory import reap_calls
            reap_calls()
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
    try:
        BoundedHTTPServer(("0.0.0.0", 5010), Handler).serve_forever()
    finally:
        HOSTS.close()
