"""Linux sandbox regression tests for binary framing, CAS and disk-backed downloads."""
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
    monkeypatch.setattr(file_ops, 'MAX_TREE_ITEMS', 1)
    for name in ['a', 'b', 'c']:
        (directory / name).write_bytes(b'123')
    file_download.write_download({'path': 'files'}, io.BytesIO(), str(tmp_path))
    (directory / 'd').write_bytes(b'12')
    with pytest.raises(ValueError, match='1 GiB'):
        file_download.write_download({'path': 'files'}, io.BytesIO(), str(tmp_path))


def test_download_rejects_symlink_and_traversal(tmp_path):
    (tmp_path / 'target').write_bytes(b'private')
    (tmp_path / 'link').symlink_to(tmp_path / 'target')
    for name in ['link', '../target', '.']:
        with pytest.raises((ValueError, OSError)):
            file_download.write_download({'path': name}, io.BytesIO(), str(tmp_path))


def test_package_keeps_skill_validation_and_expansion_budget(tmp_path, monkeypatch):
    data = b'---\nname: test\ndescription: test\n---\n# Test'
    metadata = {'operation': 'skill_inspect', 'archive': False, 'files': [{'path': 'SKILL.md', 'size': len(data)}]}
    result = binary_upload.run(frame(metadata, data), 'personal-resources', str(tmp_path))
    assert result['content'] == data.decode()
    monkeypatch.setitem(binary_upload.personal.__globals__, 'MAX_PACKAGE', 1)
    with pytest.raises(ValueError):
        binary_upload.run(frame(metadata, data), 'personal-resources', str(tmp_path))
