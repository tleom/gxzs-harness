import base64
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
        assert any(archive.read(path) == b'content' for path in archive.namelist())
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
    assert call(operation='upload',version=None,data='')=={'conflict':True,'message':'文件已改变，请刷新后重试'}
    assert call(operation='get')['data']==base64.b64encode(b'first').decode()
    updated=call(operation='upload',version=created['version'],data=base64.b64encode(b'second').decode())
    assert updated['version']!=created['version']
    assert call(operation='delete',version=created['version'])['conflict']
    assert call(operation='delete',version=updated['version'])=={'deleted':True}
    assert not list((Path(root)/'conversations/test-chat').glob('.upload-*'))


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
