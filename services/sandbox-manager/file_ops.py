"""Executed as the sandbox user. All traversal uses directory descriptors, never symlinks."""
import base64
import bisect
import ctypes
import errno
import fcntl
import hashlib
import io
import json
import os
import shutil
import stat
import sys
import uuid

MAX_BYTES = 100 * 1024 * 1024
MAX_TREE_BYTES = 1024 * 1024 * 1024
MAX_MANIFEST_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MANIFEST_TREE_BYTES = 10 * 1024 * 1024 * 1024
TEMP_PATH = '/tmp'
TEMP_STORAGE_ROOT = '/var/lib/gxzs-tmp'
SHARE_IDENTITY_ATTRIBUTE = 'user.gxzs.share-identity'


def share_identity(fd):
    """An inode-bound marker cannot be inherited by copying file attributes."""
    try:
        marker = os.getxattr(fd, SHARE_IDENTITY_ATTRIBUTE).decode().split(':')
    except OSError as error:
        if error.errno == errno.ENODATA:
            return None
        raise
    except UnicodeDecodeError:
        return None
    info = os.fstat(fd)
    if (len(marker) == 3 and len(marker[0]) == 32
            and all(char in '0123456789abcdef' for char in marker[0])
            and marker[1:] == [str(info.st_dev), str(info.st_ino)]):
        return marker[0]
    return None


def set_share_identity(fd, identity):
    info = os.fstat(fd)
    os.setxattr(fd, SHARE_IDENTITY_ATTRIBUTE,
                f'{identity}:{info.st_dev}:{info.st_ino}'.encode())


def temporary_parent(path, *, missing_ok=False):
    """Read only the current scratch generation, never arbitrary absolute paths."""
    if not isinstance(path, str) or not path.startswith('/tmp/'):
        raise ValueError('Invalid file path')
    if os.path.islink(TEMP_PATH):
        if os.readlink(TEMP_PATH) != TEMP_STORAGE_ROOT + '/current':
            raise ValueError('Invalid temporary root')
        base = os.open(TEMP_STORAGE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            root = os.open('current', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
        finally:
            os.close(base)
    else:
        # Existing images retain a normal /tmp until their sandbox is upgraded.
        root = os.open(TEMP_PATH, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        return parent_fd(root, path[len('/tmp/'):], missing_ok=missing_ok)
    finally:
        os.close(root)


def temporary_file(payload):
    operation, path = payload.get('operation'), payload.get('path')
    if operation not in {'get', 'stat'}:
        raise ValueError('Temporary files are read-only')
    fd, name = temporary_parent(path, missing_ok=operation == 'stat')
    if fd is None:
        return {'path': path, 'kind': 'missing'}
    try:
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            if operation == 'stat':
                return {'path': path, 'kind': 'missing'}
            raise
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Only regular files can be previewed')
        if operation == 'stat':
            return entry_metadata(fd, name, path, info)
        maximum = payload.get('max_bytes', MAX_BYTES)
        if type(maximum) is not int or not 0 < maximum <= MAX_BYTES:
            raise ValueError('Invalid file read limit')
        data = read_file(fd, name, maximum)
        if data is None:
            raise FileNotFoundError(path)
        return {'data': base64.b64encode(data).decode(), 'version': version(data), 'name': name}
    finally:
        os.close(fd)


def parent_fd(root, path, *, missing_ok=False):
    parts = path.split("/")
    if not path or any(part in ("", ".", "..") or "\\" in part or "\x00" in part for part in parts):
        raise ValueError("Invalid file path")
    fd = os.dup(root) if isinstance(root, int) else os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd, parts[-1]
    except FileNotFoundError:
        os.close(fd)
        if missing_ok:
            return None, parts[-1]
        raise
    except BaseException:
        os.close(fd)
        raise


def read_file(fd, name, max_bytes=MAX_BYTES):
    try:
        item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return None
    with os.fdopen(item, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            raise ValueError("Only regular files up to %d MiB are supported" % (max_bytes // (1024 * 1024)))
        data = stream.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("File exceeds %d MiB" % (max_bytes // (1024 * 1024)))
        return data


def version(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def large_file_version(info):
    # An opaque deletion token: large files never need to be loaded or hashed
    # into memory just to remove them. Small file upload tokens stay unchanged.
    return version(json.dumps(('metadata-v1', *file_identity(info))).encode())


def conflict(message="文件已改变，请刷新后重试"):
    return {"conflict": True, "code": "FILE_VERSION_CONFLICT", "message": message}


def delete_file(fd, name, payload):
    try:
        item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return {"deleted": True} if "version" in payload and payload["version"] is None else conflict()
    with os.fdopen(item, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("Only regular files can be deleted")
        if before.st_size > MAX_BYTES:
            fingerprint = large_file_version(before)
        else:
            data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                return conflict()
            fingerprint = version(data)
        if payload.get("version") != fingerprint or file_identity(before) != file_identity(os.fstat(stream.fileno())):
            return conflict()
        try:
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return conflict()
        if file_identity(before) != file_identity(current):
            return conflict()
        os.unlink(name, dir_fd=fd)
        os.fsync(fd)
        return {"deleted": True}


def tree_entries(fd, prefix="", result=None):
    """Fingerprint metadata without following links or reading every file on listing."""
    top = result is None
    result = [] if top else result
    with os.scandir(fd) as entries:
        for entry in entries:
            name = entry.name
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            path = prefix + name
            result.append((path, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ino))
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    tree_entries(child, path + "/", result)
                finally:
                    os.close(child)
    if top:
        # Preserve the original sorted, depth-first fingerprint order.
        result.sort(key=lambda item: item[0].split('/'))
    return result


def hash_file(fd, name, expected_size):
    if expected_size > MAX_MANIFEST_FILE_BYTES:
        raise ValueError("Workspace file exceeds migration manifest limits")
    item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    digest = hashlib.sha256()
    with os.fdopen(item, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected_size:
            raise ValueError("Workspace changed during migration manifest")
        count = 0
        while chunk := stream.read(64 * 1024):
            count += len(chunk)
            if count > expected_size:
                raise ValueError('File changed while hashing')
            digest.update(chunk)
        if count != expected_size or file_identity(os.fstat(stream.fileno())) != file_identity(info):
            raise ValueError('File changed while hashing')
    return digest.hexdigest()


def tree_manifest(fd, prefix="", result=None, *, budget=None):
    result = [] if result is None else result
    # Share the byte count across recursion without rescanning all prior files.
    budget = {"size": sum(item["size"] for item in result)} if budget is None else budget
    for name in sorted(os.listdir(fd)):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        path = prefix + name
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                tree_manifest(child, path + "/", result, budget=budget)
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode):
            if budget["size"] + info.st_size > MAX_MANIFEST_TREE_BYTES:
                raise ValueError("Workspace exceeds migration manifest limits")
            result.append({"path": path, "size": info.st_size, "sha256": hash_file(fd, name, info.st_size)})
            budget["size"] += info.st_size
        else:
            result.append({"path": path, "size": info.st_size, "kind": "blocked", "sha256": None})
            budget["size"] += info.st_size
    return result


def tree_version(fd):
    return entries_version(tree_entries(fd))


def entries_version(entries):
    # Preserve the byte-for-byte token format without a second full JSON copy.
    digest = hashlib.sha256()
    digest.update(b'[')
    encoder = json.JSONEncoder(separators=(",", ":"))
    for index, entry in enumerate(entries):
        if index:
            digest.update(b',')
        digest.update(encoder.encode(entry).encode())
    digest.update(b']')
    return digest.hexdigest()


def entry_metadata(fd, name, path, info, *, shallow=False):
    kind = "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "blocked"
    # Stable across atomic renames, unlike the content/deletion version's ctime.
    identity = version(json.dumps((info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))).encode())
    if shallow:
        return {"name": name, "path": path, "kind": kind, "size": info.st_size,
                "modified": info.st_mtime, "version": None, "identity": identity,
                "downloadable": path != "conversations" and kind in {"directory", "file"}}
    fingerprint = hash_file(fd, name, info.st_size) if kind == "file" and info.st_size <= MAX_BYTES else None
    downloadable = kind == "file"
    details = {}
    if kind == "file" and info.st_size > MAX_BYTES:
        fingerprint = large_file_version(info)
    if kind == "directory":
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            entries = tree_entries(child)
            fingerprint = entries_version(entries)
            details = {
                'content_size': sum(size for _, mode, size, _, _ in entries if stat.S_ISREG(mode)),
                'file_count': sum(stat.S_ISREG(mode) for _, mode, _, _, _ in entries),
                'directory_count': sum(stat.S_ISDIR(mode) for _, mode, _, _, _ in entries),
            }
            downloadable = (
                all(stat.S_ISDIR(mode) or stat.S_ISREG(mode)
                    for _, mode, size, _, _ in entries)
                and sum(size for _, mode, size, _, _ in entries if stat.S_ISREG(mode)) <= MAX_TREE_BYTES
            )
        finally:
            os.close(child)
    return {"name": name, "path": path, "kind": kind, "size": info.st_size,
            "modified": info.st_mtime, "version": fingerprint, "identity": identity,
            "downloadable": path != 'conversations' and downloadable, **details}


def remove_contents(fd):
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                remove_contents(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=fd)
        else:
            os.unlink(name, dir_fd=fd)


def rename_new(source_fd, source, target_fd, target):
    """Linux atomic rename without replacing an existing file or directory."""
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source_fd, os.fsencode(source), target_fd, os.fsencode(target), 1):
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError('目标目录已存在同名文件或文件夹')
        raise OSError(code, os.strerror(code))


def allocate_directory(fd, name, payload, path):
    """Replay one allocation after a lost response or a crash around publication."""
    identity = payload['allocation_id']
    if not isinstance(identity, str) or str(uuid.UUID(identity)) != identity:
        raise ValueError('Invalid directory allocation identity')
    attribute = 'user.gxzs.directory-allocation'
    temporary = '.allocation-' + identity
    def marker(child):
        info = os.fstat(child)
        return f'{identity}:{info.st_dev}:{info.st_ino}'.encode()
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        for candidate in os.listdir(fd):
            if candidate == temporary:
                continue
            try:
                child = os.open(candidate, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as error:
                if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                    continue
                raise
            try:
                try:
                    if os.getxattr(child, attribute) == marker(child):
                        return {'path': os.path.join(os.path.dirname(path), candidate)}
                except OSError as error:
                    if error.errno != errno.ENODATA:
                        raise
            finally:
                os.close(child)
        try:
            os.mkdir(temporary, mode=0o700, dir_fd=fd)
        except FileExistsError:
            pass
        child = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            try:
                recorded = os.getxattr(child, attribute)
            except OSError as error:
                if error.errno != errno.ENODATA:
                    raise
                if os.listdir(child):
                    raise ValueError('Directory allocation path is occupied')
                recorded = marker(child)
                os.setxattr(child, attribute, recorded)
            if recorded != marker(child):
                raise ValueError('Directory allocation identity changed')
            os.fsync(child)
        finally:
            os.close(child)
        original, suffix = name, 1
        while True:
            try:
                rename_new(fd, temporary, fd, name)
                os.fsync(fd)
                return {'path': os.path.join(os.path.dirname(path), name)}
            except FileExistsError:
                suffix += 1
                name = f'{original}-{suffix}'
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)


def copy_entry(source_fd, source, target_fd, target):
    info = os.stat(source, dir_fd=source_fd, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        original = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source_fd)
        try:
            os.mkdir(target, mode=0o700, dir_fd=target_fd)
            copied = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target_fd)
            try:
                for name in os.listdir(original):
                    copy_entry(original, name, copied, name)
                os.fsync(copied)
            finally:
                os.close(copied)
        finally:
            os.close(original)
    elif stat.S_ISREG(info.st_mode):
        source_file = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
        with os.fdopen(source_file, 'rb') as original:
            before = os.fstat(original.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ValueError('只支持普通文件和文件夹')
            target_file = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_fd)
            with os.fdopen(target_file, 'wb') as copied:
                shutil.copyfileobj(original, copied, 1024 * 1024)
                copied.flush()
                os.fchmod(copied.fileno(), stat.S_IMODE(before.st_mode))
                os.fsync(copied.fileno())
            if file_identity(before) != file_identity(os.fstat(original.fileno())):
                raise ValueError('文件在复制期间发生变化，请重试')
    else:
        raise ValueError('只支持普通文件和文件夹')


def transfer(payload, root):
    source, destination = payload.get('path'), payload.get('destination')
    operation = payload['operation']
    if not isinstance(source, str) or not isinstance(destination, str):
        raise ValueError('文件路径无效')
    if source in {'.', 'conversations', 'skills', 'mcp'} or destination in {'.', 'conversations', 'skills', 'mcp'}:
        raise ValueError('不能复制、移动或替换工作区的固定目录')
    source_fd, source_name = parent_fd(root, source)
    try:
        target_fd, target_name = parent_fd(root, destination)
        try:
            if destination == source or destination.startswith(source + '/'):
                raise ValueError('目标不能是原位置或源文件夹的子目录')
            info = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError('只支持普通文件和文件夹')
            try:
                os.stat(target_name, dir_fd=target_fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                raise FileExistsError('目标目录已存在同名文件或文件夹')
            if operation == 'move':
                rename_new(source_fd, source_name, target_fd, target_name)
                os.fsync(source_fd)
            else:
                # Publish the completed copy once; an interrupted copy never appears as the destination.
                temporary = '.copy-' + uuid.uuid4().hex
                try:
                    copy_entry(source_fd, source_name, target_fd, temporary)
                    rename_new(target_fd, temporary, target_fd, target_name)
                finally:
                    try:
                        staged = os.stat(temporary, dir_fd=target_fd, follow_symlinks=False)
                    except FileNotFoundError:
                        staged = None
                    if staged is not None:
                        if stat.S_ISDIR(staged.st_mode):
                            child = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=target_fd)
                            try:
                                remove_contents(child)
                            finally:
                                os.close(child)
                            os.rmdir(temporary, dir_fd=target_fd)
                        else:
                            os.unlink(temporary, dir_fd=target_fd)
            os.fsync(target_fd)
            current = os.stat(target_name, dir_fd=target_fd, follow_symlinks=False)
            return entry_metadata(target_fd, target_name, destination, current, shallow=True)
        finally:
            os.close(target_fd)
    finally:
        os.close(source_fd)


def operate(payload, root="/workspace"):
    operation = payload["operation"]
    path = payload.get("path", ".")
    if operation in {'copy', 'move'}:
        return transfer(payload, root)
    if isinstance(path, str) and path.startswith('/tmp/'):
        return temporary_file(payload)
    if operation == "delete" and path in {"mcp", "skills"}:
        raise ValueError("Resource directories cannot be deleted from file management")
    if path in {".", "conversations"} and operation not in {"list", "manifest", "stat"}:
        raise ValueError("The workspace root can only be listed")
    if operation == 'upload':
        data = base64.b64decode(payload['data'], validate=True)
        return upload_stream({**payload, 'size': len(data)}, io.BytesIO(data), root)
    if path == ".":
        fd, name = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), "."
    else:
        fd, name = parent_fd(root, path, missing_ok=operation == "stat")
        if fd is None:
            return {"path": path, "kind": "missing"}
    try:
        if operation == "mkdir":
            if payload.get('allocation_id') is not None:
                if payload.get('unique') is not True:
                    raise ValueError('Allocation requires a unique directory')
                return allocate_directory(fd, name, payload, path)
            original, suffix = name, 1
            while True:
                try:
                    os.mkdir(name, mode=0o700, dir_fd=fd)
                    break
                except FileExistsError:
                    if payload.get('exclusive') is True:
                        raise ValueError('目标目录已存在同名文件或文件夹')
                    if payload.get('unique') is not True:
                        break
                    suffix += 1
                    name = f'{original}-{suffix}'
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(child)
            return {"path": os.path.join(os.path.dirname(path), name)}
        if operation == "manifest":
            if path != ".":
                raise ValueError("Migration manifest is available only for the workspace root")
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                files = tree_manifest(child)
                return {"path": path, "version": tree_version(child), "files": files,
                        "items": len(files), "size": sum(item["size"] for item in files)}
            finally:
                os.close(child)
        if operation == "list":
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                result = []
                names = sorted(os.listdir(child))
                snapshot = hashlib.sha256(json.dumps(names, ensure_ascii=True).encode()).hexdigest()
                cursor = payload.get('cursor')
                offset = 0
                if cursor:
                    if not isinstance(cursor, str) or len(cursor) > 2048:
                        raise ValueError('目录分页参数无效')
                    try:
                        previous = json.loads(base64.urlsafe_b64decode(cursor).decode())
                        if previous['snapshot'] != snapshot:
                            return conflict('目录已改变，请刷新后重试')
                        offset = bisect.bisect_right(names, previous['after'])
                    except (ValueError, TypeError, KeyError) as error:
                        raise ValueError('目录分页参数无效') from error
                page = names[offset:offset + 2000]
                for entry in page:
                    info = os.stat(entry, dir_fd=child, follow_symlinks=False)
                    result.append(entry_metadata(child, entry, ("" if path == "." else path + "/") + entry, info, shallow=True))
                next_cursor = base64.urlsafe_b64encode(json.dumps({'after': page[-1], 'snapshot': snapshot}).encode()).decode() if offset + len(page) < len(names) else None
                return {"path": path, "entries": result, 'next_cursor': next_cursor, 'total': len(names)}
            finally:
                os.close(child)
        try:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            info = None
        if operation == "stat":
            if info is None:
                return {"path": path, "kind": "missing"}
            result = entry_metadata(fd, name, path, info)
            if 'bind_share' in payload and stat.S_ISREG(info.st_mode):
                item = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    if file_identity(os.fstat(item)) != file_identity(info):
                        return conflict()
                    identity = share_identity(item)
                    if identity is None and payload['bind_share']:
                        identity = uuid.uuid4().hex
                        set_share_identity(item, identity)
                    result['share_identity'] = identity
                finally:
                    os.close(item)
            return result
        if info is not None and stat.S_ISDIR(info.st_mode):
            if operation == "get":
                raise ValueError("Only regular files can be read; use streaming download for folders")
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                fingerprint = tree_version(child)
                if operation != "delete":
                    raise ValueError("A folder cannot be overwritten by an uploaded file")
                if payload.get("version") != fingerprint:
                    return conflict()
                remove_contents(child)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=fd)
            return {"deleted": True}
        if operation == "delete":
            return delete_file(fd, name, payload)
        if operation != 'get':
            raise ValueError("Unknown operation")
        max_bytes = payload.get("max_bytes", MAX_BYTES)
        if type(max_bytes) is not int or not 0 < max_bytes <= MAX_BYTES:
            raise ValueError("Invalid file read limit")
        old = read_file(fd, name, max_bytes)
        if old is None:
            raise FileNotFoundError(path)
        return {"data": base64.b64encode(old).decode(), "version": version(old), "name": name}
    finally:
        os.close(fd)


def upload_stream(payload, source, root="/workspace"):
    """Write bounded chunks atomically after checking the current file version."""
    path = payload.get('path')
    size = payload.get('size')
    if not isinstance(path, str) or path in {'.', 'conversations'}:
        raise ValueError('文件路径无效')
    if type(size) is not int or not 0 <= size <= MAX_BYTES:
        raise ValueError('单个文件最大 100 MiB')
    fd, name = parent_fd(root, path)
    temporary = '.upload-' + uuid.uuid4().hex
    try:
        try:
            old = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            old = None
        if old is not None and (not stat.S_ISREG(old.st_mode) or old.st_size > MAX_BYTES):
            raise ValueError('只能覆盖 100 MiB 以内的普通文件')
        previous = hash_file(fd, name, old.st_size) if old else None
        if 'version' not in payload or payload['version'] != previous:
            return conflict()
        digest = hashlib.sha256()
        target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(target, 'wb') as output:
            remaining = size
            while remaining:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    raise ValueError('文件上传不完整')
                digest.update(chunk)
                output.write(chunk)
                remaining -= len(chunk)
            if source.read(1):
                raise ValueError('文件大小与声明不一致')
            output.flush()
            if old is not None:
                os.fchmod(output.fileno(), stat.S_IMODE(old.st_mode) & 0o777)
                original = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    identity = share_identity(original)
                    if identity is not None:
                        set_share_identity(output.fileno(), identity)
                finally:
                    os.close(original)
            os.fsync(output.fileno())
        # Recheck after receiving bytes; a user process may have edited the file.
        try:
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if (file_identity(current) if current else None) != (file_identity(old) if old else None):
            return conflict()
        os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
        return {'path': path, 'version': digest.hexdigest()}
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


if __name__ == "__main__":
    try:
        print(json.dumps(operate(json.load(sys.stdin))))
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)
