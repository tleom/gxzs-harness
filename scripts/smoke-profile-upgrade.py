#!/usr/bin/env python3
"""Exercise the formal image-baseline entry point against a disposable owner volume."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

spec = importlib.util.spec_from_file_location('profile_upgrade', Path(__file__).with_name('prepare-profile-upgrade.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)

INITIALIZE = '''
const fs=require('node:fs');
const runtime=fs.readFileSync('/opt/workbench/profiles/workbench/cordis.runtime.patch.yml','utf8');
const source=fs.readFileSync('/opt/workbench/profiles/workbench/cordis.patch.yml','utf8');
if(runtime===source)throw Error('Fixture must include generated runtime presets');
fs.mkdirSync('/srv/dsh/profiles/workbench',{recursive:true});
fs.writeFileSync('/srv/dsh/profiles/workbench/package.json','{}');
fs.writeFileSync('/srv/dsh/profiles/workbench/cordis.patch.yml',runtime+'\\n- id: agent-default-model\\n  config: { model: owner-kept }\\n');
fs.writeFileSync('/srv/dsh/.credentials.yaml','fixture: retained\\n');
for(const file of ['/srv/dsh','/srv/dsh/profiles','/srv/dsh/profiles/workbench',
  '/srv/dsh/profiles/workbench/package.json','/srv/dsh/profiles/workbench/cordis.patch.yml','/srv/dsh/.credentials.yaml'])
  fs.chownSync(file,1000,1000);
'''
VERIFY = '''
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {migratePlatformPatch} from '/opt/workbench/scripts/migrate-platform-patch.mjs';
const directory='/srv/dsh/profiles/workbench';
const original=await readFile(directory+'/cordis.patch.yml','utf8');
const expected=await readFile('/opt/workbench/profiles/workbench/cordis.runtime.patch.yml','utf8');
const proof=JSON.parse(await readFile(directory+'/legacy-platform-baseline.json','utf8'));
assert.equal(await readFile(directory+'/legacy-platform-baseline.patch.yml','utf8'),expected);
assert.equal(proof.sourcePath,'/opt/workbench/profiles/workbench/cordis.runtime.patch.yml');
const result=await migratePlatformPatch(directory,{ownerId:'profile-smoke:1'});
assert.equal(result.retained,1); assert.ok(result.removed>0);
assert.equal(await readFile(directory+'/.cordis.patch.before-bundle-layout-v1.yml','utf8'),original);
assert.match(await readFile(directory+'/cordis.patch.yml','utf8'),/owner-kept/);
assert.equal(await readFile('/srv/dsh/.credentials.yaml','utf8'),'fixture: retained\\n');
console.log(JSON.stringify({removed:result.removed,retained:result.retained,baselineSha256:proof.baselineSha256}));
'''
STATE = '''
import json,pathlib,sys
item=json.load(sys.stdin)
folder=pathlib.Path('/state/hosts')/item['workspace_id']
folder.mkdir(parents=True,exist_ok=True)
(folder/'host.json').write_text(json.dumps(item))
'''
ENSURE = '''
import json,os,sys,urllib.request
payload=json.load(sys.stdin)
request=urllib.request.Request('http://127.0.0.1:5010/sandboxes/'+sys.argv[1]+'/ensure-host',
  data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+os.environ['WORKBENCH_SANDBOX_MANAGER_TOKEN'],
  'Content-Type':'application/json'},method='POST')
with urllib.request.urlopen(request,timeout=10) as response:
  result=json.load(response)
assert result['state']=='fencing' and result['ready'] is False
'''


def main(image, manager_image):
    pinned = upgrade.inspect('image', image, upgrade.docker)['Id']
    manager_pinned = upgrade.inspect('image', manager_image, upgrade.docker)['Id']
    if not upgrade.IMAGE_ID.fullmatch(pinned):
        raise ValueError('Missing immutable fixture image')
    volume = 'gxzs-profile-upgrade-smoke-' + uuid.uuid4().hex
    state = 'gxzs-profile-upgrade-state-' + uuid.uuid4().hex
    workspace = str(uuid.uuid4())
    old_host = 'gxzs-profile-upgrade-old-' + uuid.uuid4().hex
    manager = 'gxzs-profile-upgrade-manager-' + uuid.uuid4().hex
    upgrade.docker('volume', 'create', '--label', 'gxzs.owner=profile-smoke:1', volume)
    upgrade.docker('volume', 'create', state)
    mount = 'type=volume,source=' + volume + ',destination=/srv/dsh'
    state_mount = 'type=volume,source=' + state + ',destination=/state'
    try:
        upgrade.docker('run', '--rm', '--network', 'none', '--user', '0:0', '--mount', mount,
                       '--entrypoint', 'node', pinned, '-e', INITIALIZE)
        upgrade.docker('create', '--name', old_host, '--network', 'none', '--mount', mount,
                       '--label', 'gxzs.owner=profile-smoke:1', '--label', 'gxzs.workspace=' + workspace,
                       '--label', 'gxzs.generation=1', '--label', 'gxzs.credentials=owner-v1',
                       '--entrypoint', '/bin/true', pinned)
        record = {'owner_id': 'profile-smoke:1', 'workspace_id': workspace, 'generation': 1,
                  'instance_id': old_host, 'image_digest': pinned, 'desired_image_digest': pinned,
                  'home_volume': volume, 'state': 'stopped', 'ready': False}
        upgrade.docker('run', '--rm', '-i', '--network', 'none', '--mount', state_mount,
                       '--entrypoint', 'python', manager_pinned, '-I', '-S', '-c', STATE,
                       stdin=json.dumps(record).encode())
        upgrade.docker('create', '--name', manager, '--network', 'none', '--mount', state_mount,
                       '--mount', 'type=bind,source=/var/run/docker.sock,destination=/var/run/docker.sock',
                       '-e', 'WORKBENCH_SANDBOX_MANAGER_TOKEN=' + 'a' * 64,
                       '-e', 'GXZS_HOST_IMAGE=' + pinned, '--memory', '256m', '--pids-limit', '128', manager_pinned)
        upgrade.docker('start', manager)
        for attempt in range(50):
            try:
                upgrade.docker('exec', manager, '/usr/local/bin/python', '-I', '-S', '-c',
                               "import urllib.request;urllib.request.urlopen('http://127.0.0.1:5010/healthz',timeout=2).read()")
                break
            except subprocess.CalledProcessError:
                if attempt == 49:
                    raise
                time.sleep(0.2)
        arguments = {'old_image': pinned, 'candidate_image': pinned, 'owner_id': 'profile-smoke:1',
                     'home_volume': volume, 'workspace_id': workspace, 'generation': 1,
                     'instance_id': old_host, 'manager_container': manager}
        try:
            upgrade.prepare_upgrade(**arguments, user='0:0')
            raise AssertionError('Wrong UID:GID must not prepare a proof')
        except subprocess.CalledProcessError:
            pass
        upgrade.docker('run', '--rm', '--network', 'none', '--mount', mount, '--entrypoint', 'node', pinned,
                       '-e', "if(require('fs').existsSync('/srv/dsh/profiles/workbench/legacy-platform-baseline.json'))process.exit(1)")
        timed_out = {}

        def stalled_candidate(*args, stdin=None):
            if args[0] == 'create' and '--name' in args:
                timed_out['name'] = args[args.index('--name') + 1]
                args = (*args[:-1], 'setInterval(()=>{},1000)')
            if args[0] == 'start':
                process = subprocess.Popen(['docker', *args], stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    process.communicate(input=stdin, timeout=3)
                    raise AssertionError('The injected candidate must still be running')
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                    assert upgrade.inspect('container', timed_out['name'], upgrade.docker)['State']['Running'] is True
                    raise
            return upgrade.docker(*args, stdin=stdin)

        try:
            upgrade.seed_candidate(pinned, '1000:1000', volume, {}, stalled_candidate)
            raise AssertionError('Expected an actual candidate attach timeout')
        except subprocess.TimeoutExpired:
            assert subprocess.run(['docker', 'inspect', timed_out['name']], capture_output=True).returncode != 0
        first = upgrade.prepare_upgrade(**arguments)
        assert upgrade.prepare_upgrade(**arguments) == first
        upgrade.docker('exec', '-i', manager, '/usr/local/bin/python', '-I', '-S', '-c', ENSURE, workspace,
                       stdin=json.dumps({'owner_id': 'profile-smoke:1', 'generation': 1, 'instance_id': old_host}).encode())
        assert upgrade.inspect('container', old_host, upgrade.docker)['State']['Running'] is False
        result = json.loads(upgrade.docker('run', '--rm', '--network', 'none', '--user', '1000:1000',
                                          '--mount', mount, '--entrypoint', 'node', pinned,
                                          '--input-type=module', '-e', VERIFY))
        assert result['baselineSha256'] == first['baselineSha256']
        print(json.dumps({'check': 'immutable-image-profile-upgrade', 'imageId': pinned,
                          'sourcePath': upgrade.RUNTIME_PATCH, **result, 'originalAndCredentialsPreserved': True,
                          'managerFencePreserved': True, 'wrongUidRejected': True,
                          'timedOutCandidateRemoved': True}))
    finally:
        for name in (manager, old_host):
            assert re.fullmatch(r'gxzs-profile-upgrade-(manager|old)-[a-f0-9]{32}', name)
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=30)
        assert re.fullmatch(r'gxzs-profile-upgrade-smoke-[a-f0-9]{32}', volume)
        upgrade.docker('volume', 'rm', volume)
        assert re.fullmatch(r'gxzs-profile-upgrade-state-[a-f0-9]{32}', state)
        upgrade.docker('volume', 'rm', state)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: smoke-profile-upgrade.py CANDIDATE_HOST_IMAGE MANAGER_IMAGE')
    main(sys.argv[1], sys.argv[2])
