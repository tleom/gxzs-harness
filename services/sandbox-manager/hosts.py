"""Owner-scoped host lifecycle. Runtime templates are administrator-controlled."""
import json
from resource_limits import cgroup_args, owner_cgroup, pid_pressure, ResourceUnavailable
import logging
from concurrent.futures import ThreadPoolExecutor
import ipaddress
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import time
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError
from owner_auth import owner_token, assertion_key


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

    def _cleanup_superseded(self, item):
        """Remove only stopped, identity-verified predecessors after the new Host is healthy."""
        listed = self.docker('ps', '-a', '--filter', 'label=gxzs.owner=' + item['owner_id'],
                             '--filter', 'label=gxzs.workspace=' + item['workspace_id'],
                             '--format', '{{.Names}}', timeout=5, check=False)
        if listed.returncode:
            raise RuntimeError('Unable to list superseded hosts')
        prefix = item['instance_id'] + '-previous-'
        for name in listed.stdout.splitlines()[:8]:
            if not re.fullmatch(re.escape(prefix) + r'[0-9a-f]{12}', name):
                continue
            observed = self.docker('inspect', name, timeout=5, check=False)
            if observed.returncode:
                continue
            previous = json.loads(observed.stdout)[0]
            labels = previous.get('Config', {}).get('Labels') or {}
            if (previous.get('Id', '')[:12] != name[len(prefix):]
                    or previous.get('State', {}).get('Running') is not False
                    or any(labels.get(label) != expected for label, expected in {
                        'gxzs.owner': item['owner_id'],
                        'gxzs.workspace': item['workspace_id'],
                        'gxzs.generation': str(item['generation']),
                    }.items())):
                continue
            removed = self.docker('rm', name, timeout=5, check=False)
            if removed.returncode:
                logging.getLogger(__name__).warning('Superseded Host cleanup deferred workspace=%s', item['workspace_id'])

    def ensure(self, workspace, payload):
        owner = payload['owner_id']
        instance = payload['instance_id']
        generation = int(payload['generation'])
        if not re.fullmatch(r'[^:\s/]+:\d+', owner) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', instance) or generation < 1:
            raise ValueError('Invalid host identity')
        with self.lock(workspace):
            folder = self.root / workspace
            folder.mkdir(mode=0o750, exist_ok=True)
            record = folder / 'host.json'
            current = {}
            if record.exists():
                current = json.loads(record.read_text())
                if (current['owner_id'], current['generation'], current['instance_id']) != (owner, generation, instance):
                    raise ValueError('Host identity changed; fence the previous generation before replacement')
                if current.get('state') in {'draining', 'fencing'}:
                    return {**current, 'ready': False}
                # A ready generation can temporarily be unavailable while the
                # manager restarts its host/sandbox pair. Never regress the
                # platform's monotonic ready state back to provisioning.
                if current.get('state') == 'ready' and current.get('ready') is False:
                    return current
            image = os.environ['GXZS_HOST_IMAGE']
            image_info = json.loads(self.docker('image', 'inspect', image).stdout)[0]
            desired_digest = image_info['Id']
            if payload.get('image_digest') and payload['image_digest'] != desired_digest:
                raise ValueError('Desired host image does not match the installed digest')
            network, advertise, publish, host_state = self._runtime_config(workspace)
            sandbox, _ = self.identity(workspace)
            info = self.docker('inspect', instance, check=False)
            if not info.returncode:
                existing = json.loads(info.stdout)[0]
                labels = existing['Config'].get('Labels') or {}
                if labels.get('gxzs.owner') != owner or labels.get('gxzs.workspace') != workspace or labels.get('gxzs.generation') != str(generation):
                    raise ValueError('Existing host is not managed for this owner; explicit adoption is required')
                if labels.get('gxzs.credentials') != 'owner-v1':
                    raise ValueError('Host credential rollout requires draining before replacement')
                if existing['Config']['Image'] != image:
                    raise ValueError('Host image rollout requires draining before replacement')
                if existing['Image'] != desired_digest:
                    raise ValueError('Host image digest changed; drain before replacement')
                if (existing.get('HostConfig', {}).get('CgroupParent') or '') != owner_cgroup(workspace):
                    raise ValueError('Host resource rollout requires draining before replacement')
                attached = set((existing.get('NetworkSettings', {}).get('Networks') or {}).keys())
                if attached != {network}:
                    raise ValueError('Host network rollout requires draining before replacement')
                if not existing['State']['Running']:
                    # Restart only after fencing any surviving tool processes.
                    self.docker('stop', '--time', '10', sandbox)
                    self._fence(workspace, owner, instance)
            # Persist ownership before provisioning, including failed starts.
            # A replacement inherits the original volume, including adopted
            # instance-home names. Fresh hosts use a stable workspace volume.
            home_volume = current.get('home_volume') or (instance + '-home' if not info.returncode else 'gxzs-dsh-' + workspace + '-home')
            current.update(owner_id=owner, workspace_id=workspace, generation=generation,
                           instance_id=instance, ready=False, state='provisioning', home_volume=home_volume,
                           desired_image_digest=desired_digest)
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
                if os.environ.get('GXZS_GLOBAL_SKILL_DIR'):
                    env['GXZS_GLOBAL_SKILL_DIR'] = os.environ['GXZS_GLOBAL_SKILL_DIR']
                if any('\n' in str(value) or '\r' in str(value) for value in env.values()):
                    raise ValueError('Invalid runtime configuration')
                env_file = folder / 'host.env'
                env_file.write_text(''.join(f'{key}={value}\n' for key, value in env.items()))
                os.chmod(env_file, 0o600)
                self.docker('volume', 'create', '--label', 'gxzs.owner=' + owner, home_volume)
                self._create_container(current, folder, image, network, publish, host_state)
            self.docker('start', instance)
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
        self.docker('create', '--name', item['instance_id'], '--label', 'gxzs.owner=' + item['owner_id'],
                    '--label', 'gxzs.workspace=' + item['workspace_id'],
                    '--label', 'gxzs.generation=' + str(item['generation']), '--label', 'gxzs.credentials=owner-v1',
                    '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
                    '--network', network, '--restart', 'no', *cgroup_args(item['workspace_id']),
                    '--cpus', os.environ.get('GXZS_HOST_CPUS', '1'),
                    '--memory', memory, '--memory-swap', memory, '--pids-limit', '256', *publish,
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--env-file', str(env_file),
                    *font_mount, '-v', item['home_volume'] + ':/srv/dsh',
                    '-v', sandbox + '-files:/workspace:ro',
                    '-v', str(host_state / 'hosts' / item['workspace_id']) + ':/run/gxzs:ro',
                    '-v', str(host_state / 'hosts' / item['workspace_id'] / 'ssh') + ':/home/node/.ssh:ro', image)

    def _container_identity(self, item, advertise):
        info = json.loads(self.docker('inspect', item['instance_id']).stdout)[0]
        ports = (info.get('NetworkSettings', {}).get('Ports') or {}).get('3081/tcp')
        if not ports or not isinstance(ports[0], dict) or not str(ports[0].get('HostPort', '')).isdecimal():
            state = info.get('State', {})
            logging.getLogger(__name__).warning('Host endpoint unavailable instance=%s running=%s exit_code=%s oom=%s',
                                              item['instance_id'], state.get('Running'), state.get('ExitCode'), state.get('OOMKilled'))
            raise ResourceUnavailable('个人 Host 尚未启动就绪，请稍后重试；数据已保留', 'HOST_START_PENDING', 3)
        endpoint = 'http://' + advertise + ':' + str(ports[0]['HostPort'])
        return {'endpoint': endpoint, 'image_digest': info['Image']}

    def replace(self, workspace, payload):
        """Root-only, resumable drain/fence/replace; never stop an active run."""
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
            expected = (int(payload['expected_generation']), payload['expected_instance_id'])
            desired = (int(payload['generation']), payload['instance_id'])
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
            transition = dict(previous_generation=expected[0], previous_instance_id=expected[1],
                              generation=desired[0], instance_id=desired[1])
            current.update(state='draining', ready=False, replacement=transition)
            self._save(record, current)
            if self.admission.busy(current['owner_id']):
                return current
            current['state'] = 'fencing'
            self._save(record, current)
            from mcp_runtime import invalidate
            invalidate(workspace)
            from global_memory import invalidate as cancel_memory
            cancel_memory(workspace)
            sandbox, _ = self.identity(workspace)
            for container in (expected[1], sandbox):
                inspect = self.docker('inspect', container, check=False)
                if not inspect.returncode:
                    self.docker('stop', '--time', '10', container)
            # Capacity is freed only after both stop operations succeeded.
            self._fence(workspace, current['owner_id'], expected[1])
            current.update(generation=desired[0], instance_id=desired[1], state='provisioning', ready=False,
                           home_volume=current.get('home_volume') or expected[1] + '-home')
            current.pop('endpoint', None)
            self._save(record, current)
            return self.ensure(workspace, payload)

    def _fence(self, workspace, owner, instance):
        from global_memory import fence_workspace
        fence_workspace(workspace)
        from mcp_runtime import fence_workspace as fence_mcp
        fence_mcp(workspace)
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
        script = "from pathlib import Path; import os,sys; p=Path('/home/dify/.ssh'); p.mkdir(mode=0o700,exist_ok=True); f=p/'authorized_keys'; key=sys.stdin.read().strip(); old=f.read_text() if f.exists() else ''; f.write_text(old if key in old.splitlines() else old.rstrip()+'\\n'+key+'\\n'); os.chmod(f,0o600)"
        self.docker('exec', '--user', '1000', '-i', sandbox, '/usr/local/bin/python', '-I', '-S', '-c', script, stdin=public)
        host_key = self.docker('exec', '--user', '1000', sandbox, 'cat', '/home/dify/.ssh/ssh_host_ed25519_key.pub').stdout.split()
        if len(host_key) < 2 or host_key[0] != 'ssh-ed25519':
            raise ValueError('Sandbox SSH host key is missing or invalid')
        port = int(os.environ.get('GXZS_SANDBOX_SSH_PORT', '2222'))
        if not 1 <= port <= 65535:
            raise ValueError('Invalid sandbox SSH port')
        (ssh / 'known_hosts').write_text(f'[{sandbox}]:{port} ' + ' '.join(host_key[:2]) + '\n')
        (ssh / 'config').write_text(f'Host {sandbox}\n  HostName {sandbox}\n  Port {port}\n  User dify\n  IdentityFile /home/node/.ssh/id_ed25519\n  UserKnownHostsFile /home/node/.ssh/known_hosts\n  StrictHostKeyChecking yes\n  BatchMode yes\n')
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
        """Return true only for a live host blocked by an external catalog.

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
        return (payload.get('live') is True and payload.get('recovery') == 'ready'
                and payload.get('resources') == 'unavailable')

    def maintain(self):
        # A slow or broken host must not expire every other owner's heartbeat.
        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(self._maintain_one, self.root.glob('*/host.json')))

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
            if item.get('state') in {'draining', 'fencing', 'stopped'} and payload['action'] == 'acquire' and not draining_ticket:
                raise ValueError('Host is draining; new task admission is paused')
            if payload['action'] != 'release':
                if info is None:
                    info = json.loads(self.docker('inspect', item['instance_id']).stdout)[0]
                if not info['State']['Running']:
                    raise ValueError('Scheduling host is stopped')
            if managed and payload['action'] == 'acquire' and item.get('ready') is not True and not draining_ticket:
                raise ValueError('Host is not ready; new task admission is paused')
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
                observed = dict(item)
            # Both Docker inspection and health checks can be slow. In
            # particular, plugin readiness may call back into this workspace.
            host_result = self.docker('inspect', item['instance_id'], check=False)
            info = json.loads(host_result.stdout)[0] if not host_result.returncode else None
            sandbox, _ = self.identity(item['workspace_id'])
            sandbox_result = self.docker('inspect', sandbox, check=False)
            sandbox_info = json.loads(sandbox_result.stdout)[0] if not sandbox_result.returncode else None
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
                    if host_running:
                        self.docker('stop', '--time', '10', current['instance_id'])
                    if sandbox_running:
                        self.docker('stop', '--time', '10', sandbox)
                    if host_running or sandbox_running:
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
            with self.lock(record.parent.name):
                item = json.loads(record.read_text())
                if item != observed:
                    return
                activity = self.root.parent / item['workspace_id']
                idle = (item.get('state') != 'draining' and activity.exists()
                        and time.time() - activity.stat().st_mtime > 1800
                        and not self.admission.busy(item['owner_id']))
                if host_running and idle:
                    self.docker('stop', '--time', '10', item['instance_id'])
                    self.docker('stop', '--time', '10', sandbox, check=False)
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
                if dependency_degraded or process_pressure:
                    self.failures.pop(item['instance_id'], None)
                    self.recoveries.pop(item['instance_id'], None)
                    if item.get('ready') is not False:
                        item['ready'] = False
                        self._save(record, item)
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
                # A missing Docker object is definitive, unlike a transient
                # readiness probe. Recover it quickly while retaining a short
                # debounce for daemon/eventual-consistency races.
                grace = (5 if info is None or sandbox_info is None else
                         (180 if item.get('state') == 'provisioning' else 60))
                recovery = self.recoveries.get(item['instance_id'], {})
                if now - since <= grace or now < recovery.get('next_retry_at', 0):
                    return
                attempts = int(recovery.get('attempts', 0)) + 1
                reason = ('host_missing' if info is None else
                          ('sandbox_' + str(sandbox_health or ('stopped' if not sandbox_running else 'unknown'))
                           if not sandbox_healthy else ('host_unready' if alive else 'host_unreachable')))
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
                self.docker('stop', '--time', '10', item['instance_id'], check=False)
                self.docker('stop', '--time', '10', sandbox, check=False)
                self._fence(item['workspace_id'], item['owner_id'], item['instance_id'])
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
                    self.docker('rename', item['instance_id'],
                                item['instance_id'] + '-previous-' + info['Id'][:12])
                network, advertise, publish, host_state = self._runtime_config(item['workspace_id'])
                self._create_container(item, record.parent, image, network, publish, host_state)
                self.docker('start', item['instance_id'])
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
