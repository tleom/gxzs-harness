"""Bounded binary uploads. The first line contains metadata, followed by exact file bytes."""
from contextlib import contextmanager, ExitStack
import json
import tempfile
import zipfile

from file_ops import upload_stream
from resource_ops import MAX_UPLOAD, PackageFile, file_slice, personal


def read_header(source):
    line = source.readline(128 * 1024)
    if not line.endswith(b'\n'):
        raise ValueError('文件上传元数据无效')
    payload = json.loads(line)
    if not isinstance(payload, dict):
        raise ValueError('文件上传元数据无效')
    return payload


def copy_exact(source, target, size):
    if type(size) is not int or not 0 <= size <= MAX_UPLOAD:
        raise ValueError('文件大小无效，最大 100 MiB')
    remaining = size
    while remaining:
        chunk = source.read(min(64 * 1024, remaining))
        if not chunk:
            raise ValueError('文件上传不完整')
        target.write(chunk)
        remaining -= len(chunk)


def package_size(payload):
    files = payload.get('files')
    if not isinstance(files, list) or not files:
        raise ValueError('技能包文件列表不能为空')
    total = 0
    for file in files:
        if not isinstance(file, dict) or not isinstance(file.get('path'), str) or type(file.get('size')) is not int or file['size'] < 0:
            raise ValueError('技能包文件信息无效')
        total += file['size']
    if total > MAX_UPLOAD:
        raise ValueError('技能包最大 100 MiB')
    return total


@contextmanager
def package_files(payload, staged):
    """Open a validated, already spooled package without copying its bytes again."""
    files = payload['files']
    with ExitStack() as stack:
        entries = {}
        staged.seek(0)
        if payload.get('archive') is True:
            if len(files) != 1:
                raise ValueError('请选择一个 ZIP 技能包')
            archive = stack.enter_context(zipfile.ZipFile(staged))
            # Validate member metadata first; assets stream to the unpublished tree.
            entries = read_archive(archive)
        else:
            offset = 0
            for file in files:
                if file['path'] in entries:
                    raise ValueError('技能包包含重复路径')
                entries[file['path']] = PackageFile(file['size'],
                    lambda offset=offset, size=file['size']: file_slice(staged, offset, size))
                offset += file['size']
        yield entries


def run(source, action, root='/workspace', *, stage_only=False):
    payload = read_header(source)
    if action == 'files':
        if payload.get('operation') != 'upload':
            raise ValueError('文件上传操作无效')
        return upload_stream(payload, source, root=root)
    if action != 'personal-resources' or payload.get('operation') not in {'skill_inspect', 'skill_import', 'skill_stage'}:
        raise ValueError('技能包上传操作无效')
    if stage_only and payload['operation'] == 'skill_import':
        import uuid
        payload.update(operation='skill_stage', import_id=uuid.uuid4().hex)
    total = package_size(payload)
    if payload['operation'] in {'skill_stage', 'skill_import'}:
        from skill_imports import stage, commit_legacy
        import uuid
        payload.setdefault('import_id', uuid.uuid4().hex)
        staged = stage(payload, source, root=root)
        if payload['operation'] == 'skill_stage':
            return staged
        return commit_legacy(payload, staged['import_id'], root=root)
    with tempfile.TemporaryFile() as staged:
        copy_exact(source, staged, total)
        if source.read(1):
            raise ValueError('文件大小与声明不一致')
        staged.flush()
        with package_files(payload, staged) as entries:
            return personal(payload, root=root, supplied=entries)


def read_archive(archive):
    from resource_ops import archive_members
    return archive_members(archive)
