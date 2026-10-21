"""Bounded binary uploads. The first line contains metadata, followed by exact file bytes."""
import io
import json
import tempfile
import zipfile

from file_ops import upload_stream
from resource_ops import MAX_FILES, MAX_PACKAGE, personal


def read_header(source):
    line = source.readline(128 * 1024)
    if not line.endswith(b'\n'):
        raise ValueError('文件上传元数据无效')
    payload = json.loads(line)
    if not isinstance(payload, dict):
        raise ValueError('文件上传元数据无效')
    return payload


def copy_exact(source, target, size):
    if type(size) is not int or not 0 <= size <= MAX_PACKAGE:
        raise ValueError('文件大小无效，最大 100 MiB')
    remaining = size
    while remaining:
        chunk = source.read(min(64 * 1024, remaining))
        if not chunk:
            raise ValueError('文件上传不完整')
        target.write(chunk)
        remaining -= len(chunk)


def run(source, action, root='/workspace'):
    payload = read_header(source)
    if action == 'files':
        if payload.get('operation') != 'upload':
            raise ValueError('文件上传操作无效')
        return upload_stream(payload, source, root=root)
    if action != 'personal-resources' or payload.get('operation') not in {'skill_inspect', 'skill_import'}:
        raise ValueError('技能包上传操作无效')
    files = payload.get('files')
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError('技能包最多包含 200 个文件')
    total = 0
    for file in files:
        if not isinstance(file, dict) or not isinstance(file.get('path'), str) or type(file.get('size')) is not int or file['size'] < 0:
            raise ValueError('技能包文件信息无效')
        total += file['size']
    if total > MAX_PACKAGE:
        raise ValueError('技能包最大 100 MiB')
    entries = {}
    if payload.get('archive') is True:
        if len(files) != 1:
            raise ValueError('请选择一个 ZIP 技能包')
        with tempfile.TemporaryFile() as staged:
            copy_exact(source, staged, total)
            staged.seek(0)
            with zipfile.ZipFile(staged) as archive:
                # Reuse the same path, type and expanded-size checks as JSON imports.
                entries = read_archive(archive)
    else:
        for file in files:
            if file['path'] in entries:
                raise ValueError('技能包包含重复路径')
            target = io.BytesIO()
            copy_exact(source, target, file['size'])
            entries[file['path']] = target.getvalue()
    if source.read(1):
        raise ValueError('文件大小与声明不一致')
    return personal(payload, root=root, supplied=entries)


def read_archive(archive):
    from resource_ops import archive_members
    return archive_members(archive)
