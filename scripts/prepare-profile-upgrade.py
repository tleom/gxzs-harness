#!/usr/bin/env python3
"""Prepare an owner baseline from an immutable Docker image without starting it."""
import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile
import uuid

RUNTIME_PATCH = '/opt/workbench/profiles/workbench/cordis.runtime.patch.yml'
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}')
CONTAINER_ID = re.compile(r'[a-f0-9]{64}')
SEED = '''
import {readFileSync,lstatSync} from 'node:fs';
import {provisionLegacyBaseline} from '/opt/workbench/scripts/migrate-platform-patch.mjs';
const input=JSON.parse(readFileSync(0,'utf8'));
for(const path of ['/srv/dsh','/srv/dsh/profiles/workbench']) {
  const info=lstatSync(path);
  if(!info.isDirectory() || info.uid!==process.getuid() || info.gid!==process.getgid())
    throw Error('Original home and profile UID:GID must match the requested process identity');
}
console.log(JSON.stringify(await provisionLegacyBaseline('/srv/dsh/profiles/workbench',input)));
'''
MANAGER_REQUEST = '''
import json,os,sys,urllib.request
request=urllib.request.Request('http://127.0.0.1:5010/sandboxes/'+sys.argv[1]+'/profile-upgrade',
    data=sys.stdin.buffer.read(),headers={'Authorization':'Bearer '+os.environ['WORKBENCH_SANDBOX_MANAGER_TOKEN'],
    'Content-Type':'application/json'},method='POST')
with urllib.request.urlopen(request,timeout=45) as response:
    print(response.read().decode('utf-8'))
'''


def docker(*args, stdin=None):
    return subprocess.run(['docker', *args], input=stdin, capture_output=True,
                          check=True, timeout=60).stdout


def inspect(kind, identity, run):
    rows = json.loads(run(kind, 'inspect', identity))
    if not isinstance(rows, list) or len(rows) != 1:
        raise ValueError('Expected exactly one Docker object')
    return rows[0]


def extract_baseline(image_id, run=docker):
    if not IMAGE_ID.fullmatch(image_id):
        raise ValueError('An immutable old image ID is required')
    if inspect('image', image_id, run)['Id'] != image_id:
        raise ValueError('Old image identity does not match')
    container = run('create', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges:true', '--entrypoint', '/bin/true',
                    image_id).decode().strip()
    if not CONTAINER_ID.fullmatch(container):
        raise ValueError('Invalid disposable Docker container identity')
    try:
        if inspect('container', container, run)['Image'] != image_id:
            raise ValueError('Captured container does not belong to the old image')
        archive = run('cp', container + ':' + RUNTIME_PATCH, '-')
        if len(archive) > 2 * 1024 * 1024:
            raise ValueError('Legacy runtime patch archive is too large')
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            entries = tar.getmembers()
            if (len(entries) != 1 or not entries[0].isfile()
                    or entries[0].name != 'cordis.runtime.patch.yml'):
                raise ValueError('Expected the regular legacy runtime patch file')
            content = tar.extractfile(entries[0]).read(1024 * 1024 + 1)
        if not content or len(content) > 1024 * 1024:
            raise ValueError('Legacy runtime patch size is invalid')
        return content.decode('utf-8', errors='strict')
    finally:
        # This full container ID was created here and has never been started.
        run('rm', container)


def seed_candidate(candidate_image, user, home_volume, payload, run=docker):
    name = 'gxzs-profile-upgrade-' + uuid.uuid4().hex
    try:
        container = run('create', '--name', name, '--interactive', '--network', 'none', '--read-only',
                        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                        '--user', user, '--memory', '256m', '--cpus', '1', '--pids-limit', '128',
                        '--mount', 'type=volume,source=' + home_volume + ',destination=/srv/dsh',
                        '--entrypoint', 'node', candidate_image, '--input-type=module', '-e', SEED).decode().strip()
        if not CONTAINER_ID.fullmatch(container):
            raise ValueError('Invalid candidate container identity')
        return json.loads(run('start', '--attach', '--interactive', container,
                              stdin=json.dumps(payload).encode('utf-8')))
    finally:
        # The unique name is known even if create/start times out before returning.
        # Killing the attached CLI alone does not stop a container holding the home.
        try:
            run('rm', '-f', name)
        except subprocess.CalledProcessError as error:
            if b'No such container' not in (error.stderr or b''):
                raise


def manager_operation(manager, workspace, payload, run=docker):
    return json.loads(run('exec', '-i', manager, '/usr/local/bin/python', '-I', '-S', '-c',
                          MANAGER_REQUEST, workspace, stdin=json.dumps(payload).encode('utf-8')))


def prepare_upgrade(*, old_image, candidate_image, owner_id, home_volume,
                    workspace_id, generation, instance_id,
                    manager_container='gxzs-sandbox-manager', user='1000:1000', run=docker):
    if (not IMAGE_ID.fullmatch(old_image) or not IMAGE_ID.fullmatch(candidate_image)
            or not re.fullmatch(r'[^:\s/]+:[0-9]+', owner_id)
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}', home_volume)
            or not re.fullmatch(r'[0-9]+:[0-9]+', user)
            or str(uuid.UUID(workspace_id)) != workspace_id
            or not isinstance(generation, int) or isinstance(generation, bool) or generation < 1
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', instance_id)
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', manager_container)):
        raise ValueError('Pinned images, owner, volume and original UID:GID are required')
    if inspect('image', candidate_image, run)['Id'] != candidate_image:
        raise ValueError('Candidate image identity does not match')
    volume = inspect('volume', home_volume, run)
    if (volume.get('Name') != home_volume
            or (volume.get('Labels') or {}).get('gxzs.owner') != owner_id):
        raise ValueError('Home volume does not belong to this owner')
    identity = {'owner_id': owner_id, 'workspace_id': workspace_id, 'generation': generation,
                'instance_id': instance_id, 'image_digest': old_image, 'home_volume': home_volume}
    fence = manager_operation(manager_container, workspace_id, {
        'operation': 'begin', 'owner_id': owner_id, 'generation': generation, 'instance_id': instance_id}, run)

    def checked(receipt):
        if (receipt.get('fenced') is not True or receipt.get('phase') not in ('preparing', 'prepared')
                or any(receipt.get(key) != value for key, value in identity.items())
                or not isinstance(receipt.get('token'), str) or not receipt['token']):
            raise ValueError('Owner is not durably fenced for the requested original Host identity')
        return receipt

    checked(fence)
    if run('ps', '--filter', 'volume=' + home_volume, '--format', '{{.ID}}').strip():
        raise ValueError('Stop and drain all containers using this owner home first')
    # Both the bytes and source ID come from the same never-started container.
    # The operator cannot supply a baseline or a separate claimed digest.
    baseline = extract_baseline(old_image, run)
    payload = {'ownerId': owner_id, 'imageId': old_image, 'baseline': baseline,
               'baselineSha256': hashlib.sha256(baseline.encode('utf-8')).hexdigest()}
    checked(manager_operation(manager_container, workspace_id, {'operation': 'check', 'token': fence['token']}, run))
    metadata = seed_candidate(candidate_image, user, home_volume, payload, run)
    if any(metadata.get(key) != payload[key] for key in ('ownerId', 'imageId', 'baselineSha256')):
        raise ValueError('Written baseline receipt does not match the extracted image')
    if metadata.get('sourcePath') != RUNTIME_PATCH:
        raise ValueError('Candidate did not write runtime patch provenance')
    checked(manager_operation(manager_container, workspace_id, {'operation': 'complete', 'token': fence['token']}, run))
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-image', required=True)
    parser.add_argument('--candidate-image', required=True)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--home-volume', required=True)
    parser.add_argument('--workspace-id', required=True)
    parser.add_argument('--generation', required=True, type=int)
    parser.add_argument('--instance-id', required=True)
    parser.add_argument('--manager-container', default='gxzs-sandbox-manager')
    parser.add_argument('--user', required=True, help='Original home UID:GID')
    args = vars(parser.parse_args())
    print(json.dumps(prepare_upgrade(**args)))


if __name__ == '__main__':
    main()
