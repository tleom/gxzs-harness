"""Linux sandbox regression tests for binary framing, CAS and disk-backed downloads."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import zipfile
import pytest

pytestmark = pytest.mark.skipif(os.name != 'posix', reason='sandbox descriptor operations require Linux')
sys.path.insert(0, str(Path(__file__).parents[1]))
if os.name == 'posix':
    import binary_upload
    import file_download
    import file_ops


def frame(metadata, data):
    return io.BytesIO(json.dumps(metadata).encode() + b'\n' + data)


def save_file(root, transport, data, version):
    metadata = {'operation': 'upload', 'path': 'script.sh', 'size': len(data), 'version': version}
    if transport == 'json':
        return file_ops.operate({**metadata, 'data': base64.b64encode(data).decode()}, str(root))
    return binary_upload.run(frame(metadata, data), 'files', str(root))


@pytest.mark.parametrize('transport', ['json', 'binary'])
@pytest.mark.parametrize('mutation', ['edit', 'replace', 'create'])
def test_save_preserves_concurrent_native_changes(tmp_path, monkeypatch, transport, mutation):
    path = tmp_path / 'script.sh'
    old = b'old content'
    if mutation != 'create':
        path.write_bytes(old)
    expected = file_ops.version(old) if path.exists() else None
    native_fsync = os.fsync
    changed = False
    def concurrent_write(fd):
        nonlocal changed
        native_fsync(fd)
        if not changed:
            changed = True
            if mutation == 'replace':
                path.unlink()
            path.write_bytes(b'agent content')
    monkeypatch.setattr(file_ops.os, 'fsync', concurrent_write)
    result = save_file(tmp_path, transport, b'editor content', expected)
    assert result['code'] == 'FILE_VERSION_CONFLICT'
    assert path.read_bytes() == b'agent content'
    assert [item.name for item in tmp_path.iterdir()] == ['script.sh']


@pytest.mark.parametrize('transport', ['json', 'binary'])
@pytest.mark.parametrize('mode', [0o755, 0o640, None])
def test_save_keeps_existing_permissions_and_private_new_file_default(tmp_path, transport, mode):
    path = tmp_path / 'script.sh'
    if mode is not None:
        path.write_bytes(b'old')
        path.chmod(mode)
    expected = file_ops.version(b'old') if mode is not None else None
    result = save_file(tmp_path, transport, b'new', expected)
    assert result['version'] == file_ops.version(b'new')
    assert path.read_bytes() == b'new'
    assert path.stat().st_mode & 0o7777 == (mode if mode is not None else 0o600)


def test_binary_upload_exact_bytes_conflict_and_incomplete_cleanup(tmp_path):
    metadata = {'operation': 'upload', 'path': 'a.bin', 'size': 3, 'version': None}
    result = binary_upload.run(frame(metadata, b'\x00\xffx'), 'files', str(tmp_path))
    assert result['version'] == hashlib.sha256(b'\x00\xffx').hexdigest()
    assert (tmp_path / 'a.bin').read_bytes() == b'\x00\xffx'
    assert binary_upload.run(frame(metadata, b'new'), 'files', str(tmp_path))['conflict']
    metadata.update(version=result['version'], size=4)
    with pytest.raises(ValueError):
        binary_upload.run(frame(metadata, b'bad'), 'files', str(tmp_path))
    assert (tmp_path / 'a.bin').read_bytes() == b'\x00\xffx'
    assert [item.name for item in tmp_path.iterdir()] == ['a.bin']


def test_streamed_file_and_directory_have_correct_contents_and_no_staging_entries(tmp_path):
    directory = tmp_path / 'files'
    directory.mkdir()
    (directory / 'a.bin').write_bytes(b'\x00\xffx')
    (directory / 'empty').mkdir()
    for name in ['files/a.bin', 'files']:
        output = io.BytesIO()
        file_download.write_download({'path': name}, output, str(tmp_path))
        header, data = output.getvalue().split(b'\n', 1)
        metadata = json.loads(header)
        assert metadata['size'] == len(data)
        if name == 'files':
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                assert archive.read('a.bin') == b'\x00\xffx'
                assert 'empty/' in archive.namelist()
        else:
            assert metadata['version'] == hashlib.sha256(data).hexdigest()
        assert list(tmp_path.iterdir()) == [directory]


def test_directory_budget_uses_uncompressed_bytes_and_has_no_entry_cap(tmp_path, monkeypatch):
    directory = tmp_path / 'files'
    directory.mkdir()
    monkeypatch.setattr(file_download, 'MAX_DIRECTORY_BYTES', 10)
    for name in ['a', 'b', 'c']:
        (directory / name).write_bytes(b'123')
    # Both directory metadata and streaming downloads support the complete tree.
    listing = file_ops.operate({'operation': 'list', 'path': '.'}, str(tmp_path))
    assert listing['entries'][0]['downloadable'] is True
    assert file_ops.operate({'operation': 'stat', 'path': 'files'}, str(tmp_path))['downloadable'] is True
    output = io.BytesIO()
    file_download.write_download({'path': 'files'}, output, str(tmp_path))
    with zipfile.ZipFile(io.BytesIO(output.getvalue().split(b'\n', 1)[1])) as archive:
        assert archive.namelist() == ['a', 'b', 'c']
        assert all(archive.read(name) == b'123' for name in archive.namelist())
    (directory / 'd').write_bytes(b'12')
    with pytest.raises(ValueError, match='1 GiB'):
        file_download.write_download({'path': 'files'}, io.BytesIO(), str(tmp_path))


def test_large_file_download_bypasses_json_read_limit_and_leaves_no_staging_files(tmp_path):
    target = tmp_path / 'large.bin'
    size = 101 * 1024 * 1024 + 1
    with target.open('wb') as stream:
        stream.truncate(size)
    metadata = file_ops.operate({'operation': 'stat', 'path': target.name}, str(tmp_path))
    assert metadata['downloadable'] is True
    class Sink:
        total = 0
        header = None
        def write(self, chunk):
            if self.header is None:
                self.header = json.loads(chunk)
            else:
                assert len(chunk) <= 64 * 1024
                self.total += len(chunk)
        def flush(self):
            pass
    sink = Sink()
    file_download.write_download({'path': target.name}, sink, str(tmp_path))
    assert sink.total == sink.header['size'] == size
    assert list(tmp_path.iterdir()) == [target]


def test_download_rejects_symlink_and_traversal(tmp_path):
    (tmp_path / 'target').write_bytes(b'private')
    (tmp_path / 'link').symlink_to(tmp_path / 'target')
    for name in ['link', '../target', '.']:
        with pytest.raises((ValueError, OSError)):
            file_download.write_download({'path': name}, io.BytesIO(), str(tmp_path))


def test_package_keeps_skill_text_size_validation(tmp_path):
    data = b'---\nname: test\ndescription: test\n---\n# Test'
    metadata = {'operation': 'skill_inspect', 'archive': False, 'files': [{'path': 'SKILL.md', 'size': len(data)}]}
    result = binary_upload.run(frame(metadata, data), 'personal-resources', str(tmp_path))
    assert result['content'] == data.decode()
    data = b'x' * (64 * 1024 + 1)
    metadata['files'][0]['size'] = len(data)
    with pytest.raises(ValueError, match='64 KiB'):
        binary_upload.run(frame(metadata, data), 'personal-resources', str(tmp_path))


@pytest.mark.parametrize('archive', [False, True])
def test_streamed_skill_package_with_many_assets_can_be_imported(tmp_path, archive):
    entries = {'SKILL.md': b'---\nname: report\ndescription: Reports\n---\nUse the assets.'}
    entries.update({f'references/item-{index}.txt': str(index).encode() for index in range(250)})
    if archive:
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
            for path, data in entries.items():
                bundle.writestr(path, data)
        data = stream.getvalue()
        files = [{'path': 'report.zip', 'size': len(data)}]
    else:
        data = b''.join(entries.values())
        files = [{'path': path, 'size': len(content)} for path, content in entries.items()]
    metadata = {'operation': 'skill_inspect', 'archive': archive, 'files': files}
    assert binary_upload.run(frame(metadata, data), 'personal-resources', str(tmp_path))['content'] == entries['SKILL.md'].decode()
    metadata.update(operation='skill_import', name='report', version=None)
    result = binary_upload.run(frame(metadata, data), 'personal-resources', str(tmp_path))
    assert result['version']
    assert {path.relative_to(tmp_path / 'skills/report').as_posix(): path.read_bytes()
            for path in (tmp_path / 'skills/report').rglob('*') if path.is_file()} == entries
