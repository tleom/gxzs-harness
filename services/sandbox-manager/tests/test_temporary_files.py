"""Temporary previews and boot rotation, executed with Linux directory descriptors."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import sys

import pytest

pytestmark = pytest.mark.skipif(os.name != 'posix', reason='sandbox filesystem requires Linux')
sys.path.insert(0, str(Path(__file__).parents[1]))
if os.name == 'posix':
    import file_download
    import file_ops
    spec = importlib.util.spec_from_file_location(
        'tmp_lifecycle', Path(__file__).parents[2] / 'sandbox' / 'tmp_lifecycle.py')
    lifecycle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lifecycle)


@pytest.fixture(params=[False, True], ids=['existing-image', 'rotating-image'])
def scratch(tmp_path, monkeypatch, request):
    storage = tmp_path / 'private'
    storage.mkdir()
    current = storage / 'current'
    current.mkdir()
    temp = tmp_path / 'tmp'
    if request.param:
        temp.symlink_to(current)
    else:
        temp.mkdir()
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    monkeypatch.setattr(file_ops, 'TEMP_PATH', str(temp))
    monkeypatch.setattr(file_ops, 'TEMP_STORAGE_ROOT', str(storage))
    return temp, workspace


def test_preview_stat_stream_and_deleted_file_use_existing_contract(scratch):
    temp, workspace = scratch
    (temp / 'render').mkdir()
    image = temp / 'render' / 'page.png'
    image.write_bytes(b'\x89PNG\x00\xff')
    path = '/tmp/render/page.png'
    metadata = file_ops.operate({'operation': 'stat', 'path': path}, str(workspace))
    assert metadata['kind'] == 'file'
    assert metadata['path'] == path
    result = file_ops.operate({'operation': 'get', 'path': path}, str(workspace))
    assert base64.b64decode(result['data']) == image.read_bytes()
    output = io.BytesIO()
    file_download.write_download({'path': path}, output, str(workspace))
    header, data = output.getvalue().split(b'\n', 1)
    assert data == image.read_bytes()
    assert json.loads(header)['version'] == metadata['version']
    assert file_ops.operate({'operation': 'list', 'path': '.'}, str(workspace))['entries'] == []
    image.unlink()
    assert file_ops.operate({'operation': 'stat', 'path': path}, str(workspace))['kind'] == 'missing'
    for operation in ['get', 'download']:
        with pytest.raises(FileNotFoundError):
            if operation == 'get':
                file_ops.operate({'operation': operation, 'path': path}, str(workspace))
            else:
                file_download.write_download({'path': path}, io.BytesIO(), str(workspace))


def test_temporary_previews_do_not_allow_listing_mutation_or_escape(scratch):
    temp, workspace = scratch
    (temp / 'a.txt').write_text('original')
    (temp / 'directory').mkdir()
    (temp / 'link').symlink_to(workspace)
    (temp / 'file-link').symlink_to(temp / 'a.txt')
    for operation in ['list', 'mkdir', 'put', 'delete', 'manifest', 'download']:
        with pytest.raises(ValueError):
            file_ops.operate({'operation': operation, 'path': '/tmp/a.txt'}, str(workspace))
    for path in ['/tmp/../workspace/secret', '/tmp//a.txt', '/tmp/./a.txt',
                 '/tmp/link/secret', '/tmp/file-link', '/tmp/directory', '/tmp/a\\b']:
        with pytest.raises((ValueError, OSError)):
            file_ops.operate({'operation': 'get', 'path': path}, str(workspace))
        with pytest.raises((ValueError, OSError)):
            file_download.write_download({'path': path}, io.BytesIO(), str(workspace))
    assert (temp / 'a.txt').read_text() == 'original'


def test_rotation_reclaims_only_retired_generations_and_retries_old_cleanup(tmp_path, monkeypatch):
    # This test never touches the host's real /tmp.
    root = tmp_path / 'scratch'
    root.mkdir()
    (root / 'current').mkdir()
    (root / 'current' / 'old').write_text('old')
    previous = root / ('retired-' + 'a' * 32)
    previous.mkdir()
    outside = tmp_path / 'keep'
    outside.mkdir()
    (outside / 'important').write_text('keep')
    (previous / 'link').symlink_to(outside, target_is_directory=True)
    (root / 'unrelated').mkdir()
    monkeypatch.setattr(lifecycle.os, 'nice', lambda _: None)
    lifecycle.rotate(str(root))
    assert list((root / 'current').iterdir()) == []
    assert (root / 'current').stat().st_mode & 0o7777 == 0o1777
    (root / 'current' / 'new').write_text('new')
    assert len(list(root.glob('retired-*'))) == 2
    lifecycle.cleanup(str(root))
    assert list(root.glob('retired-*')) == []
    assert (root / 'current' / 'new').read_text() == 'new'
    assert (outside / 'important').read_text() == 'keep'
    assert (root / 'unrelated').is_dir()


def test_start_never_waits_for_cleanup_and_spawn_failure_does_not_block(monkeypatch):
    events = []
    monkeypatch.setattr(lifecycle, 'rotate', lambda: events.append('rotate'))
    class Child:
        def wait(self, *args, **kwargs):
            pytest.fail('Startup must not wait for recursive cleanup')
    def spawn(*args, **kwargs):
        events.append('spawn')
        assert kwargs['start_new_session'] is True
        return Child()
    monkeypatch.setattr(lifecycle.subprocess, 'Popen', spawn)
    lifecycle.start()
    assert events == ['rotate', 'spawn']
    def failed_spawn(*args, **kwargs):
        raise OSError('no process available')
    monkeypatch.setattr(lifecycle.subprocess, 'Popen', failed_spawn)
    lifecycle.start()
