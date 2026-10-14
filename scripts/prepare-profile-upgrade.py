#!/usr/bin/env python3
"""Prepare an owner baseline from an immutable Docker image without starting it."""
import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile

RUNTIME_PATCH = '/opt/workbench/profiles/workbench/cordis.runtime.patch.yml'
IMAGE_ID = re.compile(r'sha256:[a-f0-9]{64}')
CONTAINER_ID = re.compile(r'[a-f0-9]{64}')
SEED = '''
import {readFileSync} from 'node:fs';
import {provisionLegacyBaseline} from '/opt/workbench/scripts/migrate-platform-patch.mjs';
const input=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify(await provisionLegacyBaseline('/srv/dsh/profiles/workbench',input)));
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


def prepare_upgrade(*, old_image, candidate_image, owner_id, home_volume,
                    user='1000:1000', run=docker):
    if (not IMAGE_ID.fullmatch(old_image) or not IMAGE_ID.fullmatch(candidate_image)
            or not re.fullmatch(r'[^:\s/]+:[0-9]+', owner_id)
            or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}', home_volume)
            or not re.fullmatch(r'[0-9]+:[0-9]+', user)):
        raise ValueError('Pinned images, owner, volume and original UID:GID are required')
    if inspect('image', candidate_image, run)['Id'] != candidate_image:
        raise ValueError('Candidate image identity does not match')
    volume = inspect('volume', home_volume, run)
    if (volume.get('Name') != home_volume
            or (volume.get('Labels') or {}).get('gxzs.owner') != owner_id):
        raise ValueError('Home volume does not belong to this owner')
    if run('ps', '--filter', 'volume=' + home_volume, '--format', '{{.ID}}').strip():
        raise ValueError('Stop and drain all containers using this owner home first')
    # Both the bytes and source ID come from the same never-started container.
    # The operator cannot supply a baseline or a separate claimed digest.
    baseline = extract_baseline(old_image, run)
    payload = {'ownerId': owner_id, 'imageId': old_image, 'baseline': baseline,
               'baselineSha256': hashlib.sha256(baseline.encode('utf-8')).hexdigest()}
    result = run('run', '--rm', '-i', '--network', 'none', '--read-only',
                 '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                 '--user', user, '--memory', '256m', '--cpus', '1', '--pids-limit', '128',
                 '--mount', 'type=volume,source=' + home_volume + ',destination=/srv/dsh',
                 '--entrypoint', 'node', candidate_image, '--input-type=module', '-e', SEED,
                 stdin=json.dumps(payload).encode('utf-8'))
    metadata = json.loads(result)
    if any(metadata.get(key) != payload[key] for key in ('ownerId', 'imageId', 'baselineSha256')):
        raise ValueError('Written baseline receipt does not match the extracted image')
    if metadata.get('sourcePath') != RUNTIME_PATCH:
        raise ValueError('Candidate did not write runtime patch provenance')
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-image', required=True)
    parser.add_argument('--candidate-image', required=True)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--home-volume', required=True)
    parser.add_argument('--user', required=True, help='Original home UID:GID')
    args = vars(parser.parse_args())
    print(json.dumps(prepare_upgrade(**args)))


if __name__ == '__main__':
    main()
