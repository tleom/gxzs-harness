"""Owner-scoped host lifecycle. Runtime templates are administrator-controlled."""
import json
import hashlib
import hmac
import secrets
from resource_limits import cgroup_args, owner_cgroup, pid_pressure, ResourceUnavailable, assert_storage_writable
import logging
from concurrent.futures import Future, ThreadPoolExecutor
import ipaddress
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import threading
import time
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError
from owner_auth import owner_token, assertion_key
from runtime_names import account_names, host_name, volume_prefix
from global_skills import mount_arguments as global_skill_mounts, matches_mount, native_root

IDLE_TIMEOUT_SECONDS = 2 * 60 * 60

class Hosts:
    def __init__(self, state, docker, ensure_sandbox, identity, lock, admission, ensure_network):
        self.root = Path(state) / 'hosts'
        self.root.mkdir(exist_ok=True)
        self.docker, self.ensure_sandbox, self.identity = docker, ensure_sandbox, identity
        self.lock, self.admission, self.ensure_network = lock, admission, ensure_network
        self.opener = build_opener(ProxyHandler({}))
        self.failures = {}
        self.recoveries = {}
        self.cleanup_at = {}
        self.native_snapshots = {}
        self.sleep_protocols = {}
        self.sleep_deadlines = {}
        self._maintenance_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix='host-maintenance')
        self._maintenance_guard = threading.Lock()
        self._maintenance_pending = {}
        self._maintenance_cursor = ''
        self._maintenance_closed = False

    def _cleanup_superseded(self, item):
        """Remove only stopped, identity-verified predecessors after the new pair is healthy."""
        listed = self.docker('ps', '-a', '--filter', 'label=gxzs.workspace=' + item['workspace_id'],
                             '--format', '{{.Names}}', timeout=5, check=False)
        if listed.returncode:
            raise RuntimeError('Unable to list superseded hosts')
        host_prefix = host_name(item) + '-previous-'
        sandbox_prefix = item.get('sandbox_name', '') + '-previous-'
        predecessors = []
        for name in listed.stdout.splitlines()[:8]:
            sandbox = bool(item.get('sandbox_name')) and name.startswith(sandbox_prefix)
            prefix = sandbox_prefix if sandbox else host_prefix
            if not re.fullmatch(re.escape(prefix) + r'[0-9a-f]{12}', name):
                continue
            observed = self.docker('inspect', name, timeout=5, check=False)
            if observed.returncode:
                continue
            previous = json.loads(observed.stdout)[0]
            labels = previous.get('Config', {}).get('Labels') or {}
            previous_generation = labels.get('gxzs.generation', '')
            if (previous.get('Id', '')[:12] != name[len(prefix):]
                    or previous.get('State', {}).get('Running') is not False
                    or labels.get('gxzs.workspace') != item['workspace_id']
                    or (not sandbox and (labels.get('gxzs.owner') != item['owner_id']
                        or not previous_generation.isdecimal()
                        or not 1 <= int(previous_generation) <= item['generation']))):
                continue
            predecessors.append(previous['Id'])
        if not predecessors:
            return
        # Listing and inspecting stay outside the admission lock. Recheck the
        # ready generation immediately before one bounded removal operation;
        # replacement cannot rename its rollback pair during this step. The
        # inspected IDs cannot be reused by a concurrent Docker name change.
        with self.lock(item['workspace_id']):
            current = json.loads((self.root / item['workspace_id'] / 'host.json').read_text())
            if (current.get('ready') is not True or current.get('state') != 'ready'
                    or 'profile_upgrade' in current or any(current.get(field) != item.get(field) for field in
                        ('owner_id', 'workspace_id', 'generation', 'instance_id', 'container_name', 'sandbox_name'))):
                return
            removed = self.docker('rm', *predecessors, timeout=5, check=False)
        if removed.returncode:
            logging.getLogger(__name__).warning('Superseded runtime cleanup deferred workspace=%s', item['workspace_id'])

    def ensure(self, workspace, payload):
        global_skill_mounts()
        owner = payload['owner_id']
        instance = payload['instance_id']
        generation = int(payload['generation'])
        names = account_names(owner, payload.get('account_name'))
        if not re.fullmatch(r'[^:\s/]+:\d+', owner) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', instance) or generation < 1:
            raise ValueError('Invalid host identity')
        record = self.root / workspace / 'host.json'
        with self.lock(workspace):
            observed = json.loads(record.read_text()) if record.exists() else {}
        if observed.get('state') == 'degraded':
            if (observed['owner_id'], observed['generation'], observed['instance_id']) != (owner, generation, instance):
                raise ValueError('Host identity changed; fence the previous generation before replacement')
            if observed.get('account_name') and names and observed['account_name'] != names['account_name']:
                raise ValueError('Runtime account binding cannot change')
            # An ensure result renews the platform heartbeat. A durable degraded
            # record is not fresh liveness evidence; probe outside the owner lock.
            info = self._upgrade_inspect(host_name(observed))
            labels = (info or {}).get('Config', {}).get('Labels') or {}
            expected = {'gxzs.owner': owner, 'gxzs.workspace': workspace, 'gxzs.generation': str(generation)}
            if labels.get('gxzs.instance') is not None:
                expected['gxzs.instance'] = instance
            live = (info is not None and info.get('State', {}).get('Running') is True
                    and all(labels.get(key) == value for key, value in expected.items())
                    and info.get('Image') == observed.get('image_digest')
                    and observed.get('endpoint') and self.alive(observed['endpoint']))
            with self.lock(workspace):
                current = json.loads(record.read_text())
                if not live or current != observed or 'profile_upgrade' in current:
                    raise ResourceUnavailable('个人工作环境正在恢复，请稍后重试', 'HOST_NOT_READY', 2)
                return current
        with self.lock(workspace):
            folder = self.root / workspace
            folder.mkdir(mode=0o750, exist_ok=True)
            record = folder / 'host.json'
            current = {}
            registered = record.exists()
            if registered:
                current = json.loads(record.read_text())
                if (current['owner_id'], current['generation'], current['instance_id']) != (owner, generation, instance):
                    raise ValueError('Host identity changed; fence the previous generation before replacement')
                if current.get('account_name') and names and current['account_name'] != names['account_name']:
                    raise ValueError('Runtime account binding cannot change')
                if 'profile_upgrade' in current or current.get('state') in {'draining', 'fencing'}:
                    return {**current, 'ready': False}
                # A ready generation can temporarily be unavailable while the
                # manager restarts its host/sandbox pair. Never regress the
                # platform's monotonic ready state back to provisioning.
                if current.get('state') == 'degraded':
                    raise ResourceUnavailable('个人工作环境正在恢复，请稍后重试', 'HOST_NOT_READY', 2)
                if current.get('state') == 'ready' and current.get('ready') is False:
                    return current
                if payload.get('scheduled_wakeup') is True:
                    # Serialized with _maintain_one's final idle check/stop.
                    # A wake either renews activity before that check or observes
                    # the stopped pair and starts it again below.
                    (self.root.parent / workspace).touch()
                    if current.get('state') == 'ready' and current.get('ready') is True:
                        sandbox, _ = self.identity(workspace)
                        host_info = self._upgrade_inspect(host_name(current))
                        sandbox_info = self._upgrade_inspect(sandbox)
                        self._verify_named_container(current, host_info)
                        self._verify_named_container(current, sandbox_info, sandbox=True)
                        if (host_info and sandbox_info
                                and host_info.get('State', {}).get('Running') is True
                                and sandbox_info.get('State', {}).get('Running') is True
                                and self.healthy(current['endpoint'])):
                            return current
            else:
                current.update(names)
                if names:
                    # Human-readable container names must never become the
                    # storage identity: orphaned account-named volumes may
                    # belong to a different workspace after account deletion.
                    current['sandbox_volume_prefix'] = self.identity(workspace)[0]
            container = host_name(dict(current, instance_id=instance))
            image = os.environ['GXZS_HOST_IMAGE']
            image_info = json.loads(self.docker('image', 'inspect', image).stdout)[0]
            desired_digest = image_info['Id']
            if payload.get('image_digest') and payload['image_digest'] != desired_digest:
                raise ValueError('Desired host image does not match the installed digest')
            network, advertise, publish, host_state = self._runtime_config(workspace)
            sandbox = current.get('sandbox_name') or self.identity(workspace)[0]
            info = self.docker('inspect', container, check=False)
            if not info.returncode:
                existing = json.loads(info.stdout)[0]
                labels = existing['Config'].get('Labels') or {}
                if labels.get('gxzs.owner') != owner or labels.get('gxzs.workspace') != workspace or labels.get('gxzs.generation') != str(generation):
                    raise ValueError('Existing host is not managed for this owner; explicit adoption is required')
                if labels.get('gxzs.instance') is not None and labels['gxzs.instance'] != instance:
                    raise ValueError('Existing named Host instance identity changed')
                if labels.get('gxzs.credentials') != 'owner-v1':
                    raise ValueError('Host credential rollout requires draining before replacement')
                if existing['Config']['Image'] != image:
                    raise ValueError('Host image rollout requires draining before replacement')
                if existing['Image'] != desired_digest:
                    raise ValueError('Host image digest changed; drain before replacement')
                if not matches_mount(existing):
                    raise ValueError('Host global skill mount changed; drain before replacement')
                if (existing.get('HostConfig', {}).get('CgroupParent') or '') != owner_cgroup(workspace):
                    raise ValueError('Host resource rollout requires draining before replacement')
                attached = set((existing.get('NetworkSettings', {}).get('Networks') or {}).keys())
                if attached != {network}:
                    raise ValueError('Host network rollout requires draining before replacement')
                if not existing['State']['Running']:
                    # Restart only after fencing any surviving tool processes.
                    self._stop_pair({**current, 'owner_id': owner, 'workspace_id': workspace,
                                     'generation': generation, 'instance_id': instance})
                    self._fence(workspace, owner, instance)
            # Only a new owner with neither container receives the first-use UI.
            # Retain that fact across bootstrap retries; recovery of an existing
            # pair (including stopped or migrated containers) is ordinary loading.
            initial_creation = generation == 1 and current.get('initial_creation') is True and current.get('state') == 'provisioning'
            if not registered and generation == 1 and info.returncode:
                existing_sandbox = self.docker('ps', '-a', '--filter', 'name=^/' + sandbox + '$',
                                               '--format', '{{.Names}}', check=False)
                initial_creation = existing_sandbox.returncode == 0 and not existing_sandbox.stdout.strip()
            # Persist ownership before provisioning, including failed starts.
            # A replacement inherits the original volume, including adopted
            # instance-home names. Fresh hosts use a stable workspace volume.
            home_volume = current.get('home_volume') or (container + '-home' if not names and not info.returncode else 'gxzs-dsh-' + workspace + '-home')
            current.update(owner_id=owner, workspace_id=workspace, generation=generation,
                           instance_id=instance, ready=False, state='provisioning', home_volume=home_volume,
                           desired_image_digest=desired_digest, initial_creation=initial_creation)
            temporary = record.with_suffix('.tmp')
            temporary.write_text(json.dumps(current))
            temporary.replace(record)
            self.ensure_sandbox(workspace)
            self._ssh(folder, sandbox)
            if info.returncode:
                # Only model/settings templates are copied: never sessions,
                # SQLite, credentials from another user, or another home tree.
                for variable, filename in [('GXZS_HOST_SETTINGS_FILE', 'settings.yaml'), ('GXZS_HOST_CREDENTIALS_FILE', '.credentials.yaml')]:
                    source = os.environ.get(variable)
                    if source:
                        shutil.copyfile(source, folder / filename)
                        os.chmod(folder / filename, 0o600)
                        os.chown(folder / filename, 1000, 1000)
                env = {
                    'DSH_HOME': '/srv/dsh', 'DSH_PERMISSION_MODE': 'danger-full-access', 'DSH_TELEMETRY_DISABLED': '1',
                    'GXZS_HOST_OWNER_ID': owner, 'GXZS_HOST_GENERATION': str(generation), 'GXZS_HOST_INSTANCE_ID': instance,
                    'GXZS_ASSERTION_ISSUER': payload['assertion_issuer'],
                    'GXZS_ASSERTION_SIGNING_KEY': assertion_key(payload['assertion_key'], owner, generation, instance),
                    'GXZS_ASSERTION_AUDIENCE_PATH': '/ai/workbench', 'GXZS_PLATFORM_INTERNAL_TOKEN': payload['platform_token'],
                    'GXZS_PLATFORM_INTERNAL_URL': os.environ['GXZS_HOST_PLATFORM_URL'],
                    'GXZS_SANDBOX_MANAGER_URL': os.environ['GXZS_HOST_MANAGER_URL'],
                    'GXZS_SANDBOX_MANAGER_TOKEN': owner_token(os.environ['WORKBENCH_SANDBOX_MANAGER_TOKEN'], owner, workspace, generation, instance),
                    'GXZS_SANDBOX_WORKSPACE_ID': workspace, 'GXZS_SANDBOX_WORKSPACE': '/workspace',
                    'GXZS_SANDBOX_SSH_HOST': sandbox, 'GXZS_SANDBOX_HELPER_HASH': os.environ['GXZS_SANDBOX_HELPER_HASH'],
                    'GXZS_NATIVE_FILE_ATTACHMENTS': '1',
                }
                # Published roots are deployment-owned paths inside the Host.
                # DSH handles discovery/watch; never infer them from a user's home.
                if native_root():
                    env['GXZS_GLOBAL_SKILL_DIR'] = native_root()
                if any('\n' in str(value) or '\r' in str(value) for value in env.values()):
                    raise ValueError('Invalid runtime configuration')
                env_file = folder / 'host.env'
                env_file.write_text(''.join(f'{key}={value}\n' for key, value in env.items()))
                os.chmod(env_file, 0o600)
                self.docker('volume', 'create', '--label', 'gxzs.owner=' + owner, home_volume)
                self._create_container(current, folder, image, network, publish, host_state)
            self.docker('start', container)
            current.update(**self._container_identity(current, advertise))
            temporary.write_text(json.dumps(current))
            temporary.replace(record)
            # Java has registered the provisioning generation before ensure;
            # this heartbeat supplies its address before plugins bootstrap.
            self.heartbeat(current, 'provisioning')
            # Plugin bootstrap reads manager resources for this workspace. Do
            # not wait for readiness while holding its lock; maintenance probes
            # after this request releases it and publishes the ready transition.
            return current

    @staticmethod
    def _save(record, item):
        temporary = record.with_suffix('.tmp')
        temporary.write_text(json.dumps(item), encoding='utf-8')
        temporary.replace(record)

    def _runtime_config(self, workspace):
        advertise = os.environ.get('GXZS_HOST_ADVERTISE_IP')
        bind = os.environ.get('GXZS_HOST_BIND_IP')
        if not advertise or not bind:
            raise ValueError('Host advertised and bind IPs are required for manager access')
        ipaddress.IPv4Address(advertise)
        if not ipaddress.IPv4Address(bind).is_private or bind == '0.0.0.0':
            raise ValueError('Host listener must bind a private interface')
        publish = ['-p', bind + '::3081']
        host_state = PurePosixPath(os.environ['WORKBENCH_MANAGER_HOST_STATE'])
        if not host_state.is_absolute():
            raise ValueError('Manager host state mount must be absolute')
        network = self.ensure_network(workspace)
        return network, advertise, publish, host_state

    def _create_container(self, item, folder, image, network, publish, host_state):
        env_file = folder / 'host.env'
        if not env_file.exists():
            raise ValueError('Host runtime configuration is missing; replacement is required')
        memory = os.environ.get('GXZS_HOST_MEMORY', '1g')
        font_root = os.environ.get('GXZS_HOST_FONTS_DIR', '')
        font_mount = []
        if font_root:
            if not PurePosixPath(font_root).is_absolute() or any(char in font_root for char in ':\r\n\0'):
                raise ValueError('Host font directory must be an absolute Docker-host path')
            font_mount = ['-v', font_root + ':/usr/local/share/fonts/workbench:ro']
        sandbox, _ = self.identity(item['workspace_id'])
        self.docker('create', '--name', host_name(item), '--label', 'gxzs.owner=' + item['owner_id'],
                    '--label', 'gxzs.workspace=' + item['workspace_id'],
                    '--label', 'gxzs.instance=' + item['instance_id'],
                    *(['--label', 'gxzs.account=' + item['account_name']] if item.get('account_name') else []),
                    '--label', 'gxzs.generation=' + str(item['generation']), '--label', 'gxzs.credentials=owner-v1',
                    '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
                    '--network', network, '--restart', 'no', *cgroup_args(item['workspace_id']),
                    '--cpus', os.environ.get('GXZS_HOST_CPUS', '1'),
                    '--memory', memory, '--memory-swap', memory, '--pids-limit', '256', *publish,
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--env-file', str(env_file),
                    *font_mount, *global_skill_mounts(), '-v', item['home_volume'] + ':/srv/dsh',
                    '-v', volume_prefix(item, sandbox) + '-files:/workspace:ro',
                    '-v', str(host_state / 'hosts' / item['workspace_id']) + ':/run/gxzs:ro',
                    '-v', str(host_state / 'hosts' / item['workspace_id'] / 'ssh') + ':/home/gxzs/.ssh:ro', image)

    def _container_identity(self, item, advertise):
        info = json.loads(self.docker('inspect', host_name(item)).stdout)[0]
        self._verify_named_container(item, info)
        ports = (info.get('NetworkSettings', {}).get('Ports') or {}).get('3081/tcp')
        if not ports or not isinstance(ports[0], dict) or not str(ports[0].get('HostPort', '')).isdecimal():
            state = info.get('State', {})
            logging.getLogger(__name__).warning('Host endpoint unavailable instance=%s running=%s exit_code=%s oom=%s',
                                              item['instance_id'], state.get('Running'), state.get('ExitCode'), state.get('OOMKilled'))
            raise ResourceUnavailable('个人 Host 尚未启动就绪，请稍后重试；数据已保留', 'HOST_START_PENDING', 3)
        endpoint = 'http://' + advertise + ':' + str(ports[0]['HostPort'])
        return {'endpoint': endpoint, 'image_digest': info['Image']}

    @staticmethod
    def _verify_named_container(item, info, *, sandbox=False):
        if not item.get('container_name') or info is None:
            return
        labels = info.get('Config', {}).get('Labels') or {}
        expected = {'gxzs.workspace': item['workspace_id']}
        if not sandbox:
            expected.update({'gxzs.owner': item['owner_id'], 'gxzs.generation': str(item['generation'])})
            if labels.get('gxzs.instance') is not None:
                expected['gxzs.instance'] = item['instance_id']
        if any(labels.get(key) != value for key, value in expected.items()):
            raise ValueError('Named runtime container ownership changed')

    def replace(self, workspace, payload):
        """Root-only, resumable drain/fence/replace; never stop an active run."""
        global_skill_mounts()
        names = account_names(payload['owner_id'], payload.get('account_name'))
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', payload['instance_id']):
            raise ValueError('Invalid replacement identity')
        # Fail before draining for an unavailable image or unusable credentials.
        desired_digest = json.loads(self.docker('image', 'inspect', os.environ['GXZS_HOST_IMAGE']).stdout)[0]['Id']
        if payload.get('image_digest') and payload['image_digest'] != desired_digest:
            raise ValueError('Desired host image does not match the installed digest')
        assertion_key(payload['assertion_key'], payload['owner_id'], payload['generation'], payload['instance_id'])
        with self.lock(workspace):
            record = self.root / workspace / 'host.json'
            if not record.exists():
                raise ValueError('Replacement requires a registered host')
            current = json.loads(record.read_text(encoding='utf-8'))
            if 'profile_upgrade' in current and current['profile_upgrade'].get('phase') != 'prepared':
                return {'conflict': True, 'code': 'PROFILE_UPGRADE_PREPARING',
                        'error': 'Profile upgrade preparation must complete before replacement'}
            expected = (int(payload['expected_generation']), payload['expected_instance_id'])
            desired = (int(payload['generation']), payload['instance_id'])
            if current.get('account_name') and names and current['account_name'] != names['account_name']:
                raise ValueError('Runtime account binding cannot change')
            if current.get('account_name'):
                # Older callers may omit account_name; a registered physical
                # identity also survives later deployment-prefix changes.
                names = {key: current[key] for key in ('account_name', 'container_name', 'sandbox_name')}
            if payload['owner_id'] != current['owner_id'] or desired[0] != expected[0] + 1 or desired[1] == expected[1]:
                raise ValueError('Invalid replacement identity')
            transition = current.get('replacement') or {}
            if (current['generation'], current['instance_id']) == desired:
                if transition.get('previous_generation') != expected[0] or transition.get('previous_instance_id') != expected[1]:
                    raise ValueError('Replacement precondition changed')
                return self.ensure(workspace, payload)
            if (current['generation'], current['instance_id']) != expected:
                raise ValueError('Replacement precondition changed')
            if ((transition.get('previous_generation'), transition.get('previous_instance_id')) == expected
                    and (transition.get('generation'), transition.get('instance_id')) != desired):
                raise ValueError('Another replacement transition is already in progress')
            for target, previous in ((names.get('container_name'), host_name(current)),
                                     (names.get('sandbox_name'), self.identity(workspace)[0])):
                if target and target != previous and self._upgrade_inspect(target) is not None:
                    raise ValueError('Runtime account container name is already allocated')
            transition = dict(previous_generation=expected[0], previous_instance_id=expected[1],
                              generation=desired[0], instance_id=desired[1])
            current.update(state='draining', ready=False, replacement=transition)
            self._save(record, current)
            if self.admission.busy(current['owner_id']):
                return current
            observed = dict(current)
        # Native background work can outlive the platform's model admission.
        # Probe outside the workspace lock because Host plugins can call back
        # into this manager. Future schedules and UI leases survive replacement
        # through native recovery; they are not in-flight task admission.
        info = self._upgrade_inspect(host_name(observed))
        if info and info['State']['Running']:
            activity = self.native_activity(observed.get('endpoint')) if observed.get('endpoint') else None
            if activity is None or any(activity[key] for key in ('runningAgents', 'pendingMessages', 'runningJobs', 'activeSettingsWrites')):
                return observed
        with self.lock(workspace):
            current = json.loads(record.read_text(encoding='utf-8'))
            if current != observed or self.admission.busy(current['owner_id']):
                return current
            current['state'] = 'fencing'
            self._save(record, current)
            from mcp_runtime import invalidate
            invalidate(workspace)
            from global_memory import invalidate as cancel_memory
            cancel_memory(workspace)
            sandbox, _ = self.identity(workspace)
            self._stop_pair(current)
            # Capacity is freed only after both containers are confirmed stopped.
            self._fence(workspace, current['owner_id'], expected[1])
            # Logical instances remain unique across generations. The readable
            # Docker name is reusable only after the old generation is stopped.
            previous_name = host_name(current)
            if names:
                previous = self._upgrade_inspect(previous_name)
                if previous is not None:
                    labels = previous.get('Config', {}).get('Labels') or {}
                    if previous['State']['Running'] or any(labels.get(key) != value for key, value in {
                        'gxzs.owner': current['owner_id'], 'gxzs.workspace': workspace,
                        'gxzs.generation': str(current['generation']),
                    }.items()):
                        raise ValueError('Previous runtime container identity changed')
                    self.docker('rename', previous_name, names['container_name'] + '-previous-' + previous['Id'][:12])
                if sandbox != names['sandbox_name']:
                    previous = self._upgrade_inspect(sandbox)
                    if previous is not None:
                        if (previous['State']['Running'] or
                                (previous.get('Config', {}).get('Labels') or {}).get('gxzs.workspace') != workspace):
                            raise ValueError('Previous sandbox identity changed')
                        self.docker('rename', sandbox, names['sandbox_name'] + '-previous-' + previous['Id'][:12])
            if names:
                current['sandbox_volume_prefix'] = volume_prefix(current, sandbox)
                current.update(names)
            current.update(generation=desired[0], instance_id=desired[1], state='provisioning', ready=False,
                           home_volume=current.get('home_volume') or expected[1] + '-home')
            current.pop('profile_upgrade', None)
            current.pop('endpoint', None)
            self._save(record, current)
            return self.ensure(workspace, payload)

    def _upgrade_result(self, workspace, marker):
        identity = {key: marker[key] for key in
                    ('owner_id', 'generation', 'instance_id', 'home_volume', 'image_digest')}
        if marker.get('container_name'):
            identity['container_name'] = marker['container_name']
        message = json.dumps([workspace, marker['nonce'], identity], sort_keys=True, separators=(',', ':'))
        token = hmac.new(os.environ['WORKBENCH_SANDBOX_MANAGER_TOKEN'].encode(),
                         ('profile-upgrade\n' + message).encode(), hashlib.sha256).hexdigest()
        return dict(identity, workspace_id=workspace, fenced=True, phase=marker['phase'], token=token)

    def _upgrade_stopped(self, workspace, marker):
        sandbox, _ = self.identity(workspace)
        for container in (host_name(marker), sandbox):
            info = self._upgrade_inspect(container)
            if info is None:
                continue
            if info['State']['Running']:
                raise ValueError('Profile upgrade requires both original containers to remain stopped')
            if container == host_name(marker) and info['Image'] != marker['image_digest']:
                raise ValueError('Profile upgrade image identity changed')
            if container == host_name(marker):
                labels = info.get('Config', {}).get('Labels') or {}
                if any(labels.get(key) != value for key, value in {
                    'gxzs.owner': marker['owner_id'], 'gxzs.workspace': workspace,
                    'gxzs.generation': str(marker['generation']),
                }.items()):
                    raise ValueError('Profile upgrade container identity changed')

    def _upgrade_inspect(self, container):
        inspected = self.docker('inspect', container, timeout=5, check=False)
        if not inspected.returncode:
            return json.loads(inspected.stdout)[0]
        message = getattr(inspected, 'stderr', '').lower()
        if 'no such object' in message or 'no such container' in message:
            return None
        raise ValueError('Container state could not be verified')

    def _stop_pair(self, item, *, deadline=None):
        """Do not release admission or tool fences until physical stop is proved."""
        sandbox, _ = self.identity(item['workspace_id'])
        containers = (host_name(item), sandbox)
        inspected = []
        for container in containers:
            info = self._upgrade_inspect(container)
            self._verify_named_container(item, info, sandbox=container == sandbox)
            if info is not None:
                inspected.append(container)
        for container in inspected:
            if deadline is not None:
                if deadline - time.time() < 16:
                    raise ValueError('Sleep handoff expired before container stop')
                self.docker('stop', '--time', '10', container, timeout=15, check=True)
            else:
                self.docker('stop', '--time', '10', container, check=True)
        # A successful CLI exit is insufficient (daemon races, asynchronous
        # wrappers). Unknown inspection is not evidence that a container vanished.
        for container in containers:
            info = self._upgrade_inspect(container)
            self._verify_named_container(item, info, sandbox=container == sandbox)
            if info is not None and info.get('State', {}).get('Running') is not False:
                raise ValueError('Container stop could not be confirmed')

    def profile_upgrade(self, workspace, payload):
        """Root-only maintenance barrier; only explicit replacement can resume this owner."""
        operation = payload.get('operation')
        if operation not in {'begin', 'check', 'complete'}:
            raise ValueError('Unsupported profile upgrade operation')
        record = self.root / workspace / 'host.json'
        with self.lock(workspace):
            if not record.exists():
                raise ValueError('Profile upgrade requires a registered host')
            current = json.loads(record.read_text(encoding='utf-8'))
            if current.get('workspace_id') != workspace:
                raise ValueError('Profile upgrade workspace identity changed')
            marker = current.get('profile_upgrade')
            if operation == 'begin':
                try:
                    expected = (payload['owner_id'], int(payload['generation']), payload['instance_id'])
                except (KeyError, ValueError, TypeError) as error:
                    raise ValueError('Profile upgrade requires the original host identity') from error
                if expected != (current['owner_id'], current['generation'], current['instance_id']):
                    raise ValueError('Profile upgrade host identity changed')
                if marker is None:
                    transition = current.get('replacement') or {}
                    if (current.get('state') == 'fencing' or
                            transition.get('generation', current['generation']) > current['generation']):
                        raise ValueError('Another host maintenance transition is in progress')
                    info = self._upgrade_inspect(host_name(current))
                    if info:
                        labels = info.get('Config', {}).get('Labels') or {}
                        if any(labels.get(key) != value for key, value in {
                            'gxzs.owner': current['owner_id'], 'gxzs.workspace': workspace,
                            'gxzs.generation': str(current['generation']),
                        }.items()):
                            raise ValueError('Profile upgrade container identity changed')
                    image = info['Image'] if info else current.get('image_digest')
                    if not isinstance(image, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
                        raise ValueError('Profile upgrade requires the registered immutable image')
                    if current.get('image_digest') and current['image_digest'] != image:
                        raise ValueError('Profile upgrade registered image identity changed')
                    installed = json.loads(self.docker('image', 'inspect', image).stdout)[0]
                    if installed.get('Id') != image:
                        raise ValueError('Profile upgrade immutable image is not installed')
                    home = current.get('home_volume') or current['instance_id'] + '-home'
                    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]+', home):
                        raise ValueError('Profile upgrade attachment volume is invalid')
                    marker = dict(owner_id=current['owner_id'], generation=current['generation'],
                                  instance_id=current['instance_id'], image_digest=image, home_volume=home,
                                  nonce=secrets.token_hex(32), phase='draining')
                    if current.get('container_name'):
                        marker['container_name'] = current['container_name']
                    current.update(home_volume=home, profile_upgrade=marker, state='draining', ready=False)
                    self._save(record, current)
            if not isinstance(marker, dict) or marker.get('phase') not in {'draining', 'fencing', 'preparing', 'prepared'}:
                raise ValueError('Profile upgrade has not begun')
            if any(current.get(key) != marker[key] for key in ('owner_id', 'generation', 'instance_id', 'home_volume')):
                raise ValueError('Profile upgrade original binding changed')
            if host_name(current) != host_name(marker):
                raise ValueError('Profile upgrade container binding changed')
            result = self._upgrade_result(workspace, marker)
            if operation != 'begin':
                supplied = payload.get('token')
                if not isinstance(supplied, str) or not hmac.compare_digest(supplied, result['token']):
                    raise PermissionError('Profile upgrade token does not match this maintenance operation')
                if marker['phase'] not in {'preparing', 'prepared'} or current.get('state') != 'fencing':
                    raise ValueError('Profile upgrade is not fenced for preparation')
                self._upgrade_stopped(workspace, marker)
                if operation == 'complete':
                    marker['phase'] = 'prepared'
                    self._save(record, current)
                return self._upgrade_result(workspace, marker)
            if marker['phase'] in {'preparing', 'prepared'}:
                if current.get('state') != 'fencing':
                    raise ValueError('Profile upgrade maintenance barrier changed')
                self._upgrade_stopped(workspace, marker)
                return result
            if self.admission.busy(current['owner_id']):
                return dict(fenced=False, phase=marker['phase'], reason='workspace_busy', retry_after=3)
            observed = json.loads(json.dumps(current))
        # Native activity may call back into the manager; never hold its workspace lock here.
        if marker['phase'] == 'draining':
            info = self._upgrade_inspect(host_name(marker))
            if info and info['State']['Running']:
                activity = self.native_activity(observed.get('endpoint')) if observed.get('endpoint') else None
                if activity is None or any(activity[key] for key in
                                           ('runningAgents', 'pendingMessages', 'runningJobs', 'activeSettingsWrites')):
                    return dict(fenced=False, phase='draining', reason='host_activity_unknown_or_busy', retry_after=3)
        with self.lock(workspace):
            current = json.loads(record.read_text(encoding='utf-8'))
            if current != observed or self.admission.busy(current['owner_id']):
                return dict(fenced=False, phase='draining', reason='binding_or_activity_changed', retry_after=3)
            marker = current['profile_upgrade']
            current.update(state='fencing', ready=False)
            marker['phase'] = 'fencing'
            self._save(record, current)
            from mcp_runtime import invalidate
            from global_memory import invalidate as cancel_memory
            invalidate(workspace)
            cancel_memory(workspace)
            sandbox, _ = self.identity(workspace)
            self._stop_pair(current)
            self._upgrade_stopped(workspace, marker)
            self._fence(workspace, current['owner_id'], marker['instance_id'])
            marker['phase'] = 'preparing'
            self._save(record, current)
            return self._upgrade_result(workspace, marker)

    def _fence(self, workspace, owner, instance, *, preserve_pending=False):
        self.native_snapshots.pop(instance, None)
        from global_memory import fence_workspace
        fence_workspace(workspace)
        from mcp_runtime import fence_workspace as fence_mcp
        fence_mcp(workspace)
        if preserve_pending:
            self.admission.fence(owner, instance, preserve_pending=True)
        else:
            self.admission.fence(owner, instance)

    def _ssh(self, folder, sandbox):
        ssh = folder / 'ssh'
        ssh.mkdir(mode=0o700, exist_ok=True)
        key = ssh / 'id_ed25519'
        if not key.exists():
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True, capture_output=True)
        public = key.with_suffix('.pub').read_text().strip()
        # The sandbox drops all capabilities. UID 0 cannot bypass the owner's
        # 0700 SSH directory or chown files; install keys as the actual owner.
        script = "from pathlib import Path; import os,sys; p=Path('/home/gxzs/.ssh'); p.mkdir(mode=0o700,exist_ok=True); f=p/'authorized_keys'; key=sys.stdin.read().strip(); old=f.read_text() if f.exists() else ''; f.write_text(old if key in old.splitlines() else old.rstrip()+'\\n'+key+'\\n'); os.chmod(f,0o600)"
        self.docker('exec', '--user', '1000', '-i', sandbox, '/usr/local/bin/python', '-I', '-S', '-c', script, stdin=public)
        host_key = self.docker('exec', '--user', '1000', sandbox, 'cat', '/home/gxzs/.ssh/ssh_host_ed25519_key.pub').stdout.split()
        if len(host_key) < 2 or host_key[0] != 'ssh-ed25519':
            raise ValueError('Sandbox SSH host key is missing or invalid')
        port = int(os.environ.get('GXZS_SANDBOX_SSH_PORT', '2222'))
        if not 1 <= port <= 65535:
            raise ValueError('Invalid sandbox SSH port')
        (ssh / 'known_hosts').write_text(f'[{sandbox}]:{port} ' + ' '.join(host_key[:2]) + '\n')
        (ssh / 'config').write_text(f'Host {sandbox}\n  HostName {sandbox}\n  Port {port}\n  User gxzs\n  IdentityFile /home/gxzs/.ssh/id_ed25519\n  UserKnownHostsFile /home/gxzs/.ssh/known_hosts\n  StrictHostKeyChecking yes\n  BatchMode yes\n')
        os.chown(folder, 1000, 1000)
        os.chown(ssh, 1000, 1000)
        for item in ssh.iterdir():
            os.chown(item, 1000, 1000)
            os.chmod(item, 0o600)

    def healthy(self, endpoint):
        try:
            with self.opener.open(endpoint + '/ai/workbench/health', timeout=2) as response:
                return response.status == 200 and json.loads(response.read(4096)).get('ready') is True
        except Exception:
            return False

    def alive(self, endpoint):
        try:
            with self.opener.open(endpoint + '/ai/workbench/health', timeout=2) as response:
                return response.status == 200 and json.loads(response.read(4096)).get('live') is True
        except HTTPError as error:
            if error.code == 503:
                try:
                    return json.loads(error.read(4096)).get('live') is True
                except (ValueError, OSError):
                    return False
            return False
        except Exception:
            return False

    def dependency_degraded(self, endpoint):
        """Return true only for a live host blocked by a recoverable dependency.

        The Workbench health endpoint deliberately reports 503 while its MCP
        catalog is unavailable. Restarting the owner Host/Sandbox pair cannot
        repair that upstream dependency and instead creates a recovery storm.
        """
        try:
            with self.opener.open(endpoint + '/ai/workbench/health', timeout=2) as response:
                payload = json.loads(response.read(4096))
        except HTTPError as error:
            if error.code != 503:
                return False
            try:
                payload = json.loads(error.read(4096))
            except (ValueError, OSError):
                return False
        except Exception:
            return False
        if payload.get('live') is True and payload.get('runtime_error') == 'STORAGE_PRESSURE':
            return True
        catalog_blocked = (payload.get('recovery') == 'ready'
                           or (payload.get('recovery') == 'failed'
                               and payload.get('recovery_dependency') == 'mcp_catalog'))
        return (payload.get('live') is True and catalog_blocked and not payload.get('runtime_error')
                and payload.get('resources') == 'unavailable')

    @staticmethod
    def _activity_counts(payload):
        activity = payload.get('activity') or {}
        keys = ('runningAgents', 'pendingMessages', 'runningJobs', 'activeSchedules', 'activeSidebarResources', 'activeSettingsWrites')
        if (type(activity.get('protocol')) is int and activity.get('protocol') in (1, 2) and activity.get('status') == 'ready'
                and all(type(activity.get(key)) is int and activity[key] >= 0 for key in keys)):
            counts = {key: activity[key] for key in keys}
            if activity['protocol'] == 2:
                registered = activity.get('registeredSchedules')
                pending = activity.get('pendingScheduleReports')
                if (type(registered) is not int or not 0 <= registered <= counts['activeSchedules']
                        or type(pending) is not int or pending < 0):
                    return None
                counts['activeSchedules'] -= registered
                counts['activeSettingsWrites'] += pending
            return counts
        return None

    def native_activity(self, endpoint):
        """Only a complete native activity read can authorize idle shutdown.

        Legacy active schedules remain resident. Protocol 2 permits sleep only
        after platform wakeup acknowledgment and a final native handoff.
        The manager never computes or delivers reminders.
        Older Hosts and unavailable catalogs fail closed until upgraded/ready.
        """
        try:
            with self.opener.open(endpoint + '/ai/workbench/health', timeout=2) as response:
                payload = json.loads(response.read(4096))
                if response.status == 200 and payload.get('ready') is True:
                    self.sleep_protocols[endpoint] = (payload.get('activity') or {}).get('protocol')
                    return self._activity_counts(payload)
        except Exception:
            pass
        return None

    def _prepare_sleep(self, item):
        """The current Host fences writes/steps and rechecks its acknowledged next wakeup."""
        if self.sleep_protocols.get(item['endpoint']) != 2:
            return True  # Legacy protocol still refuses every active schedule.
        try:
            token = owner_token(os.environ['WORKBENCH_SANDBOX_MANAGER_TOKEN'], item['owner_id'],
                                item['workspace_id'], item['generation'], item['instance_id'])
            request = Request(item['endpoint'] + '/ai/workbench/lifecycle/sleep', data=b'', method='POST',
                              headers={'Authorization': 'Bearer ' + token})
            with self.opener.open(request, timeout=3) as response:
                payload = json.loads(response.read(4096))
            prepared = (payload.get('prepared') is True and payload.get('generation') == item['generation']
                    and payload.get('instance_id') == item['instance_id']
                    and type(payload.get('until')) is int and payload['until'] > time.time() * 1000 + 25_000)
            if prepared:
                self.sleep_deadlines[item['instance_id']] = payload['until'] / 1000
            return prepared
        except Exception:
            return False

    def failed_transport_activity(self, endpoint):
        """A definitive, non-reconnecting SSH failure is not a probe timeout."""
        try:
            with self.opener.open(endpoint + '/ai/workbench/health', timeout=2):
                return None
        except HTTPError as error:
            if error.code != 503:
                return None
            try:
                payload = json.loads(error.read(4096))
                if (payload.get('live') is True and payload.get('ready') is False
                        and payload.get('runtime_error') == 'SSH_UNAVAILABLE'):
                    return self._activity_counts(payload)
            except (ValueError, OSError, AttributeError, TypeError):
                pass
        except Exception:
            pass
        return None

    def maintain(self, requested_workspace=None):
        # Do not wait for a whole batch: a slow owner must not delay the next
        # health read/heartbeat for owners whose previous check has finished.
        # Bound both running and queued work, and never probe an owner twice.
        with self._maintenance_guard:
            if self._maintenance_closed:
                return ()
            self._reap_maintenance()
            records = ([self.root / requested_workspace / 'host.json'] if requested_workspace is not None
                       else sorted(self.root.glob('*/host.json')))
            records = [record for record in records if record.is_file()]
            start = next((index for index, record in enumerate(records)
                          if record.parent.name > self._maintenance_cursor), 0)
            for record in records[start:] + records[:start]:
                workspace = record.parent.name
                if workspace in self._maintenance_pending:
                    continue
                if len(self._maintenance_pending) >= 16:
                    self._reap_maintenance()
                    if len(self._maintenance_pending) >= 16:
                        break
                future = Future()
                self._maintenance_pending[workspace] = future
                try:
                    dispatched = self._maintenance_pool.submit(self._run_maintenance, record, future)
                    dispatched.add_done_callback(lambda done, target=future: target.cancel() if done.cancelled() else None)
                except Exception:
                    # submit enqueues before starting a thread. On thread-start
                    # failure, cancel work that has not started; retain a running
                    # owner's Future until its lifecycle operation really ends.
                    future.cancel()
                    self._maintenance_pool.shutdown(wait=False, cancel_futures=True)
                    self._maintenance_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix='host-maintenance')
                    raise
                # Resume after the last submitted owner when capacity returns,
                # so saturated workers cannot permanently skip later records.
                if requested_workspace is None:
                    self._maintenance_cursor = workspace
            return tuple(self._maintenance_pending.values())

    def _run_maintenance(self, record, future):
        if not future.set_running_or_notify_cancel():
            return
        try:
            self._maintain_one(record)
        except BaseException as error:
            future.set_exception(error)
        else:
            future.set_result(None)

    def _reap_maintenance(self):
        for workspace, future in list(self._maintenance_pending.items()):
            if future.done():
                del self._maintenance_pending[workspace]
                if future.cancelled():
                    continue
                try:
                    future.result()
                except Exception:
                    logging.getLogger(__name__).exception('Host maintenance worker failed for workspace %s', workspace)

    def close(self):
        with self._maintenance_guard:
            self._maintenance_closed = True
            pending = tuple(self._maintenance_pending.values())
        # Let an in-flight lifecycle operation finish under its existing owner
        # lock; queued work must not start after manager shutdown.
        self._maintenance_pool.shutdown(wait=True, cancel_futures=True)
        # A pool retired after a thread-start failure may still be finishing a
        # running owner. Its Future remains the same admission fence above.
        for future in pending:
            try:
                future.result()
            except Exception:
                pass
        with self._maintenance_guard:
            self._reap_maintenance()

    def heartbeat(self, item, state):
        request = Request(os.environ['GXZS_HOST_PLATFORM_URL'].removesuffix('/internal/workbench') + '/internal/ai/orchestration/hosts/heartbeat',
                          data=json.dumps({**item, 'state': state}).encode(),
                          headers={'Authorization': 'Bearer ' + os.environ['GXZS_ORCHESTRATOR_TOKEN'], 'Content-Type': 'application/json'})
        with self.opener.open(request, timeout=5) as response:
            response.read(4096)

    def schedule(self, workspace, payload):
        with self.lock(workspace):
            record = self.root / workspace / 'host.json'
            info = None
            managed = record.exists()
            if managed:
                item = json.loads(record.read_text())
            else:
                # Migrated hosts were registered by the platform before Hosts
                # owned provisioning. Verify their actual container binding;
                # do not enroll them into automatic restart/idle shutdown.
                instance = payload['instance_id']
                if not re.fullmatch(r'gxzs-migration-host-\d+', instance):
                    raise ValueError('Scheduling host is not registered')
                result = self.docker('inspect', instance, check=False)
                if result.returncode:
                    raise ValueError('Scheduling host is not registered')
                info = json.loads(result.stdout)[0]
                env = dict(value.split('=', 1) for value in info['Config'].get('Env', []) if '=' in value)
                expected = {
                    'GXZS_HOST_OWNER_ID': payload['owner_id'],
                    'GXZS_HOST_GENERATION': str(int(payload['generation'])),
                    'GXZS_HOST_INSTANCE_ID': instance,
                    'GXZS_SANDBOX_WORKSPACE_ID': workspace,
                }
                if any(env.get(key) != value for key, value in expected.items()):
                    raise ValueError('Scheduling host identity mismatch')
                item = dict(owner_id=payload['owner_id'], generation=int(payload['generation']), instance_id=instance)
            if (item['owner_id'], item['generation'], item['instance_id']) != (payload['owner_id'], int(payload['generation']), payload['instance_id']):
                raise ValueError('Scheduling host identity mismatch')
            draining_ticket = item.get('state') == 'draining' and self.admission.pending(
                payload['owner_id'], int(payload['generation']), payload['instance_id'],
                payload.get('ticket_id') or payload['run_id'], payload['chat_id']) is True
            if ('profile_upgrade' in item and payload['action'] == 'acquire'
                    and not (draining_ticket and item['profile_upgrade'].get('phase') == 'draining')):
                raise ValueError('Profile upgrade has paused new task admission')
            if item.get('state') in {'draining', 'fencing', 'stopped'} and payload['action'] == 'acquire' and not draining_ticket:
                raise ValueError('Host is draining; new task admission is paused')
            if payload['action'] != 'release':
                if info is None:
                    info = json.loads(self.docker('inspect', host_name(item)).stdout)[0]
                self._verify_named_container(item, info)
                if not info['State']['Running']:
                    raise ValueError('Scheduling host is stopped')
            if managed and payload['action'] == 'acquire' and item.get('ready') is not True and not draining_ticket:
                raise ResourceUnavailable('个人工作环境正在恢复，任务等待准入', 'HOST_NOT_READY', 2)
            if payload['action'] == 'acquire':
                assert_storage_writable(self.root)
            (self.root.parent / workspace).touch()
            return self.admission.request(payload['owner_id'], int(payload['generation']), payload['instance_id'],
                                          payload.get('ticket_id') or payload['run_id'], payload['chat_id'], payload['action'], bool(payload.get('retry')))

    def _maintain_one(self, record):
        heartbeats = []
        cleanup_item = None
        try:
            with self.lock(record.parent.name):
                item = json.loads(record.read_text())
                if item.get('state') == 'fencing':
                    return
                if 'profile_upgrade' in item:
                    heartbeats.append((dict(item), 'draining'))
                    return
                observed = dict(item)
            # Both Docker inspection and health checks can be slow. In
            # particular, plugin readiness may call back into this workspace.
            info = self._upgrade_inspect(host_name(item))
            sandbox, _ = self.identity(item['workspace_id'])
            sandbox_info = self._upgrade_inspect(sandbox)
            self._verify_named_container(item, info)
            self._verify_named_container(item, sandbox_info, sandbox=True)
            sandbox_running = bool(sandbox_info and sandbox_info['State']['Running'])
            sandbox_health = ((sandbox_info or {}).get('State', {}).get('Health') or {}).get('Status')
            sandbox_healthy = sandbox_running and sandbox_health in (None, 'healthy')
            host_running = bool(info and info['State']['Running'])
            if item.get('state') == 'stopped':
                # Older managers could restart an intentionally stopped pair
                # without changing its durable state. Reconcile that drift,
                # but never stop a pair while any admission is still busy.
                with self.lock(record.parent.name):
                    current = json.loads(record.read_text())
                    if current != observed or self.admission.busy(current['owner_id']):
                        return
                    if host_running or sandbox_running:
                        self._stop_pair(current)
                        self._fence(current['workspace_id'], current['owner_id'], current['instance_id'])
                        heartbeats.append((dict(current), 'stopped'))
                    self.failures.pop(current['instance_id'], None)
                    self.recoveries.pop(current['instance_id'], None)
                return
            healthy = bool(host_running and sandbox_healthy and item.get('endpoint') and self.healthy(item['endpoint']))
            alive = bool(healthy or (host_running and item.get('endpoint') and self.alive(item['endpoint'])))
            dependency_degraded = bool(not healthy and alive and sandbox_healthy
                                       and self.dependency_degraded(item['endpoint']))
            process_pressure = bool(host_running and sandbox_running and
                                    (pid_pressure(info) or pid_pressure(sandbox_info)))
            native_activity = self.native_activity(item['endpoint']) if healthy or alive else None
            # A later complete readiness/activity response supersedes an earlier
            # timed-out probe. Do not recover a Host that has already caught up.
            healthy = healthy or (sandbox_healthy and native_activity is not None)
            failed_transport_activity = (self.failed_transport_activity(item['endpoint'])
                                         if not healthy and alive else None)
            with self.lock(record.parent.name):
                item = json.loads(record.read_text())
                if item != observed:
                    return
                activity = self.root.parent / item['workspace_id']
                if native_activity is not None:
                    previous = self.native_snapshots.get(item['instance_id'])
                    # Ongoing native work or a confirmed state transition is
                    # real activity. Empty unchanged probes and unknown reads
                    # cannot extend the idle window.
                    if (any(native_activity[key] for key in ('runningAgents', 'pendingMessages', 'runningJobs', 'activeSidebarResources', 'activeSettingsWrites'))
                            or previous is not None and previous != native_activity):
                        activity.touch()
                    self.native_snapshots[item['instance_id']] = dict(native_activity)
                native_idle = native_activity is not None and not any(native_activity.values())
                idle = (item.get('state') != 'draining' and activity.exists()
                        and time.time() - activity.stat().st_mtime > IDLE_TIMEOUT_SECONDS
                        and not self.admission.busy(item['owner_id']) and native_idle)
                if host_running and idle:
                    if not self._prepare_sleep(item):
                        if healthy and item.get('ready') is True:
                            heartbeats.append((dict(item), 'ready'))
                        return
                    deadline = self.sleep_deadlines.pop(item['instance_id'], None)
                    if deadline is None:
                        self._stop_pair(item)
                    else:
                        self._stop_pair(item, deadline=deadline)
                    self._fence(item['workspace_id'], item['owner_id'], item['instance_id'])
                    item.update(state='stopped', ready=False)
                    self._save(record, item)
                    heartbeats.append((dict(item), 'stopped'))
                    self.failures.pop(item['instance_id'], None)
                    self.recoveries.pop(item['instance_id'], None)
                    return
                if healthy and not process_pressure:
                    self.failures.pop(item['instance_id'], None)
                    self.recoveries.pop(item['instance_id'], None)
                    if item.get('state') == 'draining':
                        heartbeats.append((dict(item), 'draining'))
                        return
                    if item.get('state') == 'provisioning' and item.get('initial_creation') is True:
                        item['initial_creation'] = False
                    if item.get('ready') is not True:
                        self.admission.restore_pending(item['owner_id'], item['generation'], item['instance_id'])
                    item.update(state='ready', ready=True)
                    self._save(record, item)
                    heartbeats.append((dict(item), 'ready'))
                    if time.monotonic() >= self.cleanup_at.get(item['instance_id'], 0):
                        cleanup_item = dict(item)
                    return

                # An unavailable external MCP catalog is an application-level
                # degraded state, not evidence that either local container is
                # damaged. Pause new admission, retain the current generation,
                # and let the Host's catalog poller recover in place.
                if (dependency_degraded or process_pressure) and failed_transport_activity is None:
                    self.failures.pop(item['instance_id'], None)
                    self.recoveries.pop(item['instance_id'], None)
                    next_state = 'degraded' if alive and item.get('state') in {'ready', 'degraded'} else item.get('state')
                    if item.get('ready') is not False or item.get('state') != next_state:
                        item.update(ready=False, state=next_state)
                        self._save(record, item)
                    # Publish liveness separately from admission. The platform
                    # may route existing reads/stops to this identity, but must
                    # not authorize new execution from a degraded heartbeat.
                    if alive:
                        heartbeats.append((dict(item), next_state))
                    return

                # Pause new work as soon as either half of the pair is
                # unhealthy. Provisioning/draining heartbeats remain monotonic;
                # a previously ready generation is never reported backwards.
                if item.get('ready') is not False:
                    item['ready'] = False
                    self._save(record, item)
                if alive and item.get('state') in {'provisioning', 'draining'}:
                    heartbeats.append((dict(item), item['state']))
                now = time.time()
                since = self.failures.setdefault(item['instance_id'], now)
                if (host_running and sandbox_running and failed_transport_activity is not None
                        and (self.admission.active(item['owner_id']) or any(failed_transport_activity[key]
                            for key in ('runningAgents', 'runningJobs', 'activeSettingsWrites')))):
                    # The native session still runs on this live Host. Keep its
                    # history and stop routes reachable while execution drains;
                    # readiness remains false, so no new work can be admitted.
                    # Without the degraded heartbeat the platform expires this
                    # generation and repeatedly sends the UI through startup.
                    if item.get('state') in {'ready', 'degraded'}:
                        item['state'] = 'degraded'
                        self._save(record, item)
                        heartbeats.append((dict(item), 'degraded'))
                    return
                # A missing Docker object is definitive, unlike a transient
                # readiness probe. Recover it quickly while retaining a short
                # debounce for daemon/eventual-consistency races.
                grace = (5 if info is None or sandbox_info is None else
                         (180 if item.get('state') == 'provisioning' else 60))
                recovery = self.recoveries.get(item['instance_id'], {})
                if now - since <= grace or now < recovery.get('next_retry_at', 0):
                    return
                # A timed-out HTTP probe does not prove a running process is
                # dead. Preserve admitted/native work, including when the busy
                # event loop cannot answer the activity read. A stopped/missing
                # container remains definitive evidence and can be recovered.
                if host_running and sandbox_running and failed_transport_activity is None:
                    if (self.admission.busy(item['owner_id'])
                            or (item.get('state') != 'provisioning' and (native_activity is None
                                or any(native_activity[key] for key in
                                       ('runningAgents', 'pendingMessages', 'runningJobs', 'activeSettingsWrites'))))):
                        return
                attempts = int(recovery.get('attempts', 0)) + 1
                reason = ('host_missing' if info is None else
                          ('sandbox_' + str(sandbox_health or ('stopped' if not sandbox_running else 'unknown'))
                           if not sandbox_healthy else ('ssh_unavailable' if failed_transport_activity is not None
                                                        else 'host_unready' if alive else 'host_unreachable')))
                logging.getLogger(__name__).warning(
                    'Recovering host pair workspace=%s instance=%s attempt=%d reason=%s',
                    item['workspace_id'], item['instance_id'], attempts, reason)
                self.recoveries[item['instance_id']] = {
                    'attempts': attempts,
                    'next_retry_at': now + min(300, 30 * (2 ** min(attempts - 1, 4))),
                }
                # Preserve all named volumes. Fencing invalidates in-flight
                # tools, then the same containers restart with the same owner
                # and generation. Readiness is published by a later probe.
                self._stop_pair(item)
                self._fence(item['workspace_id'], item['owner_id'], item['instance_id'], preserve_pending=True)
                self.ensure_sandbox(item['workspace_id'])
                self._ssh(record.parent, sandbox)
                image = os.environ['GXZS_HOST_IMAGE']
                desired = json.loads(self.docker('image', 'inspect', image).stdout)[0]['Id']
                if desired != item.get('desired_image_digest'):
                    raise ValueError('Host image changed; replacement is required before recovery')
                # Recreate instead of restarting so a damaged writable layer,
                # stale shared network or obsolete cgroup limit cannot survive
                # recovery. Durable owner state remains in the named volume.
                if info is not None:
                    self.docker('rename', host_name(item),
                                host_name(item) + '-previous-' + info['Id'][:12])
                network, advertise, publish, host_state = self._runtime_config(item['workspace_id'])
                self._create_container(item, record.parent, image, network, publish, host_state)
                self.docker('start', host_name(item))
                item.update(**self._container_identity(item, advertise))
                self._save(record, item)
                self.failures[item['instance_id']] = time.time()
        except Exception:
            # Keep capacity reserved on uncertain fencing; never log secrets.
            logging.getLogger(__name__).exception('Host maintenance failed for workspace %s', record.parent.name)
        finally:
            # Platform DNS/TLS can stall for five seconds. Never make schedule
            # wait behind that network call while holding the owner lock.
            for item, state in heartbeats:
                try:
                    self.heartbeat(item, state)
                except Exception:
                    logging.getLogger(__name__).exception(
                        'Host heartbeat failed workspace=%s instance=%s state=%s',
                        item['workspace_id'], item['instance_id'], state)
            if cleanup_item is not None:
                try:
                    # Snapshot identity under the lock, then release it before
                    # potentially slow Docker list/inspect/remove operations.
                    with self.lock(record.parent.name):
                        current = json.loads(record.read_text())
                        eligible = (current.get('ready') is True and current.get('state') == 'ready'
                                    and all(current.get(field) == cleanup_item[field] for field in
                                            ('owner_id', 'workspace_id', 'generation', 'instance_id')))
                    if eligible:
                        try:
                            self._cleanup_superseded(cleanup_item)
                        finally:
                            self.cleanup_at[cleanup_item['instance_id']] = time.monotonic() + 300
                except Exception:
                    logging.getLogger(__name__).warning(
                        'Superseded Host cleanup deferred workspace=%s', cleanup_item['workspace_id'])
