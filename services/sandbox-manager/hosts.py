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
            if record.exists():
                current = json.loads(record.read_text())
                if (current['owner_id'], current['generation'], current['instance_id']) != (owner, generation, instance):
                    raise ValueError('Host identity changed; fence the previous generation before replacement')
            image = os.environ['GXZS_HOST_IMAGE']
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
                if existing['Config']['Image'] != image:
                    raise ValueError('Host image rollout requires draining before replacement')
                if not existing['State']['Running']:
                    # Restart only after fencing any surviving tool processes.
                    self.docker('stop', '--time', '10', sandbox)
                    self.admission.fence(owner, instance)
            # Persist ownership before provisioning, including failed starts.
            current = dict(owner_id=owner, workspace_id=workspace, generation=generation,
                           instance_id=instance, ready=False)
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
                    'GXZS_ASSERTION_ISSUER': payload['assertion_issuer'], 'GXZS_ASSERTION_SIGNING_KEY': payload['assertion_key'],
                    'GXZS_ASSERTION_AUDIENCE_PATH': '/ai/workbench', 'GXZS_PLATFORM_INTERNAL_TOKEN': payload['platform_token'],
                    'GXZS_PLATFORM_INTERNAL_URL': os.environ['GXZS_HOST_PLATFORM_URL'],
                    'GXZS_SANDBOX_MANAGER_URL': os.environ['GXZS_HOST_MANAGER_URL'],
                    'GXZS_SANDBOX_MANAGER_TOKEN': os.environ['WORKBENCH_SANDBOX_MANAGER_TOKEN'],
                    'GXZS_SANDBOX_WORKSPACE_ID': workspace, 'GXZS_SANDBOX_WORKSPACE': '/workspace',
                    'GXZS_SANDBOX_SSH_HOST': sandbox, 'GXZS_SANDBOX_HELPER_HASH': os.environ['GXZS_SANDBOX_HELPER_HASH'],
                }
                if any('\n' in str(value) or '\r' in str(value) for value in env.values()):
                    raise ValueError('Invalid runtime configuration')
                env_file = folder / 'host.env'
                env_file.write_text(''.join(f'{key}={value}\n' for key, value in env.items()))
                os.chmod(env_file, 0o600)
                self.docker('volume', 'create', '--label', 'gxzs.owner=' + owner, instance + '-home')
                self.docker('create', '--name', instance, '--label', 'gxzs.owner=' + owner,
                            '--label', 'gxzs.workspace=' + workspace, '--label', 'gxzs.generation=' + str(generation),
                            '--network', network, '--restart', 'no', '--cpus', '2', '--memory', '2g', '--pids-limit', '256',
                            *publish,
                            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--env-file', str(env_file),
                            '-v', instance + '-home:/srv/dsh',
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
            deadline = time.monotonic() + 50
            while time.monotonic() < deadline:
                if self.healthy(endpoint):
                    digest = json.loads(self.docker('inspect', instance).stdout)[0]['Image']
                    result = dict(owner_id=owner, workspace_id=workspace, generation=generation, instance_id=instance,
                                  endpoint=endpoint, image_digest=digest, ready=True)
                    temporary = record.with_suffix('.tmp')
                    temporary.write_text(json.dumps(result))
                    temporary.replace(record)
                    return result
                time.sleep(1)
            return {'ready': False}

    def _ssh(self, folder, sandbox):
        ssh = folder / 'ssh'
        ssh.mkdir(mode=0o700, exist_ok=True)
        key = ssh / 'id_ed25519'
        if not key.exists():
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True, capture_output=True)
        public = key.with_suffix('.pub').read_text().strip()
        script = "from pathlib import Path; import os,sys; p=Path('/home/dify/.ssh'); p.mkdir(mode=0o700,exist_ok=True); f=p/'authorized_keys'; key=sys.stdin.read().strip(); old=f.read_text() if f.exists() else ''; f.write_text(old if key in old.splitlines() else old.rstrip()+'\\n'+key+'\\n'); os.chmod(f,0o600); os.chown(p,1000,1000); os.chown(f,1000,1000)"
        self.docker('exec', '--user', '0', '-i', sandbox, '/usr/local/bin/python', '-I', '-S', '-c', script, stdin=public)
        host_key = self.docker('exec', '--user', '0', sandbox, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub').stdout.split()
        (ssh / 'known_hosts').write_text(sandbox + ' ' + ' '.join(host_key[:2]) + '\n')
        (ssh / 'config').write_text(f'Host {sandbox}\n  HostName {sandbox}\n  User dify\n  IdentityFile /home/node/.ssh/id_ed25519\n  UserKnownHostsFile /home/node/.ssh/known_hosts\n  StrictHostKeyChecking yes\n  BatchMode yes\n')
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
            item = json.loads((self.root / workspace / 'host.json').read_text())
            if (item['owner_id'], item['generation'], item['instance_id']) != (payload['owner_id'], int(payload['generation']), payload['instance_id']):
                raise ValueError('Scheduling host identity mismatch')
            if payload['action'] != 'release':
                info = json.loads(self.docker('inspect', item['instance_id']).stdout)[0]
                if not info['State']['Running']:
                    raise ValueError('Scheduling host is stopped')
            (self.root.parent / workspace).touch()
            return self.admission.request(payload['owner_id'], int(payload['generation']), payload['instance_id'],
                                          payload['run_id'], payload['chat_id'], payload['action'])

    def _maintain_one(self, record):
        try:
            with self.lock(record.parent.name):
                item = json.loads(record.read_text())
                info = json.loads(self.docker('inspect', item['instance_id']).stdout)[0]
                activity = self.root.parent / item['workspace_id']
                idle = activity.exists() and time.time() - activity.stat().st_mtime > 1800 and not self.admission.active(item['owner_id'])
                if info['State']['Running'] and idle:
                    self.docker('stop', '--time', '10', item['instance_id'])
                    info['State']['Running'] = False
                if info['State']['Running'] and item.get('endpoint') and self.healthy(item['endpoint']):
                    self.failures.pop(item['instance_id'], None)
                    self.heartbeat(item, 'ready')
                elif not info['State']['Running']:
                    # Fence tools before returning capacity to other users.
                    sandbox, _ = self.identity(item['workspace_id'])
                    self.docker('stop', '--time', '10', sandbox)
                    self.admission.fence(item['owner_id'], item['instance_id'])
                    self.heartbeat(item, 'stopped')
                else:
                    since = self.failures.setdefault(item['instance_id'], time.time())
                    if time.time() - since > 60:
                        self.docker('stop', '--time', '10', item['instance_id'])
                        sandbox, _ = self.identity(item['workspace_id'])
                        self.docker('stop', '--time', '10', sandbox)
                        self.admission.fence(item['owner_id'], item['instance_id'])
                        self.heartbeat(item, 'stopped')
        except Exception:
            # Keep capacity reserved on uncertain fencing; never log secrets.
            logging.getLogger(__name__).warning('Host maintenance failed for workspace %s', record.parent.name)
