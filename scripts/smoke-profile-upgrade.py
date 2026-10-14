#!/usr/bin/env python3
"""Exercise the formal image-baseline entry point against a disposable owner volume."""
import importlib.util
import json
from pathlib import Path
import re
import sys
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


def main(image):
    pinned = upgrade.inspect('image', image, upgrade.docker)['Id']
    if not upgrade.IMAGE_ID.fullmatch(pinned):
        raise ValueError('Missing immutable fixture image')
    volume = 'gxzs-profile-upgrade-smoke-' + uuid.uuid4().hex
    upgrade.docker('volume', 'create', '--label', 'gxzs.owner=profile-smoke:1', volume)
    mount = 'type=volume,source=' + volume + ',destination=/srv/dsh'
    try:
        upgrade.docker('run', '--rm', '--network', 'none', '--user', '0:0', '--mount', mount,
                       '--entrypoint', 'node', pinned, '-e', INITIALIZE)
        first = upgrade.prepare_upgrade(old_image=pinned, candidate_image=pinned,
                                        owner_id='profile-smoke:1', home_volume=volume)
        assert upgrade.prepare_upgrade(old_image=pinned, candidate_image=pinned,
                                       owner_id='profile-smoke:1', home_volume=volume) == first
        result = json.loads(upgrade.docker('run', '--rm', '--network', 'none', '--user', '1000:1000',
                                          '--mount', mount, '--entrypoint', 'node', pinned,
                                          '--input-type=module', '-e', VERIFY))
        assert result['baselineSha256'] == first['baselineSha256']
        print(json.dumps({'check': 'immutable-image-profile-upgrade', 'imageId': pinned,
                          'sourcePath': upgrade.RUNTIME_PATCH, **result, 'originalAndCredentialsPreserved': True}))
    finally:
        assert re.fullmatch(r'gxzs-profile-upgrade-smoke-[a-f0-9]{32}', volume)
        upgrade.docker('volume', 'rm', volume)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: smoke-profile-upgrade.py CANDIDATE_HOST_IMAGE')
    main(sys.argv[1])
