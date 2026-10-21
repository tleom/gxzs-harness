"""Disposable manager + real Docker file lifecycle; no production credentials."""
import concurrent.futures
import hashlib
import ipaddress
import importlib.util
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

if len(sys.argv) != 4:
    raise SystemExit('Usage: smoke-manager-lifecycle.py MANAGER_IMAGE SANDBOX_IMAGE HOST_IMAGE')
manager_image, sandbox_image, host_image = sys.argv[1:]

prefix = 'gxzs-verify-' + uuid.uuid4().hex[:10]
manager = prefix + '-manager'
host_probe = prefix + '-host'
host_home = prefix + '-host-home'
token = secrets.token_hex(32)
workspaces = [str(uuid.uuid4()), str(uuid.uuid4())]
resource_args = []
skill_manifest = None
if os.environ.get('GXZS_GLOBAL_RESOURCES_DIR'):
    spec = importlib.util.spec_from_file_location('production_resources', Path(__file__).with_name('verify-production-resources.py'))
    resources = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(resources)
    skill_root, skill_manifest = resources.verify_skill_source(os.environ['GXZS_GLOBAL_RESOURCES_DIR'])
    resource_args = ['-e', 'GXZS_GLOBAL_SKILL_HOST_DIR=' + str(skill_root)]


def interrupted(signum, frame):
    raise InterruptedError('Disposable manager smoke interrupted')


signal.signal(signal.SIGTERM, interrupted)


def docker(*args, stdin=None, check=True):
    return subprocess.run(['docker', *args], input=stdin, text=True,
                          capture_output=True, check=check, timeout=150)


REQUEST = '''
import json, os, sys, urllib.request, urllib.error
value=json.load(sys.stdin)
data=json.dumps(value['body']).encode() if 'body' in value else None
request=urllib.request.Request('http://127.0.0.1:5010'+value['path'], data=data,
 headers={'Authorization':'Bearer '+os.environ['WORKBENCH_SANDBOX_MANAGER_TOKEN'], 'Content-Type':'application/json'})
try:
 response=urllib.request.urlopen(request, timeout=100)
except urllib.error.HTTPError as error:
 response=error
print(json.dumps({'status':response.status,'body':json.load(response)}))
'''


def request(path, body=None):
    value = {'path': path}
    if body is not None:
        value['body'] = body
    return json.loads(docker('exec', '-i', manager, 'python', '-c', REQUEST,
                             stdin=json.dumps(value)).stdout)


def healthy():
    last = None
    for _ in range(40):
        try:
            last = request('/healthz')
            if last['status'] == 200:
                return
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            pass
        time.sleep(.5)
    raise AssertionError(('manager did not become healthy', last))


def files(workspace, operation, **values):
    result = request('/sandboxes/' + workspace + '/files', {'operation': operation, **values})
    if result['status'] != 200:
        logs = docker('logs', manager, check=False)
        print((logs.stdout + logs.stderr).replace(token, '[fixture-redacted]')[-6000:], file=sys.stderr)
    assert result['status'] == 200, result
    return result['body']


def verify_managed_skills(container, image):
    if skill_manifest is None:
        return
    mounts = json.loads(docker('inspect', container).stdout)[0]['Mounts']
    mount = next(item for item in mounts if item['Destination'] == '/opt/workbench-global/skills')
    assert mount['Type'] == 'bind' and mount['Source'] == str(skill_root) and mount['RW'] is False
    script = """
const fs=require('fs'),p=require('path'),c=require('crypto');
const root='/opt/workbench-global/skills',files={};
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
 const f=p.join(dir,e.name);
 if(e.isSymbolicLink())throw Error('Skill symlink');
 if(e.isDirectory())visit(f);
 else if(e.isFile())files[p.relative(root,f)]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}}
visit(root);console.log(JSON.stringify(files));
"""
    result = docker('run', '--rm', '--network', 'none', '--volumes-from', container + ':ro',
                    '--entrypoint', 'node', image, '-e', script)
    assert json.loads(result.stdout) == skill_manifest['files']


try:
    docker('run', '-d', '--name', manager, '--network', 'none', '--memory', '1g', '--cpus', '2',
           '-v', '/var/run/docker.sock:/var/run/docker.sock',
           '-e', 'WORKBENCH_SANDBOX_MANAGER_TOKEN=' + token,
           '-e', 'WORKBENCH_SANDBOX_PREFIX=' + prefix,
           '-e', 'WORKBENCH_SANDBOX_NETWORK=' + prefix,
           '-e', 'WORKBENCH_SANDBOX_ADDRESS_POOL=' + os.environ.get('GXZS_SMOKE_ADDRESS_POOL', '10.249.253.0/24'),
           '-e', 'WORKBENCH_SANDBOX_SUBNET_PREFIX=27',
           '-e', 'WORKBENCH_SANDBOX_IMAGE=' + sandbox_image, *resource_args, manager_image)
    healthy()
    # Optional explicit test ranges avoid consuming the daemon's production pool.
    if os.environ.get('GXZS_SMOKE_SUBNETS'):
        subnets = [ipaddress.ip_network(value) for value in os.environ['GXZS_SMOKE_SUBNETS'].split(',')]
        assert len(subnets) == len(workspaces) and all(value.version == 4 for value in subnets)
        assert not subnets[0].overlaps(subnets[1])
        networks = docker('network', 'ls', '-q').stdout.split()
        used = [ipaddress.ip_network(config['Subnet'])
                for network in json.loads(docker('network', 'inspect', *networks).stdout)
                for config in (network.get('IPAM', {}).get('Config') or []) if config.get('Subnet')]
        assert not any(subnet.version == existing.version and subnet.overlaps(existing) for subnet in subnets for existing in used)
        for workspace, subnet in zip(workspaces, subnets):
            docker('network', 'create', '--driver', 'bridge', '--subnet', str(subnet),
                   '--label', 'workbench=' + prefix, '--label', 'gxzs.workspace=' + workspace,
                   prefix + '-' + hashlib.sha256(workspace.encode()).hexdigest()[:16])

    def populate(index):
        workspace = workspaces[index]
        files(workspace, 'mkdir', path='probe')
        data = ['AP8BAg==', 'aXNvbGF0ZWQ='][index]
        created = files(workspace, 'upload', path='probe/data.bin', version=None, data=data)
        actual = files(workspace, 'get', path='probe/data.bin')
        assert actual['data'] == data, actual
        stale = request('/sandboxes/' + workspace + '/files',
                        {'operation':'upload','path':'probe/data.bin','version':'stale','data':'AA=='})
        assert stale['status'] == 409 and stale['body']['conflict'], stale
        assert files(workspace, 'get', path='probe/data.bin')['data'] == data
        return created['version'], data

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(populate, range(2)))
    print('PASS real manager: parallel owner provisioning, binary roundtrip, stale-version conflict', flush=True)
    # Exercise Node's actual streaming manager client, not a JSON/base64 test double.
    def streaming_probe(phase):
        script = str(Path(__file__).with_name('smoke-streaming-files.mjs').resolve())
        output = docker('run', '--rm', '--network', 'container:' + manager, '--memory', '512m', '--cpus', '1',
                        '--entrypoint', 'node', '-v', script + ':/smoke-streaming-files.mjs:ro',
                        '-e', 'TEST_MANAGER_TOKEN=' + token, '-e', 'GXZS_HOST_OWNER_ID=fixture:1',
                        '-e', 'GXZS_HOST_GENERATION=1', '-e', 'GXZS_HOST_INSTANCE_ID=streaming-fixture',
                        host_image, '/smoke-streaming-files.mjs', workspaces[0], phase, check=False)
        if output.returncode:
            print((output.stdout + output.stderr).replace(token, '[fixture-redacted]')[-6000:], file=sys.stderr)
            raise RuntimeError('Streaming file smoke failed: ' + phase)
        print(output.stdout.strip(), flush=True)
    streaming_probe('file')
    prepare_directory = """
from pathlib import Path
import os
root=Path('/workspace/probe/stream-dir'); root.mkdir()
for index in range(10): os.link('/workspace/probe/large.bin',root/str(index))
with (root/'tail').open('wb') as stream: stream.truncate(24*1024*1024)
for index in range(10005): (root/('empty-'+str(index))).touch()
"""
    sandbox = prefix + '-' + workspaces[0]
    docker('exec', '--user', '1000', sandbox, '/usr/local/bin/python', '-I', '-S', '-c', prepare_directory)
    streaming_probe('directory')
    docker('exec', '--user', '1000', sandbox, '/usr/local/bin/python', '-I', '-S', '-c',
           "from pathlib import Path;Path('/workspace/probe/stream-dir/extra').write_bytes(b'x')")
    streaming_probe('oversize-directory')
    metadata_limit = request('/sandboxes/' + workspaces[0] + '/files',
                             {'operation': 'stat', 'path': 'probe/stream-dir'})
    assert metadata_limit['status'] == 400 and metadata_limit['body']['error'] == 'Folder contains too many entries', metadata_limit
    # Streaming download has no entry-count cap; ordinary metadata deliberately
    # retains its existing budget. Restore this synthetic fixture to that budget
    # before exercising the unrelated versioned-delete lifecycle below.
    docker('exec', '--user', '1000', sandbox, '/usr/local/bin/python', '-I', '-S', '-c', """
from pathlib import Path
import stat
root=Path('/workspace/probe/stream-dir')
assert root.resolve() == root and root.is_dir()
for index in range(10005):
    child=root/('empty-'+str(index))
    info=child.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_size == 0
    child.unlink()
assert len(list(root.iterdir())) == 12
""")
    print('PASS directory metadata: oversized entry count rejected; bounded fixture restored for versioned deletion', flush=True)
    folder = files(workspaces[0], 'stat', path='probe/stream-dir')
    files(workspaces[0], 'delete', path='probe/stream-dir', version=folder['version'])
    large = files(workspaces[0], 'stat', path='probe/large.bin')
    files(workspaces[0], 'delete', path='probe/large.bin', version=large['version'])
    sandbox = prefix + '-' + workspaces[0]
    before = json.loads(docker('inspect', sandbox).stdout)[0]
    assert before['HostConfig']['PidsLimit'] == 1024
    docker('update', '--pids-limit', '256', sandbox)
    assert files(workspaces[0], 'get', path='probe/data.bin')['data'] == results[0][1]
    after = json.loads(docker('inspect', sandbox).stdout)[0]
    assert after['HostConfig']['PidsLimit'] == 1024 and after['State']['StartedAt'] == before['State']['StartedAt']
    print('PASS thread limit: running legacy sandbox updated from 256 to 1024 without restart', flush=True)
    # Provision a fresh managed home through the actual initializer, before the
    # Host image can seed its ownership. The fixture uses the existing test
    # network and a separate process-local manager state.
    fresh_sandbox = prefix + '-fresh-home'
    provision_home = '''
import json, sys
from pathlib import Path
import server
value=json.load(sys.stdin)
server.STATE=Path('/tmp/fresh-owner-home-probe')
server.STATE.mkdir(exist_ok=True)
server.HOSTS.root=server.STATE/'hosts'
folder=server.HOSTS.root/value['workspace']
folder.mkdir(parents=True,exist_ok=True)
(folder/'host.json').write_text(json.dumps({'workspace_id':value['workspace'], 'owner_id':'probe:1', 'home_volume':value['home']}))
server.identity=lambda _: (value['sandbox'], 'fixture-only-token')
server.ensure_network=lambda _: value['network']
server.ensure(value['workspace'])
'''
    network = next(iter(before['NetworkSettings']['Networks']))
    docker('exec', '-i', manager, 'python', '-c', provision_home, stdin=json.dumps({
        'workspace': workspaces[0], 'home': host_home, 'sandbox': fresh_sandbox, 'network': network}))
    docker('run', '--rm', '--network', 'none', '--user', '1000', '--entrypoint', 'node',
           '-v', host_home + ':/srv/dsh', host_image, '-e',
           "const fs=require('node:fs');if(fs.statSync('/srv/dsh').uid!==1000)throw Error('Host home is not owned by node');"
           "fs.mkdirSync('/srv/dsh/profiles/workbench',{recursive:true});fs.writeFileSync('/srv/dsh/profiles/workbench/probe','owner');"
           "fs.writeFileSync('/srv/dsh/attachments/probe','attachment')")
    docker('rm', '-f', fresh_sandbox)
    print('PASS fresh managed home: non-root Host can create profile and attachment files', flush=True)
    with tempfile.TemporaryDirectory(prefix=prefix) as host_state:
        (Path(host_state) / 'hosts' / workspaces[0] / 'ssh').mkdir(parents=True)
        create_host = '''
import json, sys
from pathlib import Path, PurePosixPath
sys.path.insert(0, '/app')
from server import HOSTS
value = json.load(sys.stdin)
folder = Path('/tmp/host-workspace-probe')
folder.mkdir(exist_ok=True)
(folder / 'host.env').write_text('')
HOSTS._create_container(value['item'], folder, value['image'], 'none', [], PurePosixPath(value['state']))
'''
        docker('exec', '-i', manager, 'python', '-c', create_host, stdin=json.dumps({
            'item': {'instance_id': host_probe, 'owner_id': 'probe:1', 'workspace_id': workspaces[0],
                     'generation': 1, 'home_volume': host_home}, 'image': host_image, 'state': host_state}))
        sandbox_mounts = json.loads(docker('inspect', prefix + '-' + workspaces[0]).stdout)[0]['Mounts']
        host_mounts = json.loads(docker('inspect', host_probe).stdout)[0]['Mounts']
        sandbox_files = next(item for item in sandbox_mounts if item['Destination'] == '/workspace')
        host_files = next(item for item in host_mounts if item['Destination'] == '/workspace')
        assert sandbox_files['Source'] == host_files['Source'] and host_files['RW'] is False
        verify_managed_skills(prefix + '-' + workspaces[0], sandbox_image)
        verify_managed_skills(host_probe, host_image)
        if skill_manifest is not None:
            print('PASS manager-created Host and Sandbox: complete global skills mounted read-only', flush=True)
        docker('run', '--rm', '--network', 'none', '--volumes-from', host_probe + ':ro', '--entrypoint', 'node', host_image,
               '-e', "const fs=require('node:fs');if(fs.readFileSync('/workspace/probe/data.bin').toString('base64')!=='AP8BAg==')process.exit(1)")
        docker('rm', '-f', host_probe)
        docker('volume', 'rm', host_home)
    print('PASS managed Host creation: actual sandbox file volume mounted read-only and owner bytes readable', flush=True)
    networks = []
    for workspace in workspaces:
        info = json.loads(docker('inspect', prefix + '-' + workspace).stdout)[0]
        networks.append(set(info['NetworkSettings']['Networks']))
    assert all(len(value) == 1 for value in networks) and networks[0].isdisjoint(networks[1])
    network_before = {name: json.loads(docker('network', 'inspect', name).stdout)[0]
                      for names in networks for name in names}
    if not os.environ.get('GXZS_SMOKE_SUBNETS'):
        address_pool = ipaddress.ip_network(os.environ.get('GXZS_SMOKE_ADDRESS_POOL', '10.249.253.0/24'))
        for info in network_before.values():
            subnet = ipaddress.ip_network(info['IPAM']['Config'][0]['Subnet'])
            assert subnet.prefixlen == 27 and subnet.subnet_of(address_pool), info['IPAM']
        print('PASS dedicated pool: distinct /27 bridges created through the real manager', flush=True)
    # A running process in B must outlive manager restart and A's restart.
    docker('exec', '-d', prefix + '-' + workspaces[1], '/usr/local/bin/python', '-I', '-S', '-c',
           "import pathlib,time; p=pathlib.Path('/workspace/probe'); "
           "(p/'started').write_text('started'); time.sleep(20); (p/'finished').write_text('finished')")
    for _ in range(20):
        if files(workspaces[1], 'stat', path='probe/started')['kind'] == 'file':
            break
        time.sleep(.1)
    else:
        raise AssertionError('Concurrent sandbox process did not start')
    docker('restart', manager)
    healthy()
    for workspace, (_, data) in zip(workspaces, results):
        assert files(workspace, 'get', path='probe/data.bin')['data'] == data
    for name, previous in network_before.items():
        current = json.loads(docker('network', 'inspect', name).stdout)[0]
        assert current['Id'] == previous['Id'] and current['IPAM'] == previous['IPAM']
    print('PASS manager restart: both owner files preserved', flush=True)
    docker('restart', prefix + '-' + workspaces[0])
    assert files(workspaces[0], 'get', path='probe/data.bin')['data'] == results[0][1]
    assert files(workspaces[1], 'get', path='probe/data.bin')['data'] == results[1][1]
    print('PASS sandbox restart: restarted owner and parallel owner files preserved', flush=True)
    deadline = time.monotonic() + 35
    while files(workspaces[1], 'stat', path='probe/finished')['kind'] != 'file':
        assert time.monotonic() < deadline, 'Parallel process did not survive restarts'
        time.sleep(.5)
    assert files(workspaces[1], 'get', path='probe/finished')['data'] == 'ZmluaXNoZWQ='
    for path in ['probe/started', 'probe/finished']:
        entry = files(workspaces[1], 'stat', path=path)
        files(workspaces[1], 'delete', path=path, version=entry['version'])
    print('PASS separate owner networks; concurrent process survives manager and peer sandbox restarts', flush=True)
    for workspace, (version, _) in zip(workspaces, results):
        files(workspace, 'delete', path='probe/data.bin', version=version)
        assert files(workspace, 'stat', path='probe/data.bin')['kind'] == 'missing'
        folder = files(workspace, 'stat', path='probe')
        files(workspace, 'delete', path='probe', version=folder['version'])
    print('PASS versioned deletion and missing-file state', flush=True)
finally:
    docker('rm', '-f', host_probe, check=False)
    docker('volume', 'rm', host_home, check=False)
    docker('rm', '-f', manager, check=False)
    # Only resources created with this random probe's exact label are eligible.
    for kind in ['container', 'network', 'volume']:
        items = docker(kind, 'ls', '-q', '--filter', 'label=workbench=' + prefix).stdout.split()
        for item in items:
            info = json.loads(docker(kind, 'inspect', item).stdout)[0]
            labels = info.get('Labels') if kind != 'container' else info['Config'].get('Labels')
            assert labels.get('workbench') == prefix
            docker(kind, 'rm', *(['-f'] if kind == 'container' else []), item)
    print('PASS disposable probe cleanup', flush=True)
