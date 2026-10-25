"""Prepare a bounded file/directory snapshot on disk and stream it to stdout."""
import hashlib
import json
import os
import stat
import tempfile
import zipfile

from file_ops import parent_fd, file_identity, temporary_parent, share_identity

MAX_DIRECTORY_BYTES = 1024 * 1024 * 1024


def entries(fd, prefix=''):
    for name in sorted(os.listdir(fd)):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        path = prefix + name
        if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
            raise ValueError('目录包含链接或特殊文件，无法打包')
        yield path, info
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                yield from entries(child, path + '/')
            finally:
                os.close(child)


def stamp(digest, path, info):
    digest.update(json.dumps([path, file_identity(info)], ensure_ascii=True).encode() + b'\n')


def copy_file(fd, name, output, expected, digest=None, expected_share=None):
    if not stat.S_ISREG(expected.st_mode):
        raise ValueError('只能下载普通文件')
    item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(item, 'rb') as source:
        if file_identity(os.fstat(source.fileno())) != file_identity(expected):
            raise ValueError('文件已改变，请重试下载')
        if expected_share is not None and share_identity(source.fileno()) != expected_share:
            raise FileNotFoundError('分享文件已改变')
        count = 0
        while chunk := source.read(64 * 1024):
            count += len(chunk)
            if count > expected.st_size:
                raise ValueError('文件已改变，请重试下载')
            if digest is not None:
                digest.update(chunk)
            output.write(chunk)
        if count != expected.st_size or file_identity(os.fstat(source.fileno())) != file_identity(expected):
            raise ValueError('文件已改变，请重试下载')


def write_download(payload, output, root='/workspace'):
    path = payload.get('path')
    if not isinstance(path, str) or path in {'.', 'conversations'}:
        raise ValueError('请选择具体文件或对话目录')
    temporary = path.startswith('/tmp/')
    parent, name = temporary_parent(path) if temporary else parent_fd(root, path)
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if temporary and not stat.S_ISREG(info.st_mode):
            raise ValueError('Only regular files can be previewed')
        digest = hashlib.sha256()
        with tempfile.TemporaryFile(dir=root) as staged:
            if stat.S_ISREG(info.st_mode):
                copy_file(parent, name, staged, info, digest, payload.get('share_identity'))
                kind = 'file'
            elif stat.S_ISDIR(info.st_mode):
                if payload.get('share_identity') is not None:
                    raise FileNotFoundError('分享文件已改变')
                kind = 'directory'
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    total = 0
                    with zipfile.ZipFile(staged, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                        for relative, entry in entries(child):
                            stamp(digest, relative, entry)
                            if stat.S_ISDIR(entry.st_mode):
                                archive.writestr(relative + '/', b'')
                                continue
                            total += entry.st_size
                            if total > MAX_DIRECTORY_BYTES:
                                raise ValueError('目录文件合计最大 1 GiB')
                            fd, file_name = parent_fd(child, relative)
                            try:
                                with archive.open(relative, 'w', force_zip64=True) as target:
                                    copy_file(fd, file_name, target, entry)
                            finally:
                                os.close(fd)
                    after = hashlib.sha256()
                    for relative, entry in entries(child):
                        stamp(after, relative, entry)
                    if after.digest() != digest.digest():
                        raise ValueError('目录已改变，请重试下载')
                finally:
                    os.close(child)
                name += '.zip'
            else:
                raise ValueError('不支持下载链接或特殊文件')
            size = staged.tell()
            header = {'name': name, 'kind': kind, 'size': size, 'version': digest.hexdigest()}
            if payload.get('share_identity') is not None:
                header['share_identity'] = payload['share_identity']
            output.write(json.dumps(header).encode() + b'\n')
            output.flush()
            staged.seek(0)
            while chunk := staged.read(64 * 1024):
                output.write(chunk)
            output.flush()
    finally:
        os.close(parent)
