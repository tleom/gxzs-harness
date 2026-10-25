import importlib.util
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('file_transfer_ops', Path(__file__).parents[1] / 'file_ops.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
pytestmark = pytest.mark.skipif(os.name != 'posix', reason='Linux descriptor-relative file operations')


def transfer(root, source, destination, operation='move'):
    return ops.operate({'operation': operation, 'path': source, 'destination': destination}, str(root))


def test_copy_and_rename_directory_preserve_contents_and_file_properties(tmp_path):
    source = tmp_path / '材料'
    source.mkdir()
    (source / 'nested').mkdir()
    (source / 'nested' / 'a.txt').write_bytes('中文'.encode())
    transfer(tmp_path, '材料', '副本', 'copy')
    assert (source / 'nested/a.txt').read_text() == '中文'
    assert (tmp_path / '副本/nested/a.txt').read_text() == '中文'
    transfer(tmp_path, '副本', '归档')
    assert not (tmp_path / '副本').exists()
    result = ops.operate({'operation': 'stat', 'path': '归档'}, str(tmp_path))
    assert result['content_size'] == 6 and result['file_count'] == 1 and result['directory_count'] == 1
    assert result['modified'] > 0


@pytest.mark.parametrize('operation', ['copy', 'move'])
def test_existing_target_is_never_overwritten(tmp_path, operation):
    (tmp_path / 'a').write_text('source')
    (tmp_path / 'b').write_text('target')
    with pytest.raises(FileExistsError):
        transfer(tmp_path, 'a', 'b', operation)
    assert (tmp_path / 'a').read_text() == 'source'
    assert (tmp_path / 'b').read_text() == 'target'
    assert not list(tmp_path.glob('.copy-*'))


@pytest.mark.parametrize('operation', ['copy', 'move'])
@pytest.mark.parametrize('destination', ['a', 'a/sub', '../outside', '/tmp/outside'])
def test_rejects_self_descendant_and_outside_targets(tmp_path, operation, destination):
    (tmp_path / 'a').mkdir()
    (tmp_path / 'a/value').write_text('keep')
    with pytest.raises((ValueError, OSError)):
        transfer(tmp_path, 'a', destination, operation)
    assert (tmp_path / 'a/value').read_text() == 'keep'


@pytest.mark.parametrize('operation', ['copy', 'move'])
def test_symlink_source_and_destination_parents_are_rejected(tmp_path, operation):
    (tmp_path / 'real').mkdir()
    (tmp_path / 'real/a').write_text('keep')
    (tmp_path / 'link').symlink_to(tmp_path / 'real', target_is_directory=True)
    for source, destination in [('link/a', 'b'), ('real/a', 'link/b'), ('link', 'renamed')]:
        with pytest.raises((ValueError, OSError)):
            transfer(tmp_path, source, destination, operation)
    assert (tmp_path / 'real/a').read_text() == 'keep'


def test_copy_failure_removes_staging_and_preserves_source(tmp_path):
    (tmp_path / 'a').mkdir()
    (tmp_path / 'a/data').write_text('keep')
    (tmp_path / 'a/link').symlink_to('/etc/passwd')
    with pytest.raises(ValueError):
        transfer(tmp_path, 'a', 'b', 'copy')
    assert not (tmp_path / 'b').exists()
    assert not list(tmp_path.glob('.copy-*'))
    assert (tmp_path / 'a/data').read_text() == 'keep'


def test_competing_moves_publish_only_one_file(tmp_path):
    for name in ['a', 'b']:
        (tmp_path / name).write_text(name)
    def move(name):
        try:
            transfer(tmp_path, name, 'target')
            return name
        except FileExistsError:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(move, ['a', 'b']))
    winner = next(name for name in results if name)
    assert (tmp_path / 'target').read_text() == winner
    assert sum(result is not None for result in results) == 1
    assert (tmp_path / ('b' if winner == 'a' else 'a')).exists()


def test_copy_large_file_streams_without_legacy_read_limit(tmp_path):
    source = tmp_path / 'large.bin'
    with source.open('wb') as stream:
        stream.truncate(ops.MAX_BYTES + 1)
    result = transfer(tmp_path, 'large.bin', 'copy.bin', 'copy')
    assert result['size'] == ops.MAX_BYTES + 1
    assert source.stat().st_size == (tmp_path / 'copy.bin').stat().st_size


def test_new_folder_rejects_existing_name(tmp_path):
    (tmp_path / 'a').mkdir()
    with pytest.raises(ValueError):
        ops.operate({'operation': 'mkdir', 'path': 'a', 'exclusive': True}, str(tmp_path))


@pytest.mark.parametrize('kind', ['file', 'large-file', 'directory'])
def test_identity_survives_move_but_is_not_shared_by_copy(tmp_path, kind):
    source = tmp_path / 'source'
    if kind == 'directory':
        source.mkdir()
        (source / 'child').write_text('keep')
    else:
        with source.open('wb') as stream:
            stream.truncate(ops.MAX_BYTES + 1 if kind == 'large-file' else 10)
    listed = ops.operate({'operation': 'list'}, str(tmp_path))['entries'][0]
    copied = transfer(tmp_path, 'source', 'copy', 'copy')
    moved = transfer(tmp_path, 'source', 'moved')
    actual = ops.operate({'operation': 'stat', 'path': 'moved'}, str(tmp_path))
    assert listed['identity'] == moved['identity'] == actual['identity']
    assert copied['identity'] != actual['identity']


def test_conversations_properties_are_readable_without_allowing_mutations(tmp_path):
    (tmp_path / 'conversations/date/chat').mkdir(parents=True)
    (tmp_path / 'conversations/date/chat/a.txt').write_text('keep')
    result = ops.operate({'operation': 'stat', 'path': 'conversations'}, str(tmp_path))
    assert result['file_count'] == 1 and result['directory_count'] == 2
    assert result['content_size'] == 4 and result['downloadable'] is False
    for operation in ['upload', 'delete', 'mkdir']:
        with pytest.raises(ValueError):
            ops.operate({'operation': operation, 'path': 'conversations', 'version': result['version']}, str(tmp_path))
    assert (tmp_path / 'conversations/date/chat/a.txt').read_text() == 'keep'
