"""The operator must obtain image identity and baseline bytes from one Docker source."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

import pytest

source = Path(__file__).resolve().parents[3] / 'scripts/prepare-profile-upgrade.py'
spec = importlib.util.spec_from_file_location('profile_upgrade', source)
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
OLD = 'sha256:' + '1' * 64
NEW = 'sha256:' + '2' * 64
CONTAINER = '3' * 64
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
        if args[0] == 'create':
            assert args[-1] == OLD
            return CONTAINER.encode()
        if args[0] == 'cp':
            assert args == ('cp', CONTAINER + ':' + upgrade.RUNTIME_PATCH, '-')
            return self.content
        if args[0] == 'rm':
            assert args == ('rm', CONTAINER)
            return b''
        if args[0] == 'run':
            assert NEW in args and '--network' in args and 'none' in args
            assert args[args.index('--user') + 1] == '1000:1000'
            payload = json.loads(stdin)
            self.writes.append(payload)
            return json.dumps({**{key: payload[key] for key in ('ownerId', 'imageId', 'baselineSha256')},
                               'sourcePath': upgrade.RUNTIME_PATCH}).encode()
        raise AssertionError(args)


def prepare(run, **kwargs):
    return upgrade.prepare_upgrade(old_image=OLD, candidate_image=NEW,
                                   owner_id='tenant:1', home_volume='test-home', run=run, **kwargs)


def test_extracts_runtime_and_actual_image_as_one_source_before_seeding():
    run = DockerFixture()
    receipt = prepare(run)
    assert run.writes == [{'ownerId': 'tenant:1', 'imageId': OLD, 'baseline': BASELINE,
                          'baselineSha256': hashlib.sha256(BASELINE.encode()).hexdigest()}]
    assert receipt['imageId'] == OLD
    assert run.calls.index(('rm', CONTAINER)) < next(i for i, call in enumerate(run.calls) if call[0] == 'run')
    assert not any(call[0] in ('start', 'exec') for call in run.calls)


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
                                owner_id='tenant:1', home_volume='test-home', run=run)
    with pytest.raises(TypeError):
        prepare(run, baseline=BASELINE)
    assert not run.calls
