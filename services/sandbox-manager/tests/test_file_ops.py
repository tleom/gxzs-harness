import base64
from contextlib import contextmanager
import importlib.util
from pathlib import Path
import os
import io
import zipfile
import pytest

spec=importlib.util.spec_from_file_location('file_ops',Path(__file__).parents[1]/'file_ops.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.fixture
def root(tmp_path):
    (tmp_path/'conversations').mkdir()
    (tmp_path/'conversations'/'test-chat').mkdir()
    return str(tmp_path)


def test_large_directory_pages_without_omission_and_rejects_changed_directory(root):
    directory = Path(root) / 'large'
    directory.mkdir()
    for number in range(2003):
        (directory / f'{number:04d}.txt').touch()
    first = module.operate({'operation': 'list', 'path': 'large'}, root)
    assert len(first['entries']) == 2000 and first['total'] == 2003 and first['next_cursor']
    second = module.operate({'operation': 'list', 'path': 'large', 'cursor': first['next_cursor']}, root)
    assert [item['name'] for item in second['entries']] == ['2000.txt', '2001.txt', '2002.txt']
    assert second['next_cursor'] is None
    (directory / 'new.txt').touch()
    assert module.operate({'operation': 'list', 'path': 'large', 'cursor': first['next_cursor']}, root)['conflict']


@pytest.mark.parametrize('name', ['mcp', 'skills'])
def test_resource_roots_allow_browsing_and_zip_download_but_reject_deletion(root, name):
    directory = Path(root) / name
    directory.mkdir()
    (directory / 'demo.txt').write_text('content')
    assert module.operate({'operation': 'list', 'path': name}, root)['entries'][0]['name'] == 'demo.txt'
    result = module.operate({'operation': 'get', 'path': name}, root)
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(result['data']))) as archive:
        assert archive.read('demo.txt') == b'content'
    current = module.operate({'operation': 'stat', 'path': name}, root)
    with pytest.raises(ValueError, match='cannot be deleted'):
        module.operate({'operation': 'delete', 'path': name, 'version': current['version']}, root)
    assert (directory / 'demo.txt').read_text() == 'content'


def test_workspace_manifest_contains_stable_hashes_and_counts(root):
    target = Path(root) / 'evidence'
    target.mkdir()
    (target / 'a.bin').write_bytes(b'abc')
    (target / 'b.txt').write_bytes('中文'.encode())
    first = module.operate({'operation': 'manifest', 'path': '.'}, root)
    second = module.operate({'operation': 'manifest', 'path': '.'}, root)
    assert first == second
    assert first['items'] == 2
    assert first['size'] == 9
    assert {item['path'] for item in first['files']} == {'evidence/a.bin', 'evidence/b.txt'}
    assert all(len(item['sha256']) == 64 for item in first['files'])


def test_versions_create_conflict_atomic_replace_and_delete(root):
    def call(**payload):
        return module.operate({'path':'conversations/test-chat/中文.txt'}|payload,root)
    created=call(operation='upload',version=None,data=base64.b64encode(b'first').decode())
    assert call(operation='upload',version=None,data='')=={'conflict':True,'code':'FILE_VERSION_CONFLICT','message':'文件已改变，请刷新后重试'}
    assert call(operation='get')['data']==base64.b64encode(b'first').decode()
    updated=call(operation='upload',version=created['version'],data=base64.b64encode(b'second').decode())
    assert updated['version']!=created['version']
    assert call(operation='delete',version=created['version'])['conflict']
    assert call(operation='delete',version=updated['version'])=={'deleted':True}
    assert not list((Path(root)/'conversations/test-chat').glob('.upload-*'))


@pytest.mark.parametrize('path', ['.agent-output/missing', 'conversations/deleted/child/file.txt'])
def test_stat_returns_missing_when_a_parent_directory_is_absent(root, path):
    assert module.operate({'operation': 'stat', 'path': path}, root) == {'path': path, 'kind': 'missing'}
    with pytest.raises(FileNotFoundError):
        module.operate({'operation': 'get', 'path': path}, root)


def test_stat_missing_parent_does_not_hide_invalid_root_or_unsafe_traversal(root, tmp_path, monkeypatch):
    with pytest.raises(FileNotFoundError):
        module.operate({'operation': 'stat', 'path': 'missing/child'}, str(tmp_path / 'absent-root'))
    os.symlink(tmp_path / 'absent-target', Path(root) / 'escape')
    with pytest.raises(OSError):
        module.operate({'operation': 'stat', 'path': 'escape/child'}, root)
    with pytest.raises(ValueError):
        module.operate({'operation': 'stat', 'path': 'missing/../secret'}, root)
    original = module.os.open
    def denied(path, flags, *args, **kwargs):
        if path == 'denied':
            raise PermissionError('fixture denies traversal')
        return original(path, flags, *args, **kwargs)
    monkeypatch.setattr(module.os, 'open', denied)
    with pytest.raises(PermissionError):
        module.operate({'operation': 'stat', 'path': 'denied/child'}, root)


def test_large_file_can_be_deleted_without_reading_its_content(root, monkeypatch):
    target = Path(root) / 'large.bin'
    with target.open('wb') as stream:
        stream.truncate(1024 * 1024 * 1024)
    monkeypatch.setattr(module, 'read_file', lambda *args: pytest.fail('large deletion must not read file content'))
    metadata = module.operate({'operation': 'stat', 'path': target.name}, root)
    assert len(metadata['version']) == 64 and metadata['downloadable'] is False
    assert module.operate({'operation': 'delete', 'path': target.name, 'version': metadata['version']}, root) == {'deleted': True}
    assert not target.exists()


def test_large_file_rejects_stale_delete_and_remains_bounded_for_download(root):
    target = Path(root) / 'large.bin'
    with target.open('wb') as stream:
        stream.truncate(module.MAX_BYTES + 1)
    metadata = module.operate({'operation': 'stat', 'path': target.name}, root)
    with target.open('ab') as stream:
        stream.write(b'changed')
    result = module.operate({'operation': 'delete', 'path': target.name, 'version': metadata['version']}, root)
    assert result['code'] == 'FILE_VERSION_CONFLICT' and target.exists()
    with pytest.raises(ValueError, match='100 MiB'):
        module.operate({'operation': 'get', 'path': target.name}, root)


def test_delete_detects_a_replaced_file_after_open(root, monkeypatch):
    target = Path(root) / 'changed.txt'
    target.write_bytes(b'first')
    metadata = module.operate({'operation': 'stat', 'path': target.name}, root)
    original = module.version
    def replace(data):
        result = original(data)
        target.unlink()
        target.write_bytes(b'replacement')
        return result
    monkeypatch.setattr(module, 'version', replace)
    assert module.operate({'operation': 'delete', 'path': target.name, 'version': metadata['version']}, root)['conflict']
    assert target.read_bytes() == b'replacement'


@pytest.mark.parametrize('path',['../secret','conversations/test-chat/../secret','conversations/test-chat//file','conversations/test-chat/./file','/etc/passwd','conversations/test-chat\\secret'])
def test_path_traversal_is_rejected(root,path):
    with pytest.raises((ValueError,OSError)):
        module.operate({'operation':'get','path':path},root)


def test_symlink_directory_leaf_and_fifo_are_blocked(root,tmp_path):
    outside=tmp_path/'private'
    outside.mkdir()
    (outside/'secret').write_bytes(b'private')
    os.symlink(outside,Path(root)/'conversations/test-chat'/'escape')
    os.symlink(outside/'secret',Path(root)/'conversations/test-chat'/'leaf')
    os.mkfifo(Path(root)/'conversations/test-chat'/'pipe')
    for path in ('conversations/test-chat/escape/secret','conversations/test-chat/leaf','conversations/test-chat/pipe'):
        with pytest.raises((ValueError,OSError)):
            module.operate({'operation':'get','path':path},root)
    entries=module.operate({'operation':'list','path':'conversations/test-chat'},root)['entries']
    assert all(item['kind']=='blocked' for item in entries)
    assert (outside/'secret').read_bytes()==b'private'


def test_legacy_directory_download_keeps_its_original_memory_budget(root):
    directory = Path(root) / 'legacy'
    directory.mkdir()
    with (directory / 'large.bin').open('wb') as stream:
        stream.truncate(50 * 1024 * 1024 + 1)
    assert module.operate({'operation': 'stat', 'path': 'legacy'}, root)['downloadable']
    with pytest.raises(ValueError, match='Legacy directory download'):
        module.operate({'operation': 'get', 'path': 'legacy'}, root)


@pytest.mark.parametrize('operation', ['stat', 'get', 'delete'])
def test_metadata_and_legacy_paths_stop_before_collecting_an_oversized_directory(root, monkeypatch, operation):
    directory = Path(root) / 'large'
    directory.mkdir()
    for index in range(20):
        (directory / str(index)).write_text('preserved')
    monkeypatch.setattr(module, 'MAX_TREE_ITEMS', 3)
    original = os.scandir
    seen = []
    @contextmanager
    def counted(fd):
        with original(fd) as entries:
            def generate():
                for entry in entries:
                    seen.append(entry.name)
                    yield entry
            yield generate()
    monkeypatch.setattr(module.os, 'scandir', counted)
    monkeypatch.setattr(module.os, 'listdir', lambda *args: pytest.fail('must not allocate all directory names'))
    monkeypatch.setattr(module, 'read_file', lambda *args: pytest.fail('must reject before reading file data'))
    monkeypatch.setattr(module, 'remove_contents', lambda *args: pytest.fail('must reject before deleting anything'))
    with pytest.raises(ValueError, match='too many entries'):
        module.operate({'operation': operation, 'path': 'large', 'version': 'stale'}, root)
    assert len(seen) == 4
    assert all((directory / str(index)).read_text() == 'preserved' for index in range(20))


def test_tree_budget_counts_nested_directories_and_keeps_existing_fingerprint_order(root, monkeypatch):
    directory = Path(root) / 'tree'
    directory.mkdir()
    (directory / 'z').touch()
    (directory / 'a-').touch()
    (directory / 'a').mkdir()
    (directory / 'a' / 'z').touch()
    (directory / 'a' / 'b').touch()
    monkeypatch.setattr(module, 'MAX_TREE_ITEMS', 5)
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        entries = module.tree_entries(fd)
        assert [entry[0] for entry in entries] == ['a', 'a/b', 'a/z', 'a-', 'z']
        first = module.tree_version(fd)
        assert first == module.tree_version(fd)
        monkeypatch.setattr(module, 'MAX_TREE_ITEMS', 4)
        with pytest.raises(ValueError, match='too many entries'):
            module.tree_version(fd)
    finally:
        os.close(fd)


def test_directory_delete_rejects_stale_version_then_deletes_with_current_version(root):
    directory = Path(root) / 'tree'
    directory.mkdir()
    (directory / 'a.txt').write_text('before')
    first = module.operate({'operation': 'stat', 'path': 'tree'}, root)
    (directory / 'a.txt').write_text('after change')
    assert module.operate({'operation': 'delete', 'path': 'tree', 'version': first['version']}, root)['conflict']
    assert (directory / 'a.txt').read_text() == 'after change'
    latest = module.operate({'operation': 'stat', 'path': 'tree'}, root)
    assert module.operate({'operation': 'delete', 'path': 'tree', 'version': latest['version']}, root) == {'deleted': True}
    assert not directory.exists()
