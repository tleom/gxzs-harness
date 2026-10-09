"""Disposable manager + real Docker file lifecycle; no production credentials."""
import concurrent.futures
import json
import secrets
import subprocess
import sys
import time
import uuid

if len(sys.argv) != 3:
    raise SystemExit('Usage: smoke-manager-lifecycle.py MANAGER_IMAGE SANDBOX_IMAGE')
manager_image, sandbox_image = sys.argv[1:]

prefix = 'gxzs-verify-' + uuid.uuid4().hex[:10]
manager = prefix + '-manager'
token = secrets.token_hex(32)
workspaces = [str(uuid.uuid4()), str(uuid.uuid4())]


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
    assert result['status'] == 200, result
    return result['body']


try:
    docker('run', '-d', '--name', manager, '--network', 'none', '--memory', '1g', '--cpus', '2',
           '-v', '/var/run/docker.sock:/var/run/docker.sock',
           '-e', 'WORKBENCH_SANDBOX_MANAGER_TOKEN=' + token,
           '-e', 'WORKBENCH_SANDBOX_PREFIX=' + prefix,
           '-e', 'WORKBENCH_SANDBOX_NETWORK=' + prefix,
           '-e', 'WORKBENCH_SANDBOX_IMAGE=' + sandbox_image, manager_image)
    healthy()

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
    networks = []
    for workspace in workspaces:
        info = json.loads(docker('inspect', prefix + '-' + workspace).stdout)[0]
        networks.append(set(info['NetworkSettings']['Networks']))
    assert all(len(value) == 1 for value in networks) and networks[0].isdisjoint(networks[1])
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
