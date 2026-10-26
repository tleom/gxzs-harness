import base64
import importlib.util
from pathlib import Path
import os
import pytest
import uuid

spec=importlib.util.spec_from_file_location('file_ops',Path(__file__).parents[1]/'file_ops.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_allocation_replays_after_response_loss_and_ignores_copied_markers(root):
    import shutil
    payload = {'operation': 'mkdir', 'path': 'conversations/new-chat', 'unique': True, 'allocation_id': str(uuid.uuid4())}
    first = module.operate(payload, root)
    assert module.operate(payload, root) == first
    shutil.copytree(Path(root) / first['path'], Path(root) / 'conversations/copied', copy_function=shutil.copy2)
    assert module.operate(payload, root) == first
    # The inode identity prevents a copied xattr from claiming another directory.
    shutil.rmtree(Path(root) / first['path'])
    assert module.operate(payload, root) == first
    assert (Path(root) / 'conversations/copied').is_dir()


def test_allocation_recovers_both_sides_of_atomic_publication(root, monkeypatch):
    payload = {'operation': 'mkdir', 'path': 'conversations/new-chat', 'unique': True, 'allocation_id': str(uuid.uuid4())}
    rename = module.rename_new
    def interrupted(*args):
        raise OSError('simulated interruption before publication')
    monkeypatch.setattr(module, 'rename_new', interrupted)
    with pytest.raises(OSError, match='interruption'):
        module.operate(payload, root)
    monkeypatch.setattr(module, 'rename_new', rename)
    first = module.operate(payload, root)
    assert module.operate(payload, root) == first
    assert not list((Path(root) / 'conversations').glob('.allocation-*'))


def test_concurrent_retries_reserve_one_path_per_identity(root):
    from concurrent.futures import ThreadPoolExecutor
    identifiers = [str(uuid.uuid4()) for _ in range(8)]
    def create(identity):
        return identity, module.operate({'operation': 'mkdir', 'path': 'conversations/new-chat',
            'unique': True, 'allocation_id': identity}, root)['path']
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(create, identifiers * 3))
    paths = {}
    for identity, path in results:
        assert paths.setdefault(identity, path) == path
    assert len(set(paths.values())) == 8
    assert 'conversations/new-chat' in paths.values()
    assert 'conversations/new-chat-8' in paths.values()


def test_allocation_does_not_follow_a_staging_symlink(root, tmp_path):
    identity = str(uuid.uuid4())
    outside = tmp_path / 'outside'; outside.mkdir()
    (Path(root) / 'conversations' / ('.allocation-' + identity)).symlink_to(outside, target_is_directory=True)
    with pytest.raises(OSError):
        module.operate({'operation': 'mkdir', 'path': 'conversations/new-chat', 'unique': True, 'allocation_id': identity}, root)
    assert list(outside.iterdir()) == []


@pytest.fixture
def root(tmp_path):
    (tmp_path/'conversations').mkdir()
    (tmp_path/'conversations'/'test-chat').mkdir()
    return str(tmp_path)


def test_mkdir_reports_atomic_reservation_without_changing_an_existing_directory(root):
    payload = {'operation': 'mkdir', 'path': 'conversations/new-chat'}
    assert module.operate(payload, root) == {'path': payload['path']}
    assert module.operate(payload, root) == {'path': payload['path']}
    assert module.operate({**payload, 'unique': True}, root) == {'path': payload['path'] + '-2'}
    assert module.operate({**payload, 'unique': True}, root) == {'path': payload['path'] + '-3'}


def test_unique_chat_directories_do_not_collide_under_concurrent_creation(root):
    from concurrent.futures import ThreadPoolExecutor
    payload = {'operation': 'mkdir', 'path': 'conversations/new-chat', 'unique': True}
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(lambda _: module.operate(payload, root)['path'], range(24)))
    assert len(set(paths)) == 24
    assert all((Path(root) / path).is_dir() for path in paths)


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
def test_resource_roots_allow_browsing_but_reject_deletion_and_text_reads(root, name):
    directory = Path(root) / name
    directory.mkdir()
    (directory / 'demo.txt').write_text('content')
    assert module.operate({'operation': 'list', 'path': name}, root)['entries'][0]['name'] == 'demo.txt'
    with pytest.raises(ValueError, match='use streaming download'):
        module.operate({'operation': 'get', 'path': name}, root)
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
    assert len(metadata['version']) == 64 and metadata['downloadable'] is True
    assert module.operate({'operation': 'delete', 'path': target.name, 'version': metadata['version']}, root) == {'deleted': True}
    assert not target.exists()


def test_large_file_download_is_available_but_legacy_json_reads_remain_bounded(root):
    target = Path(root) / 'large.bin'
    with target.open('wb') as stream:
        stream.truncate(module.MAX_BYTES + 1)
    metadata = module.operate({'operation': 'stat', 'path': target.name}, root)
    assert metadata['downloadable'] is True
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


def test_directory_text_reads_reject_before_scanning_or_reading_contents(root, monkeypatch):
    directory = Path(root) / 'legacy'
    directory.mkdir()
    with (directory / 'large.bin').open('wb') as stream:
        stream.truncate(50 * 1024 * 1024 + 1)
    assert module.operate({'operation': 'stat', 'path': 'legacy'}, root)['downloadable']
    def unexpected(*args, **kwargs):
        pytest.fail('A directory text read must not scan or read its contents')
    monkeypatch.setattr(module, 'tree_version', unexpected)
    monkeypatch.setattr(module, 'read_file', unexpected)
    with pytest.raises(ValueError, match='use streaming download'):
        module.operate({'operation': 'get', 'path': 'legacy', 'max_bytes': 2 * 1024 * 1024}, root)


@pytest.mark.parametrize('layout', ['flat', 'nested'])
@pytest.mark.parametrize('operation', ['stat', 'manifest'])
def test_large_directory_fingerprint_and_manifest_include_all_entries(root, layout, operation):
    directory = Path(root) / 'large'
    directory.mkdir()
    folders = [directory] if layout == 'flat' else [directory / f'group-{index}' for index in range(5)]
    for folder in folders:
        folder.mkdir(exist_ok=True)
    expected, total = set(), 0
    for index in range(10001):
        target = folders[index % len(folders)] / f'{index}.txt'
        content = str(index).encode()
        target.write_bytes(content)
        expected.add(target.relative_to(root).as_posix())
        total += len(content)
    payload = {'operation': operation, 'path': '.' if operation == 'manifest' else 'large'}
    first = module.operate(payload, root)
    assert first == module.operate(payload, root)
    if operation == 'manifest':
        assert first['items'] == 10001 and first['size'] == total
        assert {item['path'] for item in first['files']} == expected
        assert all(len(item['sha256']) == 64 for item in first['files'])
    else:
        assert first['downloadable'] is True
        (directory / 'changed.txt').write_text('new content')
        latest = module.operate(payload, root)
        assert first['version'] != latest['version']
        assert module.operate({'operation': 'delete', 'path': 'large', 'version': first['version']}, root)['conflict']
        assert (directory / 'changed.txt').read_text() == 'new content'


def test_tree_entries_keep_existing_fingerprint_order(root):
    directory = Path(root) / 'tree'
    directory.mkdir()
    (directory / 'z').touch()
    (directory / 'a-').touch()
    (directory / 'a').mkdir()
    (directory / 'a' / 'z').touch()
    (directory / 'a' / 'b').touch()
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        entries = module.tree_entries(fd)
        assert [entry[0] for entry in entries] == ['a', 'a/b', 'a/z', 'a-', 'z']
        first = module.tree_version(fd)
        assert first == module.tree_version(fd)
    finally:
        os.close(fd)


@pytest.mark.parametrize('limit', ['MAX_MANIFEST_FILE_BYTES', 'MAX_MANIFEST_TREE_BYTES'])
def test_workspace_manifest_keeps_size_budgets(root, monkeypatch, limit):
    directory = Path(root) / 'evidence'
    nested = directory / 'nested'
    nested.mkdir(parents=True)
    (directory / 'a.txt').write_bytes(b'abc')
    (nested / 'b.txt').write_bytes(b'def')
    monkeypatch.setattr(module, limit, 2 if limit == 'MAX_MANIFEST_FILE_BYTES' else 5)
    with pytest.raises(ValueError, match='manifest limits'):
        module.operate({'operation': 'manifest', 'path': '.'}, root)


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
