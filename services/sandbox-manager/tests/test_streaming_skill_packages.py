"""Skill packages stream to disk and publish only complete, validated trees."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import zipfile

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Requires Linux descriptor and directory exchange operations")
SKILL = b"---\nname: report\ndescription: Reports\n---\nUse the assets."


@pytest.fixture
def modules():
    base = Path(__file__).parents[1]
    for name in ("file_ops", "resource_ops", "binary_upload"):
        spec = importlib.util.spec_from_file_location(name, base / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules["resource_ops"], sys.modules["binary_upload"]


def bundle(entries=None, compression=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as archive:
        for path, data in (entries or {"SKILL.md": SKILL, "asset.bin": b"new asset"}).items():
            archive.writestr(path, data)
    return output.getvalue()


def upload(uploads, raw, root, operation="skill_inspect", version=None):
    metadata = {"operation": operation, "archive": True, "name": "report", "version": version,
                "files": [{"path": "report.zip", "size": len(raw)}]}
    source = io.BytesIO(json.dumps(metadata).encode() + b"\n" + raw)
    return uploads.run(source, "personal-resources", str(root))


def installed(ops, root):
    return ops.personal({"operation": "skill_import", "name": "report", "files": [
        {"path": "SKILL.md", "data": base64.b64encode(SKILL).decode()},
        {"path": "asset.bin", "data": base64.b64encode(b"original asset").decode()},
    ]}, str(root))


@pytest.mark.parametrize("transport", ["binary", "json"])
def test_inspection_reads_only_bounded_skill_text(modules, tmp_path, monkeypatch, transport):
    ops, uploads = modules
    raw = bundle()
    original = zipfile.ZipFile.open
    def open_skill(archive, member, *args, **kwargs):
        name = member.filename if isinstance(member, zipfile.ZipInfo) else member
        assert name == "SKILL.md", "inspection must not decompress unused assets"
        return original(archive, member, *args, **kwargs)
    monkeypatch.setattr(zipfile.ZipFile, "open", open_skill)
    monkeypatch.setattr(zipfile.ZipFile, "read", lambda *args: pytest.fail("whole-member reads are forbidden"))
    if transport == "binary":
        result = upload(uploads, raw, tmp_path)
    else:
        result = ops.personal({"operation": "skill_inspect", "archive": base64.b64encode(raw).decode()}, str(tmp_path))
    assert result["content"] == SKILL.decode()
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("entries", [
    {"SKILL.md": SKILL, "../escape": b"bad"},
    {"SKILL.md": SKILL, "A.txt": b"a", "a.txt": b"b"},
    {"SKILL.md": SKILL, "asset": b"file", "asset/child": b"nested"},
    {"SKILL.md": b"x" * (64 * 1024 + 1)},
])
def test_invalid_metadata_is_rejected_before_opening_members(modules, tmp_path, monkeypatch, entries):
    _, uploads = modules
    raw = bundle(entries)
    monkeypatch.setattr(zipfile.ZipFile, "open", lambda *args, **kwargs: pytest.fail("invalid metadata must fail before decompression"))
    with pytest.raises(ValueError):
        upload(uploads, raw, tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_corrupt_asset_never_replaces_the_installed_package(modules, tmp_path):
    ops, uploads = modules
    previous = installed(ops, tmp_path)
    raw = bytearray(bundle({"SKILL.md": SKILL, "asset.bin": b"x" * (128 * 1024)}, zipfile.ZIP_STORED))
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        info = archive.getinfo("asset.bin")
    offset = info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
    raw[offset] ^= 1
    assert upload(uploads, raw, tmp_path)["content"] == SKILL.decode()
    with pytest.raises(zipfile.BadZipFile):
        upload(uploads, raw, tmp_path, "skill_import", previous["version"])
    assert (tmp_path / "skills/report/asset.bin").read_bytes() == b"original asset"
    assert ops.personal({"operation": "list"}, str(tmp_path))["skills"][0]["version"] == previous["version"]
    assert not list(tmp_path.glob(".skill-import-*"))


@pytest.mark.parametrize("failure", ["write", "exchange", "backup", "sync"])
def test_import_failure_preserves_the_old_tree_and_removes_staging(modules, tmp_path, monkeypatch, failure):
    ops, uploads = modules
    previous = installed(ops, tmp_path)
    raw = bundle()
    original_write, original_exchange = ops.write_member, ops.rename_directory
    original_rename, original_sync = ops.os.rename, ops.os.fsync
    state = {"exchanged": False, "failed": False}
    def fail():
        state["failed"] = True
        raise OSError("injected import failure")
    def write(fd, name, member):
        if failure == "write" and name == "asset.bin":
            fail()
        return original_write(fd, name, member)
    def exchange(*args, **kwargs):
        if failure == "exchange" and kwargs.get("exchange") and not state["failed"]:
            fail()
        result = original_exchange(*args, **kwargs)
        state["exchanged"] = kwargs.get("exchange", False)
        return result
    def rename(source, target, *args, **kwargs):
        if failure == "backup" and str(source).startswith(".skill-import-") and not state["failed"]:
            fail()
        return original_rename(source, target, *args, **kwargs)
    def sync(fd):
        if failure == "sync" and state["exchanged"] and not state["failed"]:
            fail()
        return original_sync(fd)
    monkeypatch.setattr(ops, "write_member", write)
    monkeypatch.setattr(ops, "rename_directory", exchange)
    monkeypatch.setattr(ops.os, "rename", rename)
    monkeypatch.setattr(ops.os, "fsync", sync)
    with pytest.raises(OSError, match="injected"):
        upload(uploads, raw, tmp_path, "skill_import", previous["version"])
    assert (tmp_path / "skills/report/asset.bin").read_bytes() == b"original asset"
    assert ops.personal({"operation": "list"}, str(tmp_path))["skills"][0]["version"] == previous["version"]
    assert not list(tmp_path.glob(".skill-import-*"))
    assert not list((tmp_path / "skills/.backups").glob("*"))


def test_replacement_exchanges_complete_trees_without_an_absent_active_path(modules, tmp_path, monkeypatch):
    ops, uploads = modules
    previous = installed(ops, tmp_path)
    original = ops.rename_directory
    seen = []
    def exchange(sourcefd, source, targetfd, target, **kwargs):
        assert kwargs.get("exchange") is True
        assert (tmp_path / "skills/report/asset.bin").read_bytes() == b"original asset"
        result = original(sourcefd, source, targetfd, target, **kwargs)
        assert (tmp_path / "skills/report/asset.bin").read_bytes() == b"new asset"
        assert (tmp_path / source / "asset.bin").read_bytes() == b"original asset"
        seen.append(source)
        return result
    monkeypatch.setattr(ops, "rename_directory", exchange)
    result = upload(uploads, bundle(), tmp_path, "skill_import", previous["version"])
    assert result["version"] != previous["version"] and len(seen) == 1
    backups = list((tmp_path / "skills/.backups").iterdir())
    assert len(backups) == 1 and (backups[0] / "asset.bin").read_bytes() == b"original asset"


def test_edit_during_extraction_wins_over_a_stale_import(modules, tmp_path, monkeypatch):
    ops, uploads = modules
    previous = installed(ops, tmp_path)
    original = ops.write_package
    def write(*args, **kwargs):
        result = original(*args, **kwargs)
        (tmp_path / "skills/report/asset.bin").write_bytes(b"concurrent edit")
        return result
    monkeypatch.setattr(ops, "write_package", write)
    assert upload(uploads, bundle(), tmp_path, "skill_import", previous["version"]) == {"conflict": True}
    assert (tmp_path / "skills/report/asset.bin").read_bytes() == b"concurrent edit"
    assert not list(tmp_path.glob(".skill-import-*"))


@pytest.mark.parametrize('operation', ['edit', 'rename', 'uninstall'])
@pytest.mark.parametrize('winner', ['mutation', 'import'])
def test_publication_and_skill_mutations_serialize_revision_check_and_write(modules, tmp_path, monkeypatch, operation, winner):
    import fcntl
    ops, _ = modules
    previous = installed(ops, tmp_path)
    extracting, resume_extract = threading.Event(), threading.Event()
    validated, resume_mutation = threading.Event(), threading.Event()
    publishing, resume_publish = threading.Event(), threading.Event()
    waiting = threading.Event()
    original_write, original_directory, original_flock = ops.write_package, ops.directory, ops.fcntl.flock
    results, errors = {}, []
    target_name = 'renamed' if operation == 'rename' else 'report'
    edited = SKILL.replace(b'name: report', ('name: ' + target_name).encode()) + b'\nEdited'

    def write(*args, **kwargs):
        if threading.current_thread().name == 'import':
            extracting.set()
            assert resume_extract.wait(5), 'extraction pause timed out'
        return original_write(*args, **kwargs)

    def directory(fd, name, *args, **kwargs):
        if name == '.backups':
            if threading.current_thread().name == 'mutation' and winner == 'mutation':
                validated.set()  # The old revision passed, but the edit/rename/uninstall has not happened.
                assert resume_mutation.wait(5), 'mutation pause timed out'
            elif threading.current_thread().name == 'import' and winner == 'import':
                publishing.set()  # Final revision check passed under the publication lock.
                assert resume_publish.wait(5), 'publication pause timed out'
        return original_directory(fd, name, *args, **kwargs)

    def flock(fd, mode):
        if mode == fcntl.LOCK_EX and threading.current_thread().name == ('import' if winner == 'mutation' else 'mutation'):
            waiting.set()
        return original_flock(fd, mode)

    def execute(name, callback):
        try:
            results[name] = callback()
        except BaseException as error:
            errors.append(error)

    def import_package():
        rootfd = os.open(tmp_path, os.O_RDONLY | os.O_DIRECTORY)
        skillsfd = os.open(tmp_path / 'skills', os.O_RDONLY | os.O_DIRECTORY)
        try:
            return ops.install_personal(rootfd, skillsfd, 'report', previous['version'], {
                'SKILL.md': ops.PackageFile.from_bytes(SKILL + b'\nImported'),
                'asset.bin': ops.PackageFile.from_bytes(b'imported asset'),
            })
        finally:
            os.close(skillsfd)
            os.close(rootfd)

    monkeypatch.setattr(ops, 'write_package', write)
    monkeypatch.setattr(ops, 'directory', directory)
    monkeypatch.setattr(ops.fcntl, 'flock', flock)
    body = {'operation': 'skill_uninstall' if operation == 'uninstall' else 'skill_update',
            'name': 'report', 'version': previous['version'], 'new_name': target_name, 'content': edited.decode()}
    installer = threading.Thread(name='import', target=execute, args=('import', import_package))
    mutation = threading.Thread(name='mutation', target=execute,
                                args=('mutation', lambda: ops.personal(body, str(tmp_path))))
    try:
        installer.start()
        assert extracting.wait(5)
        if winner == 'mutation':
            mutation.start()
            assert validated.wait(5)
            # A separate open description must observe that the mutation owns
            # the same kernel lock used by publication, after its version check.
            checkfd = os.open(tmp_path / 'skills', os.O_RDONLY | os.O_DIRECTORY)
            try:
                with pytest.raises(BlockingIOError):
                    original_flock(checkfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(checkfd)
            resume_extract.set()
            assert waiting.wait(5)
            resume_mutation.set()
        else:
            resume_extract.set()
            assert publishing.wait(5)
            mutation.start()
            assert waiting.wait(5)
            resume_publish.set()
    finally:
        for event in (resume_extract, resume_mutation, resume_publish):
            event.set()
        for worker in (installer, mutation):
            if worker.ident is not None:
                worker.join(8)
                assert not worker.is_alive(), 'concurrent operation did not finish'
    assert not errors, errors
    backups = list((tmp_path / 'skills/.backups').iterdir())
    if winner == 'import':
        assert results['mutation'] == {'conflict': True}
        assert results['import']['id'] == 'report'
        assert (tmp_path / 'skills/report/SKILL.md').read_bytes() == SKILL + b'\nImported'
        assert (tmp_path / 'skills/report/asset.bin').read_bytes() == b'imported asset'
        assert len(backups) == 1
        assert (backups[0] / 'SKILL.md').read_bytes() == SKILL
    else:
        assert results['import'] == {'conflict': True}
        assert results['mutation']['id'] == target_name
        if operation == 'uninstall':
            assert not (tmp_path / 'skills/report').exists()
            assert len(backups) == 1 and (backups[0] / 'SKILL.md').read_bytes() == SKILL
        else:
            assert (tmp_path / 'skills' / target_name / 'SKILL.md').read_bytes() == edited
            assert (tmp_path / 'skills' / target_name / 'asset.bin').read_bytes() == b'original asset'
            if operation == 'rename':
                assert not (tmp_path / 'skills/report').exists()
    assert not list(tmp_path.glob('.skill-import-*'))


def test_new_install_does_not_overwrite_a_target_created_at_publication(modules, tmp_path, monkeypatch):
    ops, uploads = modules
    original = ops.rename_directory
    def publish(*args, **kwargs):
        target = tmp_path / "skills/report"
        target.mkdir()
        (target / "SKILL.md").write_bytes(SKILL)
        (target / "asset.bin").write_bytes(b"concurrent install")
        return original(*args, **kwargs)
    monkeypatch.setattr(ops, "rename_directory", publish)
    assert upload(uploads, bundle(), tmp_path, "skill_import") == {"conflict": True}
    assert (tmp_path / "skills/report/asset.bin").read_bytes() == b"concurrent install"
    assert not list(tmp_path.glob(".skill-import-*"))


def test_new_install_sync_failure_removes_only_the_new_tree(modules, tmp_path, monkeypatch):
    ops, uploads = modules
    original_publish, original_sync = ops.rename_directory, ops.os.fsync
    state = {"published": False, "failed": False}
    def publish(*args, **kwargs):
        result = original_publish(*args, **kwargs)
        state["published"] = True
        return result
    def sync(fd):
        if state["published"] and not state["failed"]:
            state["failed"] = True
            raise OSError("injected first publication failure")
        return original_sync(fd)
    monkeypatch.setattr(ops, "rename_directory", publish)
    monkeypatch.setattr(ops.os, "fsync", sync)
    with pytest.raises(OSError, match="first publication"):
        upload(uploads, bundle(), tmp_path, "skill_import")
    assert not (tmp_path / "skills/report").exists()
    assert not list(tmp_path.glob(".skill-import-*"))


def test_failed_global_publication_cleans_readonly_staging(modules, tmp_path, monkeypatch):
    ops, _ = modules
    payload = {"packages": [{"name": "report", "archive": base64.b64encode(bundle({
        "SKILL.md": SKILL, "scripts/nested/helper.py": b"print('ok')",
    })).decode()}]}
    def fail(*args, **kwargs):
        raise OSError("injected global publication failure")
    monkeypatch.setattr(ops, "rename_directory", fail)
    with pytest.raises(OSError, match="global publication"):
        ops.global_install(payload, str(tmp_path))
    assert list(tmp_path.iterdir()) == []


def test_global_content_address_and_readonly_publication_remain_compatible(modules, tmp_path):
    ops, _ = modules
    entries = {"SKILL.md": SKILL, "asset.bin": b"new asset"}
    payload = {"packages": [{"name": "report", "archive": base64.b64encode(bundle(entries)).decode()}]}
    digest = hashlib.sha256()
    for path, data in sorted(entries.items()):
        digest.update(path.encode() + b"\0" + hashlib.sha256(data).digest())
    first = ops.global_install(payload, str(tmp_path))
    assert ops.global_install(payload, str(tmp_path)) == first
    published = Path(first["skills"][0]["path"])
    assert published.name == digest.hexdigest()
    assert published.stat().st_mode & 0o777 == 0o555
    assert (published / "asset.bin").stat().st_mode & 0o777 == 0o444
    assert not list(tmp_path.glob(".global-*"))


@pytest.mark.parametrize("transport", ["binary", "json", "global"])
def test_large_assets_import_with_bounded_process_memory(tmp_path, transport):
    archive_path = tmp_path / "large.zip"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("SKILL.md", SKILL)
        with archive.open("asset.bin", "w") as asset:
            chunk = b"x" * (1024 * 1024)
            for _ in range(256):
                asset.write(chunk)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    script = r'''
import base64, io, json, resource, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import binary_upload, resource_ops
raw = Path(sys.argv[2]).read_bytes()
root, transport = sys.argv[3:5]
resource.setrlimit(resource.RLIMIT_AS, (128 * 1024 * 1024, 128 * 1024 * 1024))
if transport == 'binary':
    metadata = {'operation': 'skill_inspect', 'archive': True, 'name': 'report', 'version': None,
                'files': [{'path': 'large.zip', 'size': len(raw)}]}
    def call():
        return binary_upload.run(io.BytesIO(json.dumps(metadata).encode() + b'\n' + raw), 'personal-resources', root)
    assert call()['content'].startswith('---')
    metadata['operation'] = 'skill_import'
    call()
    published = Path(root) / 'skills/report'
elif transport == 'json':
    payload = {'operation': 'skill_inspect', 'archive': base64.b64encode(raw).decode()}
    assert resource_ops.personal(payload, root)['content'].startswith('---')
    payload.update(operation='skill_import', name='report')
    resource_ops.personal(payload, root)
    published = Path(root) / 'skills/report'
else:
    payload = {'packages': [{'name': 'report', 'archive': base64.b64encode(raw).decode()}]}
    published = Path(resource_ops.global_install(payload, root)['skills'][0]['path'])
assert (published / 'asset.bin').stat().st_size == 256 * 1024 * 1024
# Linux ru_maxrss can retain the parent's high-water mark across exec.
# VmHWM measures this import process, independently of the preceding test suite.
peak_rss_kib = next(int(line.split()[1]) for line in Path('/proc/self/status').read_text().splitlines()
                    if line.startswith('VmHWM:'))
print(json.dumps({'peak_rss_kib': peak_rss_kib}))
'''
    result = subprocess.run([sys.executable, "-B", "-c", script, str(Path(__file__).parents[1]),
                             str(archive_path), str(workspace), transport], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["peak_rss_kib"] < 128 * 1024
