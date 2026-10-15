"""The operator must obtain image identity and baseline bytes from one Docker source."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile

import pytest

source = Path(__file__).resolve().parents[3] / 'scripts/prepare-profile-upgrade.py'
spec = importlib.util.spec_from_file_location('profile_upgrade', source)
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
OLD = 'sha256:' + '1' * 64
NEW = 'sha256:' + '2' * 64
CONTAINER = '3' * 64
CANDIDATE = '4' * 64
WORKSPACE = '00000000-0000-4000-8000-000000000001'
BASELINE = '- id: generated-preset\n  disabled: true\n'


def archive(name='cordis.runtime.patch.yml', link=False):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as tar:
        entry = tarfile.TarInfo(name)
        content = BASELINE.encode()
        entry.size = len(content)
        if link:
            entry.type, entry.linkname = tarfile.SYMTYPE, '/unrelated'
        tar.addfile(entry, io.BytesIO(content))
    return output.getvalue()


class DockerFixture:
    def __init__(self):
        self.calls = []
        self.writes = []
        self.owner = 'tenant:1'
        self.running = b''
        self.container_image = OLD
        self.content = archive()
        self.candidate_failure = False
        self.fenced = True
        self.completed = False

    def __call__(self, *args, stdin=None):
        self.calls.append(args)
        if args[:2] == ('image', 'inspect'):
            return json.dumps([{'Id': args[2]}]).encode()
        if args[:2] == ('volume', 'inspect'):
            return json.dumps([{'Name': 'test-home', 'Labels': {'gxzs.owner': self.owner}}]).encode()
        if args[:2] == ('container', 'inspect'):
            return json.dumps([{'Image': self.container_image}]).encode()
        if args[0] == 'ps':
            return self.running
        if args[0] == 'exec':
            assert args[:3] == ('exec', '-i', 'gxzs-sandbox-manager') and args[-1] == WORKSPACE
            payload = json.loads(stdin)
            if payload['operation'] != 'begin':
                assert payload['token'] == 'fixture-fence'
            if payload['operation'] == 'complete':
                self.completed = True
            return json.dumps({'fenced': self.fenced, 'phase': 'prepared' if self.completed else 'preparing',
                               'token': 'fixture-fence', 'owner_id': self.owner, 'workspace_id': WORKSPACE,
                               'generation': 1, 'instance_id': 'old-host', 'image_digest': OLD,
                               'home_volume': 'test-home'}).encode()
        if args[0] == 'create':
            if '--name' in args:
                assert NEW in args
                assert args[args.index('--user') + 1] == '1000:1000'
                return CANDIDATE.encode()
            assert args[-1] == OLD
            return CONTAINER.encode()
        if args[0] == 'cp':
            assert args == ('cp', CONTAINER + ':' + upgrade.RUNTIME_PATCH, '-')
            return self.content
        if args[0] == 'rm':
            assert (args == ('rm', CONTAINER)
                    or (args[:2] == ('rm', '-f') and args[2].startswith('gxzs-profile-upgrade-')))
            return b''
        if args[0] == 'start':
            assert args == ('start', '--attach', '--interactive', CANDIDATE)
            if self.candidate_failure:
                raise subprocess.TimeoutExpired('docker start', 60)
            payload = json.loads(stdin)
            self.writes.append(payload)
            return json.dumps({**{key: payload[key] for key in ('ownerId', 'imageId', 'baselineSha256')},
                               'sourcePath': upgrade.RUNTIME_PATCH}).encode()
        raise AssertionError(args)


def prepare(run, **kwargs):
    return upgrade.prepare_upgrade(old_image=OLD, candidate_image=NEW,
                                   owner_id='tenant:1', home_volume='test-home', workspace_id=WORKSPACE,
                                   generation=1, instance_id='old-host', run=run, **kwargs)


def test_extracts_runtime_and_actual_image_as_one_source_before_seeding():
    run = DockerFixture()
    receipt = prepare(run)
    assert run.writes == [{'ownerId': 'tenant:1', 'imageId': OLD, 'baseline': BASELINE,
                          'baselineSha256': hashlib.sha256(BASELINE.encode()).hexdigest()}]
    assert receipt['imageId'] == OLD
    candidate_create = next(i for i, call in enumerate(run.calls) if call[0] == 'create' and '--name' in call)
    assert run.calls.index(('rm', CONTAINER)) < candidate_create
    assert ('start', CONTAINER) not in run.calls
    assert run.completed
    assert run.calls[-2][0:2] == ('rm', '-f')


@pytest.mark.parametrize('failure', ['foreign-owner', 'active-home', 'mismatched-image', 'static-patch', 'symlink'])
def test_rejects_unsafe_provenance_or_home_before_any_owner_write(failure):
    run = DockerFixture()
    if failure == 'foreign-owner':
        run.owner = 'tenant:2'
    elif failure == 'active-home':
        run.running = b'live-host\n'
    elif failure == 'mismatched-image':
        run.container_image = NEW
    elif failure == 'static-patch':
        run.content = archive('cordis.patch.yml')
    elif failure == 'symlink':
        run.content = archive(link=True)
    with pytest.raises(ValueError):
        prepare(run)
    assert not run.writes
    if any(call[0] == 'create' for call in run.calls):
        assert run.calls[-1] == ('rm', CONTAINER)


def test_rejects_mutable_image_tags_and_does_not_accept_a_caller_baseline():
    run = DockerFixture()
    with pytest.raises(ValueError):
        upgrade.prepare_upgrade(old_image='old:latest', candidate_image=NEW,
                                owner_id='tenant:1', home_volume='test-home', workspace_id=WORKSPACE,
                                generation=1, instance_id='old-host', run=run)
    with pytest.raises(TypeError):
        prepare(run, baseline=BASELINE)
    assert not run.calls


def test_kills_the_identifiable_candidate_after_an_attach_timeout():
    run = DockerFixture()
    run.candidate_failure = True
    with pytest.raises(subprocess.TimeoutExpired):
        prepare(run)
    created = next(call for call in run.calls if call[0] == 'create' and '--name' in call)
    assert run.calls[-1] == ('rm', '-f', created[created.index('--name') + 1])
    assert not run.completed


def test_requires_a_durable_manager_fence_before_extracting_or_writing_home():
    run = DockerFixture()
    run.fenced = False
    with pytest.raises(ValueError, match='durably fenced'):
        prepare(run)
    assert not run.writes
    assert not any(call[0] in ('create', 'start') for call in run.calls)
