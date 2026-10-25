"""Share bindings follow explicit saves, never replacement files or copied attributes."""
import base64
import io
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import file_download
import file_ops

pytestmark = pytest.mark.skipif(os.name != 'posix', reason='Linux sandbox file attributes')


def bind(root, path='report.txt', create=True):
    return file_ops.operate({'operation': 'stat', 'path': path, 'bind_share': create}, str(root))


def read(root, identity, path='report.txt'):
    output = io.BytesIO()
    file_download.write_download({'path': path, 'share_identity': identity}, output, str(root))
    header, body = output.getvalue().split(b'\n', 1)
    assert json.loads(header)['share_identity'] == identity
    return body


@pytest.mark.parametrize('operation', ['move', 'delete', 'parent-move', 'copy-attributes'])
def test_old_link_rejects_new_file_at_original_path(tmp_path, operation):
    root = tmp_path / 'folder'
    root.mkdir()
    source = root / 'report.txt'
    source.write_bytes(b'shared')
    identity = bind(root)['share_identity']
    assert read(root, identity) == b'shared'
    if operation == 'move':
        source.rename(root / 'renamed.txt')
    elif operation == 'delete':
        source.unlink()
    elif operation == 'parent-move':
        root.rename(tmp_path / 'moved-folder')
        root.mkdir()
    else:
        moved = root / 'renamed.txt'
        source.rename(moved)
        shutil.copy2(moved, source)
    source.write_bytes(b'private-replacement')
    with pytest.raises(FileNotFoundError):
        read(root, identity)
    assert bind(root, create=False)['share_identity'] is None
    assert bind(root)['share_identity'] != identity


@pytest.mark.parametrize('transport', ['json', 'binary', 'native-edit'])
def test_save_keeps_binding_and_serves_updated_contents(tmp_path, transport):
    source = tmp_path / 'report.txt'
    source.write_bytes(b'initial')
    identity = bind(tmp_path)['share_identity']
    assert bind(tmp_path)['share_identity'] == identity
    if transport == 'native-edit':
        source.write_bytes(b'edited')
    else:
        payload = {'operation': 'upload', 'path': source.name, 'size': 6, 'version': file_ops.version(b'initial')}
        if transport == 'json':
            file_ops.operate({**payload, 'data': base64.b64encode(b'edited').decode()}, str(tmp_path))
        else:
            file_ops.upload_stream(payload, io.BytesIO(b'edited'), str(tmp_path))
    assert read(tmp_path, identity) == b'edited'
    assert bind(tmp_path, create=False)['share_identity'] == identity


def test_read_binding_does_not_create_one_or_mutate_file(tmp_path):
    source = tmp_path / 'report.txt'
    source.write_bytes(b'private')
    before = source.stat()
    assert bind(tmp_path, create=False)['share_identity'] is None
    assert source.stat().st_ctime_ns == before.st_ctime_ns
    assert file_ops.SHARE_IDENTITY_ATTRIBUTE not in os.listxattr(source)


def test_directory_replacement_does_not_return_archive(tmp_path):
    source = tmp_path / 'report.txt'
    source.write_bytes(b'shared')
    identity = bind(tmp_path)['share_identity']
    source.unlink()
    source.mkdir()
    with pytest.raises(FileNotFoundError):
        read(tmp_path, identity)


def test_native_replacement_during_download_publishes_no_bytes(tmp_path, monkeypatch):
    source = tmp_path / 'report.txt'
    source.write_bytes(b'shared')
    identity = bind(tmp_path)['share_identity']
    original = file_download.copy_file
    def replaced(fd, name, output, expected, digest=None, expected_share=None):
        source.rename(tmp_path / 'moved.txt')
        source.write_bytes(b'private')
        return original(fd, name, output, expected, digest, expected_share)
    monkeypatch.setattr(file_download, 'copy_file', replaced)
    output = io.BytesIO()
    with pytest.raises(ValueError):
        file_download.write_download({'path': source.name, 'share_identity': identity}, output, str(tmp_path))
    assert output.getvalue() == b''
