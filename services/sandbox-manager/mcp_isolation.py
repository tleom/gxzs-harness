"""Platform stdio workers never share an owner's processes or writable files."""
import json
import hashlib
import os
import re
import subprocess
import threading
import time

from mcp_policy import get as policy
from resource_limits import cgroup_args

TRUSTED_PATH = '/opt/office/python/bin:/opt/office/node/node_modules/.bin:/usr/local/bin:/usr/bin:/bin'
TRUSTED_NODE_PATH = '/opt/office/node/node_modules'
GUARD = threading.RLock()
NETWORK_GUARD = threading.Lock()
LIVE = {}


def workspace_live(workspace):
    with GUARD:
        return any(worker.workspace == workspace for worker in LIVE.values())


def remaining(deadline):
    seconds = min(policy('control_timeout_seconds'), deadline - time.monotonic())
    if seconds <= 0:
        raise TimeoutError('Isolated MCP operation exceeded its deadline')
    return seconds


def docker(*args, timeout=None):
    return subprocess.run(['docker', *args], capture_output=True, text=True,
                          timeout=policy('control_timeout_seconds') if timeout is None else timeout)


def prefix():
    return os.environ.get('WORKBENCH_SANDBOX_PREFIX', 'dify-wb-dev')


def inspection(result):
    body = json.loads(result.stdout)
    if not isinstance(body, list) or len(body) != 1 or not isinstance(body[0], dict):
        raise RuntimeError('Invalid isolated MCP inspection response')
    return body[0]


def inspect(name, *, timeout=None):
    result = docker('inspect', name, timeout=timeout)
    if result.returncode:
        if re.search(r'No such (?:object|container)', result.stderr, re.I):
            return None
        raise RuntimeError('Unable to inspect isolated MCP runtime')
    return inspection(result)


def ensure_network(deadline=None):
    deadline = time.monotonic() + policy('startup_timeout_seconds') if deadline is None else deadline
    name = prefix() + '-global-mcp'
    labels = {'workbench': prefix(), 'gxzs.purpose': 'global-mcp'}
    options = {'com.docker.network.bridge.enable_icc': 'false',
               'com.docker.network.bridge.enable_ip_masquerade': 'true'}
    if not NETWORK_GUARD.acquire(timeout=remaining(deadline)):
        raise TimeoutError('Isolated MCP network preparation is busy')
    try:
        result = docker('network', 'inspect', name, timeout=remaining(deadline))
        if result.returncode:
            if not re.search(r'(?:No such network|network .+ not found)', result.stderr, re.I):
                raise RuntimeError('Unable to inspect isolated MCP network')
            created = docker('network', 'create', '--driver', 'bridge',
                             *[arg for key, value in labels.items() for arg in ('--label', key + '=' + value)],
                             *[arg for key, value in options.items() for arg in ('--opt', key + '=' + value)], name,
                             timeout=remaining(deadline))
            if created.returncode:
                raise RuntimeError('Unable to create isolated MCP network')
            result = docker('network', 'inspect', name, timeout=remaining(deadline))
        if result.returncode:
            raise RuntimeError('Unable to confirm isolated MCP network')
        info = inspection(result)
        if (info.get('Driver') != 'bridge' or info.get('Scope') != 'local'
                or not isinstance(info.get('Labels'), dict) or not isinstance(info.get('Options'), dict)
                or any((info.get('Labels') or {}).get(key) != value for key, value in labels.items())
                or any((info.get('Options') or {}).get(key) != value for key, value in options.items())):
            raise RuntimeError('Isolated MCP network identity changed')
    finally:
        NETWORK_GUARD.release()
    return name


def ensure_volume(name, labels, deadline):
    result = docker('volume', 'inspect', name, timeout=remaining(deadline))
    if result.returncode:
        if not re.search(r'No such volume', result.stderr, re.I):
            raise RuntimeError('Unable to inspect isolated MCP data')
        created = docker('volume', 'create',
                         *[arg for key, value in labels.items() for arg in ('--label', key + '=' + value)],
                         name, timeout=remaining(deadline))
        if created.returncode:
            raise RuntimeError('Unable to create isolated MCP data')
        result = docker('volume', 'inspect', name, timeout=remaining(deadline))
    if result.returncode:
        raise RuntimeError('Unable to confirm isolated MCP data')
    info = inspection(result)
    if (info.get('Name') != name or info.get('Driver') != 'local' or info.get('Scope') != 'local'
            or not isinstance(info.get('Labels'), dict)
            or any((info.get('Labels') or {}).get(key) != value for key, value in labels.items())):
        raise RuntimeError('Isolated MCP data identity changed')


class TrustedWorkerContainer:
    def __init__(self, workspace, token, server=None):
        if not isinstance(workspace, str) or not workspace or not re.fullmatch('[0-9a-f]{32}', token):
            raise ValueError('Invalid isolated MCP worker identity')
        self.workspace, self.token, self.server = workspace, token, server
        self.name = prefix() + '-mcp-' + token
        self.labels = {'workbench': prefix(), 'gxzs.purpose': 'global-mcp',
                       'gxzs.workspace': workspace, 'gxzs.mcp-worker': token}
        if server is not None:
            self.labels['gxzs.mcp-server'] = server
        self.last_close_attempt = 0
        self.cleanup_guard = threading.Lock()
        # Register before the first Docker operation, including uncertain create.
        with GUARD:
            LIVE[self.name] = self

    def matches(self, info):
        config = info.get('Config')
        labels = config.get('Labels') if isinstance(config, dict) else None
        return info.get('Name') == '/' + self.name and isinstance(labels, dict) and all(
            labels.get(key) == value for key, value in self.labels.items())

    def start(self, deadline):
        if not isinstance(self.server, str) or not self.server.startswith('global:'):
            raise ValueError('Isolated MCP data requires a global server identity')
        network = ensure_network(deadline)
        identity = hashlib.sha256((self.workspace + '\0' + self.server).encode()).hexdigest()[:32]
        data_labels = {'workbench': prefix(), 'gxzs.purpose': 'global-mcp-data',
                       'gxzs.workspace': self.workspace, 'gxzs.mcp-server': self.server}
        volumes = [(prefix() + '-mcp-data-' + identity + '-' + suffix, path)
                   for suffix, path in (('home', '/home/gxzs'), ('files', '/workspace'))]
        for volume, _ in volumes:
            ensure_volume(volume, data_labels, deadline)
        memory = os.environ.get('WORKBENCH_SANDBOX_MEMORY', '3g')
        image = os.environ.get('WORKBENCH_SANDBOX_IMAGE', 'langgenius/dify-agent-local-sandbox:1.17.1')
        setup = ("import os,signal;assert os.access('/workspace',os.W_OK) "
                 "and os.access('/home/gxzs',os.W_OK);signal.pause()")
        args = ['create', '--name', self.name, '--network', network, '--restart', 'no',
                *[arg for key, value in self.labels.items() for arg in ('--label', key + '=' + value)],
                *cgroup_args(self.workspace), '--user', '1000:1000', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges:true', '--read-only',
                '--cpus', os.environ.get('WORKBENCH_SANDBOX_CPUS', '1'),
                '--memory', memory, '--memory-swap', memory,
                '--pids-limit', os.environ.get('WORKBENCH_SANDBOX_PIDS_LIMIT', '1024'),
                '--log-driver', 'none', '--no-healthcheck', '-e', 'PATH=' + TRUSTED_PATH, '-e', 'NODE_PATH=' + TRUSTED_NODE_PATH,
                '-e', 'HOME=/home/gxzs', '-e', 'LANG=C.UTF-8']
        # Docker seeds empty volumes from these trusted image directories,
        # including their UID 1000 ownership. Owner volumes are never mounted.
        for volume, path in volumes:
            args += ['--mount', 'type=volume,source=' + volume + ',target=' + path]
        args += ['--tmpfs', '/var/lib/gxzs-tmp/current:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=700']
        args += ['--entrypoint', '/usr/local/bin/python', image, '-I', '-S', '-c', setup]
        for command in (args, ['start', self.name]):
            if docker(*command, timeout=remaining(deadline)).returncode:
                raise RuntimeError('Unable to start isolated MCP runtime')

    def close(self, *, deadline=None):
        if not self.cleanup_guard.acquire(blocking=False):
            return False
        try:
            self.last_close_attempt = time.monotonic()
            deadline = self.last_close_attempt + policy('cleanup_timeout_seconds') if deadline is None else deadline
            info = inspect(self.name, timeout=remaining(deadline))
            if info is not None:
                if not self.matches(info):
                    return False
                # Use immutable identity after inspection, never a reused name.
                docker('rm', '-f', info['Id'], timeout=remaining(deadline))
                if inspect(info['Id'], timeout=remaining(deadline)) is not None:
                    return False
            with GUARD:
                LIVE.pop(self.name, None)
            return True
        except (OSError, ValueError, RuntimeError, TimeoutError, subprocess.TimeoutExpired):
            return False
        finally:
            self.cleanup_guard.release()


def discover_orphans(deadline, workspace=None):
    """Queue labelled leftovers; authoritative inspection happens during close."""
    found = []
    try:
        filters = ['--filter', 'label=gxzs.workspace=' + workspace] if workspace is not None else []
        form = ('{"name":{{json .Names}},"workspace":{{json (.Label "gxzs.workspace")}},'
                '"token":{{json (.Label "gxzs.mcp-worker")}},"server":{{json (.Label "gxzs.mcp-server")}}}')
        result = docker('ps', '-a', '--filter', 'label=workbench=' + prefix(),
                        '--filter', 'label=gxzs.purpose=global-mcp', *filters, '--format', form,
                        timeout=remaining(deadline))
        if result.returncode:
            return found, False
        for line in result.stdout.splitlines():
            entry = json.loads(line)
            if not isinstance(entry, dict) or not isinstance(entry.get('name'), str):
                return found, False
            name = entry.get('name', '')
            match = re.fullmatch(re.escape(prefix()) + r'-mcp-([0-9a-f]{32})', name)
            if (not match or entry.get('token') != match[1] or not isinstance(entry.get('workspace'), str)
                    or not entry['workspace'] or workspace is not None and entry['workspace'] != workspace):
                return found, False
            if entry.get('server') is not None and not isinstance(entry['server'], str):
                return found, False
            with GUARD:
                if name in LIVE:
                    continue
                found.append(TrustedWorkerContainer(entry['workspace'], match[1], entry.get('server') or None))
        return found, True
    except (OSError, ValueError, RuntimeError, TimeoutError, subprocess.TimeoutExpired):
        return found, False
