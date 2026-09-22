"""Owner-scoped host lifecycle. Runtime templates are administrator-controlled."""
import json
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
    def __init__(self, state, docker, ensure_sandbox, identity, lock, admission):
        self.root = Path(state) / 'hosts'
        self.root.mkdir(exist_ok=True)
        self.docker, self.ensure_sandbox, self.identity = docker, ensure_sandbox, identity
        self.lock, self.admission = lock, admission
        self.opener = build_opener(ProxyHandler({}))
        self.failures = {}

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
            image = os.environ['GXZS_HOST_IMAGE']
            image_info = json.loads(self.docker('image', 'inspect', image).stdout)[0]
            desired_digest = image_info['Id']
            if payload.get('image_digest') and payload['image_digest'] != desired_digest:
                raise ValueError('Desired host image does not match the installed digest')
            network = os.environ['GXZS_HOST_NETWORK']
            advertise = os.environ.get('GXZS_HOST_ADVERTISE_IP')
            publish = []
            if advertise:
                ipaddress.IPv4Address(advertise)
                bind = os.environ['GXZS_HOST_BIND_IP']
                if not ipaddress.IPv4Address(bind).is_private or bind == '0.0.0.0':
                    raise ValueError('Host listener must bind a private interface')
                publish = ['-p', bind + '::3081']
            host_state = PurePosixPath(os.environ['WORKBENCH_MANAGER_HOST_STATE'])
            if not host_state.is_absolute():
                raise ValueError('Manager host state mount must be absolute')
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
                }
                if any('\n' in str(value) or '\r' in str(value) for value in env.values()):
                    raise ValueError('Invalid runtime configuration')
                env_file = folder / 'host.env'
                env_file.write_text(''.join(f'{key}={value}\n' for key, value in env.items()))
                os.chmod(env_file, 0o600)
                self.docker('volume', 'create', '--label', 'gxzs.owner=' + owner, home_volume)
                self.docker('create', '--name', instance, '--label', 'gxzs.owner=' + owner,
                            '--label', 'gxzs.workspace=' + workspace, '--label', 'gxzs.generation=' + str(generation),
                            '--label', 'gxzs.credentials=owner-v1',
                            '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
                            '--network', network, '--restart', 'no', '--cpus', '2', '--memory', '2g', '--pids-limit', '256',
                            *publish,
                            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--env-file', str(env_file),
                            '-v', home_volume + ':/srv/dsh',
                            '-v', str(host_state / 'hosts' / workspace) + ':/run/gxzs:ro',
                            '-v', str(host_state / 'hosts' / workspace / 'ssh') + ':/home/node/.ssh:ro', image)
            self.docker('start', instance)
            endpoint = 'http://' + instance + ':3081'
            if advertise:
                ports = json.loads(self.docker('inspect', instance).stdout)[0]['NetworkSettings']['Ports']['3081/tcp']
                endpoint = 'http://' + advertise + ':' + str(ports[0]['HostPort'])
            current.update(endpoint=endpoint, image_digest=json.loads(self.docker('inspect', instance).stdout)[0]['Image'])
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
            if self.admission.active(current['owner_id']):
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
            if record.exists():
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
            if item.get('state') in {'draining', 'fencing', 'stopped'} and payload['action'] == 'acquire':
                raise ValueError('Host is draining; new task admission is paused')
            if payload['action'] != 'release':
                if info is None:
                    info = json.loads(self.docker('inspect', item['instance_id']).stdout)[0]
                if not info['State']['Running']:
                    raise ValueError('Scheduling host is stopped')
            (self.root.parent / workspace).touch()
            return self.admission.request(payload['owner_id'], int(payload['generation']), payload['instance_id'],
                                          payload.get('ticket_id') or payload['run_id'], payload['chat_id'], payload['action'], bool(payload.get('retry')))

    def _maintain_one(self, record):
        try:
            with self.lock(record.parent.name):
                item = json.loads(record.read_text())
                if item.get('state') == 'fencing':
                    return
                observed = dict(item)
            # Both Docker inspection and health checks can be slow. In
            # particular, plugin readiness may call back into this workspace.
            info = json.loads(self.docker('inspect', item['instance_id']).stdout)[0]
            healthy = info['State']['Running'] and item.get('endpoint') and self.healthy(item['endpoint'])
            with self.lock(record.parent.name):
                item = json.loads(record.read_text())
                if item != observed:
                    return
                if item.get('state') == 'draining' and info['State']['Running'] and healthy:
                    self.failures.pop(item['instance_id'], None)
                    self.heartbeat(item, 'draining')
                    return
                activity = self.root.parent / item['workspace_id']
                idle = item.get('state') != 'draining' and activity.exists() and time.time() - activity.stat().st_mtime > 1800 and not self.admission.active(item['owner_id'])
                if info['State']['Running'] and idle:
                    self.docker('stop', '--time', '10', item['instance_id'])
                    info['State']['Running'] = False
                if info['State']['Running'] and healthy:
                    self.failures.pop(item['instance_id'], None)
                    item.update(state='ready', ready=True)
                    self._save(record, item)
                    self.heartbeat(item, 'ready')
                elif not info['State']['Running']:
                    # Fence tools before returning capacity to other users.
                    sandbox, _ = self.identity(item['workspace_id'])
                    self.docker('stop', '--time', '10', sandbox)
                    self._fence(item['workspace_id'], item['owner_id'], item['instance_id'])
                    item.update(state='stopped', ready=False)
                    self._save(record, item)
                    self.heartbeat(item, 'stopped')
                else:
                    since = self.failures.setdefault(item['instance_id'], time.time())
                    if time.time() - since > 60:
                        self.docker('stop', '--time', '10', item['instance_id'])
                        sandbox, _ = self.identity(item['workspace_id'])
                        self.docker('stop', '--time', '10', sandbox)
                        self._fence(item['workspace_id'], item['owner_id'], item['instance_id'])
                        item.update(state='stopped', ready=False)
                        self._save(record, item)
                        self.heartbeat(item, 'stopped')
        except Exception:
            # Keep capacity reserved on uncertain fencing; never log secrets.
            logging.getLogger(__name__).warning('Host maintenance failed for workspace %s', record.parent.name)
