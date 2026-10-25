"""Executed as the sandbox user. All traversal uses directory descriptors, never symlinks."""
import base64
import bisect
import hashlib
import io
import json
import os
import stat
import sys
import uuid
import zipfile

MAX_BYTES = 100 * 1024 * 1024
MAX_TREE_BYTES = 1024 * 1024 * 1024
MAX_MANIFEST_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MANIFEST_TREE_BYTES = 10 * 1024 * 1024 * 1024
TEMP_PATH = '/tmp'
TEMP_STORAGE_ROOT = '/var/lib/gxzs-tmp'


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
    if shallow:
        return {"name": name, "path": path, "kind": kind, "size": info.st_size,
                "modified": info.st_mtime, "version": None,
                "downloadable": path != "conversations" and kind in {"directory", "file"}}
    fingerprint = hash_file(fd, name, info.st_size) if kind == "file" and info.st_size <= MAX_BYTES else None
    downloadable = kind == "file"
    if kind == "file" and info.st_size > MAX_BYTES:
        fingerprint = large_file_version(info)
    if kind == "directory":
        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            entries = tree_entries(child)
            fingerprint = entries_version(entries)
            downloadable = (
                all(stat.S_ISDIR(mode) or stat.S_ISREG(mode)
                    for _, mode, size, _, _ in entries)
                and sum(size for _, mode, size, _, _ in entries if stat.S_ISREG(mode)) <= MAX_TREE_BYTES
            )
        finally:
            os.close(child)
    return {"name": name, "path": path, "kind": kind, "size": info.st_size,
            "modified": info.st_mtime, "version": fingerprint, "downloadable": downloadable}


def legacy_archive(fd):
    """Keep pre-streaming Hosts working during Manager-first rolling upgrades."""
    entries = tree_entries(fd)
    if sum(size for _, mode, size, _, _ in entries if stat.S_ISREG(mode)) > 50 * 1024 * 1024:
        raise ValueError('Legacy directory download exceeds 50 MiB; use streaming download')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path, mode, _, _, _ in entries:
            if stat.S_ISDIR(mode):
                archive.writestr(path + '/', b'')
            elif stat.S_ISREG(mode):
                parent, name = parent_fd(fd, path)
                try:
                    archive.writestr(path, read_file(parent, name, 50 * 1024 * 1024))
                finally:
                    os.close(parent)
            else:
                raise ValueError('Folder contains an unsupported link or special file')
    return output.getvalue()


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


def operate(payload, root="/workspace"):
    operation = payload["operation"]
    path = payload.get("path", ".")
    if isinstance(path, str) and path.startswith('/tmp/'):
        return temporary_file(payload)
    if operation == "delete" and path in {"mcp", "skills"}:
        raise ValueError("Resource directories cannot be deleted from file management")
    if path in {".", "conversations"} and operation not in {"list", "manifest"}:
        raise ValueError("The workspace root can only be listed")
    if path == ".":
        fd, name = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), "."
    else:
        fd, name = parent_fd(root, path, missing_ok=operation == "stat")
        if fd is None:
            return {"path": path, "kind": "missing"}
    try:
        if operation == "mkdir":
            try:
                os.mkdir(name, mode=0o700, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(child)
            return {"path": path}
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
            return entry_metadata(fd, name, path, info)
        if info is not None and stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                fingerprint = tree_version(child)
                if operation == "get":
                    data = legacy_archive(child)
                    if fingerprint != tree_version(child):
                        return conflict()
                    return {"data": base64.b64encode(data).decode(), "version": fingerprint,
                            "kind": "directory", "name": name + ".zip"}
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
        max_bytes = payload.get("max_bytes", MAX_BYTES) if operation == "get" else MAX_BYTES
        if type(max_bytes) is not int or not 0 < max_bytes <= MAX_BYTES:
            raise ValueError("Invalid file read limit")
        old = read_file(fd, name, max_bytes)
        if operation == "get":
            if old is None:
                raise FileNotFoundError(path)
            return {"data": base64.b64encode(old).decode(), "version": version(old), "name": name}
        if operation != "upload":
            raise ValueError("Unknown operation")
        if "version" not in payload or payload["version"] != version(old):
            return conflict()
        data = base64.b64decode(payload["data"], validate=True)
        if len(data) > MAX_BYTES:
            raise ValueError("Upload exceeds 100 MiB")
        temporary = ".upload-" + uuid.uuid4().hex
        try:
            target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            with os.fdopen(target, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError:
                pass
        return {"path": path, "version": version(data)}
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
