"""One-upload imports, durable results and recovery at publication boundaries."""
import base64
import hashlib
import importlib
import io
import json
import os
import select
import sys
import uuid
import zipfile
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(os.name != 'posix', reason='Requires Linux locks and atomic exchange')


@pytest.fixture
def modules():
    import file_ops
    import resource_ops
    import binary_upload
    import skill_imports
    # Other package tests deliberately reload these modules for fault injection.
    for item in (file_ops, resource_ops, binary_upload, skill_imports):
        if sys.modules.get(item.__name__) is item:
            importlib.reload(item)
    return skill_imports, resource_ops, binary_upload, file_ops


SKILL = b'---\nname: report\ndescription: Reports\n---\nUse assets.'


def staged(modules, root, *, archive=True):
    imports, _, upload, _ = modules
    value = uuid.uuid4().hex
    if archive:
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
            zipped.writestr('report/SKILL.md', SKILL)
            zipped.writestr('report/assets/data.bin', b'x' * 131073)
        data = stream.getvalue()
        files = [{'path': 'report.zip', 'size': len(data)}]
    else:
        data = SKILL + b'x' * 131073
        files = [{'path': 'SKILL.md', 'size': len(SKILL)}, {'path': 'assets/data.bin', 'size': 131073}]
    metadata = {'operation': 'skill_stage', 'import_id': value, 'archive': archive, 'files': files}
    result = upload.run(io.BytesIO(json.dumps(metadata).encode() + b'\n' + data), 'personal-resources', str(root))
    assert result['content'] == SKILL.decode()
    prepared = imports.prepare({'import_id': value, 'name': 'report'}, root=str(root))
    return {'import_id': value, 'name': 'report', 'version': prepared['version']}


def test_cancel_snapshot_cannot_bypass_publication_lock(modules, tmp_path, monkeypatch):
    import threading
    imports, ops, _, _ = modules
    payload = staged(modules, tmp_path)
    extracting, resume, saving, release, finished = [threading.Event() for _ in range(5)]
    write, save = ops.write_package, imports.Store.save
    results = {}
    def blocked_write(*args, **kwargs):
        extracting.set()
        assert resume.wait(3)
        return write(*args, **kwargs)
    def blocked_save(self, state):
        if threading.current_thread().name == 'cancel' and state['status'] == 'unknown':
            saving.set()
            assert release.wait(3)
        return save(self, state)
    monkeypatch.setattr(ops, 'write_package', blocked_write)
    monkeypatch.setattr(imports.Store, 'save', blocked_save)
    def install():
        results['run'] = imports.run(payload, root=str(tmp_path))
        finished.set()
    installer = threading.Thread(target=install)
    cancellation = threading.Thread(name='cancel', target=lambda: results.update(cancel=imports.status(
        payload, root=str(tmp_path), cancel=True, confirmed=False)))
    installer.start()
    assert extracting.wait(3)
    cancellation.start()
    assert saving.wait(3)
    resume.set()
    try:
        assert not finished.wait(0.1)
        assert not (tmp_path / 'skills/report').exists()
    finally:
        release.set()
        installer.join(3)
        cancellation.join(3)
    assert results['run']['status'] == 'cancelled'
    assert imports.status(payload, root=str(tmp_path))['status'] == 'cancelled'


def test_cleanup_failure_keeps_completed_receipt_and_retries(modules, tmp_path, monkeypatch):
    imports, _, _, _ = modules
    payload = staged(modules, tmp_path)
    original = imports.Store.remove_body
    monkeypatch.setattr(imports.Store, 'remove_body', lambda *_: (_ for _ in ()).throw(OSError('cleanup unavailable')))
    assert imports.run(payload, root=str(tmp_path))['status'] == 'completed'
    assert imports.status(payload, root=str(tmp_path))['status'] == 'completed'
    path = tmp_path / '.skill-imports' / payload['import_id']
    assert json.loads((path / 'state.json').read_text())['cleanup_pending']
    monkeypatch.setattr(imports.Store, 'remove_body', original)
    assert imports.status(payload, root=str(tmp_path))['status'] == 'completed'
    assert not (path / 'body').exists()
    assert not (tmp_path / '.skill-imports/.pending' / payload['import_id']).exists()


@pytest.mark.parametrize('point', ['.swept', '.maintenance.lock', '.pending'])
def test_optional_maintenance_failure_never_hides_installed_skills(modules, tmp_path, monkeypatch, point):
    imports, ops, _, _ = modules
    payload = staged(modules, tmp_path)
    assert imports.run(payload, root=str(tmp_path))['status'] == 'completed'
    original_open, original_write = os.open, imports.atomic_write
    def open_fault(name, *args, **kwargs):
        if name == point:
            raise OSError('maintenance unavailable')
        return original_open(name, *args, **kwargs)
    def write_fault(fd, name, data):
        if name == point:
            raise OSError('maintenance unavailable')
        return original_write(fd, name, data)
    monkeypatch.setattr(os, 'open', open_fault)
    monkeypatch.setattr(imports, 'atomic_write', write_fault)
    listing = ops.personal({'operation': 'list'}, root=str(tmp_path))
    assert listing['skills'][0]['id'] == 'report'
    assert listing['warnings']


def test_package_syncs_each_file_and_each_finished_directory_once(modules, tmp_path, monkeypatch):
    import stat
    _, ops, _, _ = modules
    counts = {'files': 0, 'directories': 0}
    original = os.fsync
    def sync(fd):
        counts['directories' if stat.S_ISDIR(os.fstat(fd).st_mode) else 'files'] += 1
        return original(fd)
    monkeypatch.setattr(os, 'fsync', sync)
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        ops.write_package(fd, {str(index): ops.PackageFile.from_bytes(b'x') for index in range(32)})
    finally:
        os.close(fd)
    assert counts == {'files': 32, 'directories': 1}


def test_directory_stat_uses_same_fingerprint_without_bulk_json_or_rewalk(modules, tmp_path, monkeypatch):
    _, _, _, files = modules
    folder = tmp_path / '中文'
    folder.mkdir()
    (folder / 'a.txt').write_text('test')
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    child = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    try:
        expected = hashlib.sha256(json.dumps(files.tree_entries(child), separators=(',', ':')).encode()).hexdigest()
        original = files.tree_entries
        walks = []
        def entries(*args, **kwargs):
            walks.append(1)
            return original(*args, **kwargs)
        monkeypatch.setattr(files, 'tree_entries', entries)
        serialize = files.json.dumps
        def no_bulk_json(value, *args, **kwargs):
            if isinstance(value, list):
                pytest.fail('whole tree JSON copy')
            return serialize(value, *args, **kwargs)
        monkeypatch.setattr(files.json, 'dumps', no_bulk_json)
        actual = files.entry_metadata(fd, '中文', '中文', os.stat(folder))
        assert actual['version'] == expected and len(walks) == 1
    finally:
        os.close(child)
        os.close(fd)


def test_abandoned_stage_and_expired_receipt_are_reclaimed(modules, tmp_path):
    imports, _, _, _ = modules
    payload = staged(modules, tmp_path)
    path = tmp_path / '.skill-imports' / payload['import_id']
    state = json.loads((path / 'state.json').read_text())
    state['updated_at'] = 0
    (path / 'state.json').write_text(json.dumps(state))
    assert imports.recover_pending(str(tmp_path)) == []
    assert imports.status(payload, root=str(tmp_path))['status'] == 'cancelled'
    assert not (path / 'body').exists()
    state = json.loads((path / 'state.json').read_text())
    state['terminal_at'] = 0
    (path / 'state.json').write_text(json.dumps(state))
    (tmp_path / '.skill-imports/.swept').unlink()
    assert imports.recover_pending(str(tmp_path)) == []
    assert not path.exists()


def test_clean_history_is_not_reopened_or_synced_on_catalog_read(modules, tmp_path, monkeypatch):
    imports, _, _, _ = modules
    payload = staged(modules, tmp_path)
    imports.run(payload, root=str(tmp_path))
    imports.recover_pending(str(tmp_path))  # Initial index migration/sweep.
    monkeypatch.setattr(imports.Store, '__enter__', lambda *_: pytest.fail('historical receipt reopened'))
    monkeypatch.setattr(os, 'fsync', lambda *_: pytest.fail('read-only catalog synced'))
    assert imports.recover_pending(str(tmp_path)) == []


@pytest.mark.parametrize('interrupted', [False, True])
def test_publication_recovery_holds_namespace_lock_through_identity_check_and_backup(modules, tmp_path, monkeypatch, interrupted):
    import fcntl
    imports, ops, _, _ = modules
    active = tmp_path / 'skills/report'
    active.mkdir(parents=True)
    (active / 'SKILL.md').write_bytes(SKILL)
    staging = tmp_path / '.skill-import-review'
    staging.mkdir()
    (staging / 'SKILL.md').write_bytes(SKILL + b'\nNew')
    rootfd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    skillsfd = os.open(tmp_path / 'skills', os.O_RDONLY | os.O_DIRECTORY)
    try:
        state = {'status': 'running', 'phase': 'publishing', 'name': 'report',
                 'staging': staging.name, 'backup': 'report-old',
                 'old_identity': imports.identity(os.stat(active)),
                 'new_identity': imports.identity(os.stat(staging))}
        ops.rename_directory(rootfd, staging.name, skillsfd, 'report', exchange=True)
        state['new_version'] = ops.package_version(skillsfd, 'report')
        original = imports.entry_identity
        def checked(fd, name):
            checkfd = os.open(tmp_path / 'skills', os.O_RDONLY | os.O_DIRECTORY)
            try:
                with pytest.raises(BlockingIOError):
                    fcntl.flock(checkfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(checkfd)
            if interrupted:
                raise OSError('injected recovery interruption')
            return original(fd, name)
        monkeypatch.setattr(imports, 'entry_identity', checked)
        store = SimpleNamespace(rootfd=rootfd, cancelled=lambda: False)
        if interrupted:
            with pytest.raises(OSError, match='recovery interruption'):
                imports.recover(store, state)
            assert (staging / 'SKILL.md').read_bytes() == SKILL
        else:
            assert imports.recover(store, state)['status'] == 'completed'
            assert (tmp_path / 'skills/.backups/report-old/SKILL.md').read_bytes() == SKILL
            assert not staging.exists()
        assert (active / 'SKILL.md').read_bytes() == SKILL + b'\nNew'
        # Both success and exceptions release the lock for later mutations.
        fcntl.flock(skillsfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(skillsfd, fcntl.LOCK_UN)
    finally:
        os.close(skillsfd)
        os.close(rootfd)


def test_ambiguous_publication_retains_body_and_pending_recovery(modules, tmp_path):
    imports, _, _, _ = modules
    payload = staged(modules, tmp_path)
    active = tmp_path / 'skills/report'
    active.mkdir()
    (active / 'SKILL.md').write_bytes(SKILL)
    with imports.Store(str(tmp_path), payload['import_id']) as store, store.lock():
        state = store.read()
        state.update(status='running', phase='publishing', staging='.skill-import-missing',
                     new_identity=[0, 0], old_identity=None, backup=None, new_version='unknown')
        store.save(state)
    assert imports.run(payload, root=str(tmp_path))['status'] == 'unknown'
    assert (tmp_path / '.skill-imports' / payload['import_id'] / 'body').exists()
    assert (tmp_path / '.skill-imports/.pending' / payload['import_id']).exists()
    assert imports.recover_pending(str(tmp_path))


def test_legacy_json_and_binary_imports_keep_response_and_durable_receipts(modules, tmp_path):
    imports, ops, upload, _ = modules
    result = ops.personal({'operation': 'skill_import', 'name': 'report',
        'files': [{'path': 'SKILL.md', 'data': base64.b64encode(SKILL).decode()}]}, root=str(tmp_path))
    assert set(result) == {'id', 'version', 'path'}
    metadata = {'operation': 'skill_import', 'name': 'report', 'version': result['version'],
                'archive': False, 'files': [{'path': 'SKILL.md', 'size': len(SKILL)}]}
    result = upload.run(io.BytesIO(json.dumps(metadata).encode() + b'\n' + SKILL), 'personal-resources', str(tmp_path))
    assert set(result) == {'id', 'version', 'path'}
    receipts = list((tmp_path / '.skill-imports').glob('*/state.json'))
    assert len(receipts) == 2
    assert all(json.loads(path.read_text())['status'] == 'completed' for path in receipts)


def test_global_cache_hit_skips_asset_extraction_and_recovers_missing_target(modules, tmp_path, monkeypatch):
    import shutil
    _, ops, _, _ = modules
    package = {'packages': [{'name': 'report', 'files': [
        {'path': 'SKILL.md', 'data': base64.b64encode(SKILL).decode()},
        {'path': 'asset.bin', 'data': base64.b64encode(b'x' * 65537).decode()}]}]}
    first = ops.global_install(package, str(tmp_path))
    write = ops.write_package
    monkeypatch.setattr(ops, 'write_package', lambda *_args, **_kw: pytest.fail('cache hit rewrote assets'))
    assert ops.global_install(package, str(tmp_path)) == first
    target = tmp_path / first['skills'][0]['path'].split('/')[-1]
    os.chmod(target, 0o700)
    shutil.rmtree(target)
    monkeypatch.setattr(ops, 'write_package', write)
    assert ops.global_install(package, str(tmp_path)) == first


@pytest.mark.parametrize('archive', [True, False])
def test_upload_once_commit_and_replay_only_receipt(modules, tmp_path, monkeypatch, archive):
    imports, ops, _, _ = modules
    payload = staged(modules, tmp_path, archive=archive)
    result = imports.run(payload, root=str(tmp_path))
    assert result['status'] == 'completed'
    assert (tmp_path / 'skills/report/assets/data.bin').read_bytes() == b'x' * 131073
    assert not (tmp_path / '.skill-imports' / payload['import_id'] / 'body').exists()
    monkeypatch.setattr(ops, 'write_member', lambda *args, **kwargs: pytest.fail('must not replay completed import'))
    assert imports.run(payload, root=str(tmp_path)) == result
    assert imports.status(payload, root=str(tmp_path), cancel=True) == result


def test_cancel_before_late_upload_and_cross_owner_lookup(modules, tmp_path):
    imports, _, upload, _ = modules
    token = uuid.uuid4().hex
    root = tmp_path / 'first'
    root.mkdir()
    assert imports.status({'import_id': token}, root=str(root), cancel=True)['status'] == 'cancelled'
    metadata = {'operation': 'skill_stage', 'import_id': token, 'archive': False,
                'files': [{'path': 'SKILL.md', 'size': len(SKILL)}]}
    with pytest.raises(ValueError, match='已停止'):
        upload.run(io.BytesIO(json.dumps(metadata).encode() + b'\n' + SKILL), 'personal-resources', str(root))
    other = tmp_path / 'other'
    other.mkdir()
    assert imports.status({'import_id': token}, root=str(other))['status'] == 'pending'
    assert not (root / 'skills/report').exists()


def test_modified_manifest_and_stale_version_preserve_package(modules, tmp_path):
    imports, _, _, _ = modules
    payload = staged(modules, tmp_path)
    assert imports.run(payload, root=str(tmp_path))['status'] == 'completed'
    second = staged(modules, tmp_path)
    (tmp_path / 'skills/report/extra').write_text('changed')
    assert imports.run(second, root=str(tmp_path))['conflict']
    assert (tmp_path / 'skills/report/extra').read_text() == 'changed'
    third = staged(modules, tmp_path, archive=False)
    body = tmp_path / '.skill-imports' / third['import_id'] / 'body'
    body.write_bytes(SKILL.replace(b'Reports', b'REPORTS') + b'x' * 131073)
    assert imports.run(third, root=str(tmp_path))['status'] == 'failed'
    assert (tmp_path / 'skills/report/SKILL.md').read_bytes() == SKILL


@pytest.mark.parametrize('point', ['extracting', 'before-exchange', 'after-exchange', 'after-backup', 'new-publication'])
def test_killed_installer_recovery_never_discards_old_tree(modules, tmp_path, point):
    imports, ops, _, _ = modules
    if point != 'new-publication':
        old = tmp_path / 'skills/report'
        old.mkdir(parents=True)
        (old / 'SKILL.md').write_bytes(SKILL)
        (old / 'old.bin').write_bytes(b'old package')
    payload = staged(modules, tmp_path)
    child = os.fork()
    if child == 0:
        if point == 'extracting':
            original = imports.Transaction.extracting
            def stop(self, *args):
                original(self, *args)
                os._exit(9)
            imports.Transaction.extracting = stop
        elif point == 'before-exchange':
            original = imports.Transaction.publishing
            def stop(self, *args):
                original(self, *args)
                os._exit(9)
            imports.Transaction.publishing = stop
        elif point in {'after-exchange', 'new-publication'}:
            original = ops.rename_directory
            def stop(*args, **kwargs):
                original(*args, **kwargs)
                os._exit(9)
            ops.rename_directory = stop
        else:
            original = os.rename
            def stop(source, destination, *args, **kwargs):
                result = original(source, destination, *args, **kwargs)
                if str(source).startswith('.skill-import-'):
                    os._exit(9)
                return result
            os.rename = stop
        imports.run(payload, root=str(tmp_path))
        os._exit(3)
    _, code = os.waitpid(child, 0)
    assert os.waitstatus_to_exitcode(code) == 9
    # Catalog recovery works without an in-memory manager call or a client ID.
    listing = ops.personal({'operation': 'list'}, root=str(tmp_path))
    assert len(listing['skills']) == 1
    result = imports.status(payload, root=str(tmp_path))
    if point in {'after-exchange', 'after-backup', 'new-publication'}:
        assert result['status'] == 'completed'
        assert (tmp_path / 'skills/report/assets/data.bin').stat().st_size == 131073
        if point != 'new-publication':
            backups = list((tmp_path / 'skills/.backups').iterdir())
            assert len(backups) == 1
            assert (backups[0] / 'old.bin').read_bytes() == b'old package'
    else:
        assert result['status'] == 'failed'
        assert (tmp_path / 'skills/report/old.bin').read_bytes() == b'old package'
    assert not list(tmp_path.glob('.skill-import-*'))
    assert not (tmp_path / '.skill-imports' / payload['import_id'] / 'body').exists()


def test_status_and_cancel_do_not_recover_a_live_installer(modules, tmp_path):
    imports, _, _, _ = modules
    payload = staged(modules, tmp_path)
    read, write = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(read)
        with imports.Store(str(tmp_path), payload['import_id']) as store, store.lock('run.lock'):
            state = store.read()
            state['status'] = 'running'
            store.save(state)
            os.write(write, b'1')
            import time
            time.sleep(10)
        os._exit(0)
    os.close(write)
    try:
        assert os.read(read, 1) == b'1'
        assert imports.status(payload, root=str(tmp_path))['status'] == 'running'
        result = imports.status(payload, root=str(tmp_path), cancel=True, confirmed=False)
        assert result['status'] == 'unknown' and result['uncertain']
        assert (tmp_path / '.skill-imports' / payload['import_id'] / 'body').exists()
    finally:
        os.close(read)
        os.kill(child, 9)
        os.waitpid(child, 0)
    assert imports.status(payload, root=str(tmp_path), cancel=True)['status'] == 'cancelled'


def test_global_extracts_asset_once_and_preserves_existing_address(modules, tmp_path, monkeypatch):
    _, ops, _, _ = modules
    stream = io.BytesIO()
    entries = {'SKILL.md': SKILL, 'asset.bin': b'x' * 131073}
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    opened = []
    original = zipfile.ZipFile.open
    def counted(self, name, *args, **kwargs):
        opened.append(name.filename if isinstance(name, zipfile.ZipInfo) else name)
        return original(self, name, *args, **kwargs)
    monkeypatch.setattr(zipfile.ZipFile, 'open', counted)
    request = {'packages': [{'name': 'report', 'archive': base64.b64encode(stream.getvalue()).decode()}]}
    first = ops.global_install(request, str(tmp_path))
    assert opened.count('asset.bin') == 1
    assert opened.count('SKILL.md') == 2  # bounded inspection, then publication
    digest = hashlib.sha256()
    for name, data in sorted(entries.items()):
        digest.update(name.encode() + b'\0' + hashlib.sha256(data).digest())
    assert first['skills'][0]['path'].endswith('/' + digest.hexdigest())
    assert ops.global_install(request, str(tmp_path)) == first
    assert len([path for path in tmp_path.iterdir() if not path.name.startswith('.')]) == 1


def test_incremental_directory_fingerprint_matches_original_bytes(modules, tmp_path):
    _, _, _, files = modules
    for name in ['中文.txt', 'z', 'a/a', 'a.b', 'a/b', 'a-b', 'quote".txt']:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
    fd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        expected = hashlib.sha256(json.dumps(files.tree_entries(fd), separators=(',', ':')).encode()).hexdigest()
        assert files.tree_version(fd) == expected
    finally:
        os.close(fd)


def test_invalid_receipt_does_not_hide_other_installed_skills(modules, tmp_path):
    imports, ops, _, _ = modules
    payload = staged(modules, tmp_path)
    assert imports.run(payload, root=str(tmp_path))['status'] == 'completed'
    state = tmp_path / '.skill-imports' / payload['import_id'] / 'state.json'
    state.write_text('{broken')
    result = ops.personal({'operation': 'list'}, root=str(tmp_path))
    assert result['skills'][0]['id'] == 'report'
    assert result['warnings'] and state.read_text() == '{broken'


def test_parallel_imports_recheck_version_after_extraction(modules, tmp_path):
    imports, _, _, _ = modules
    payloads = [staged(modules, tmp_path), staged(modules, tmp_path)]
    ready_read, ready_write = os.pipe()
    release_read, release_write = os.pipe()
    children = []
    for index, payload in enumerate(payloads):
        child = os.fork()
        if child == 0:
            os.close(ready_read)
            os.close(release_write)
            original = imports.Transaction.extracting
            def synchronized(self, *args):
                original(self, *args)
                os.write(ready_write, b'1')
                os.read(release_read, 1)
            imports.Transaction.extracting = synchronized
            result = imports.run(payload, root=str(tmp_path))
            (tmp_path / ('result-' + str(index))).write_text(json.dumps(result))
            os._exit(0)
        children.append(child)
    os.close(ready_write)
    os.close(release_read)
    remaining = set(children)
    try:
        ready = b''
        while len(ready) < 2:
            assert select.select([ready_read], [], [], 5)[0], 'both importers must reach extraction'
            ready += os.read(ready_read, 2 - len(ready))
        os.write(release_write, b'11')
        for child in children:
            _, code = os.waitpid(child, 0)
            remaining.remove(child)
            assert os.waitstatus_to_exitcode(code) == 0
        results = [json.loads((tmp_path / ('result-' + str(index))).read_text()) for index in range(2)]
        assert sorted(result['status'] for result in results) == ['completed', 'conflict']
        assert (tmp_path / 'skills/report/assets/data.bin').read_bytes() == b'x' * 131073
        assert not list(tmp_path.glob('.skill-import-*'))
    finally:
        os.close(ready_read)
        os.close(release_write)
        for child in remaining:
            try:
                os.kill(child, 9)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
