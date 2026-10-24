"""Personal skill packages, executed inside the owning sandbox.

No package script is executed during import. Paths and types are checked before
staging; contents stream to disk and pass CRC checks before atomic publication.
Global packages use a separate root-owned, content-addressed directory.
"""

import base64
from contextlib import contextmanager, ExitStack
import ctypes
import errno
import fcntl
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import uuid
import zipfile

from file_ops import parent_fd, read_file, remove_contents, tree_version, version

MAX_UPLOAD = 100 * 1024 * 1024
MAX_SKILL_TEXT = 64 * 1024
COPY_CHUNK = 64 * 1024
SETTINGS = ".settings.json"
ORDER = ".order.json"
LEGACY_PINS = ".pins.json"

RESOURCE_LAYOUT = {
    "skills": ((".skills-settings.json", SETTINGS), (".skills-pins.json", LEGACY_PINS),
               (".skill-backups", ".backups")),
    "mcp": ((".mcp-settings.json", SETTINGS), (".mcp-pins.json", LEGACY_PINS),
            (".mcp-backups", ".backups"), (".mcp-cache", ".cache")),
}


def safe_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?", name):
        raise ValueError("技能名称需为 1–64 位小写字母、数字或连字符")
    return name


class PackageFile:
    """A reopenable package member; asset contents stay in the source stream."""

    def __init__(self, size, opener):
        self.size, self.open = size, opener
        self.text = None

    @classmethod
    def from_bytes(cls, data):
        return cls(len(data), lambda: io.BytesIO(data))

@contextmanager
def file_slice(stream, offset, size):
    class Reader:
        def __init__(self):
            self.remaining = size
            stream.seek(offset)

        def read(self, amount=-1):
            amount = self.remaining if amount < 0 else min(amount, self.remaining)
            data = stream.read(amount)
            self.remaining -= len(data)
            return data
    yield Reader()


def archive_members(archive):
    entries = {}
    infos = [info for info in archive.infolist() if not info.is_dir()]
    for info in infos:
        mode = info.external_attr >> 16
        if (stat.S_IFMT(mode) and not stat.S_ISREG(mode)) or info.flag_bits & 1:
            raise ValueError("技能包不能包含链接、特殊文件或加密文件")
        if info.filename in entries:
            raise ValueError("技能包包含重复路径")
        entries[info.filename] = PackageFile(info.file_size, lambda info=info: archive.open(info))
    return entries


@contextmanager
def members(payload, *, require_skill=True, supplied=None):
    """Normalize a SKILL.md package, accepting one optional enclosing folder."""
    with ExitStack() as stack:
        entries = {}
        if supplied is not None:
            entries = supplied
        elif payload.get("archive"):
            staged = stack.enter_context(tempfile.TemporaryFile())
            decode_base64(payload["archive"], staged)
            staged.seek(0)
            archive = stack.enter_context(zipfile.ZipFile(staged))
            entries = archive_members(archive)
        else:
            staged = stack.enter_context(tempfile.TemporaryFile())
            for item in payload.get("files", []):
                if item["path"] in entries:
                    raise ValueError("技能包包含重复路径")
                offset = staged.tell()
                decode_base64(item["data"], staged)
                size = staged.tell() - offset
                entries[item["path"]] = PackageFile(size,
                    lambda offset=offset, size=size: file_slice(staged, offset, size))
        entries = normalize_members(entries, require_skill=require_skill)
        if require_skill:
            skill_text(entries)
        yield entries


def decode_base64(value, target):
    """The compatibility JSON itself is resident; decoded assets need not be."""
    if not isinstance(value, str) or len(value) % 4:
        raise ValueError("技能包 Base64 无效")
    for offset in range(0, len(value), COPY_CHUNK):
        part = value[offset:offset + COPY_CHUNK]
        if '=' in part and offset + len(part) != len(value):
            raise ValueError("技能包 Base64 无效")
        target.write(base64.b64decode(part, validate=True))
        if target.tell() > MAX_UPLOAD:
            raise ValueError("技能包超过 100 MiB")


def normalize_members(entries, *, require_skill):
    if not entries:
        raise ValueError("技能包不能为空")
    for path in entries:
        if any(part in ("", ".", "..") for part in path.split("/")) or any(char in path for char in "\\\x00:"):
            raise ValueError("技能包包含无效路径")
    if require_skill and "SKILL.md" not in entries:
        first = next(iter(entries)).split("/")[0]
        if not all(path.startswith(first + "/") for path in entries) or first + "/SKILL.md" not in entries:
            raise ValueError("技能包需要包含一个 SKILL.md")
        entries = {path[len(first) + 1:]: data for path, data in entries.items()}
    folded = [path.casefold() for path in entries]
    if len(set(folded)) != len(folded):
        raise ValueError("技能包包含大小写冲突的文件名")
    files = set(folded)
    for path in folded:
        parts = path.split("/")
        if any("/".join(parts[:index]) in files for index in range(1, len(parts))):
            raise ValueError("技能包文件与目录路径冲突")
    return entries


def skill_text(files):
    member = files["SKILL.md"]
    if member.text is not None:
        return member.text
    if member.size > MAX_SKILL_TEXT:
        raise ValueError("SKILL.md 不能超过 64 KiB")
    with member.open() as source:
        text = source.read(MAX_SKILL_TEXT + 1)
    if len(text) > MAX_SKILL_TEXT:
        raise ValueError("SKILL.md 不能超过 64 KiB")
    member.text = text.decode("utf-8-sig")
    return member.text


def directory(fd, name, mode=0o700):
    try:
        os.mkdir(name, mode, dir_fd=fd)
    except FileExistsError:
        pass
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)


def atomic_write(fd, name, data):
    temporary = ".resource-" + uuid.uuid4().hex
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


def write_member(fd, name, member, *, digest=None):
    temporary = ".resource-" + uuid.uuid4().hex
    try:
        target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        with os.fdopen(target, "wb") as output, member.open() as source:
            count = 0
            while chunk := source.read(COPY_CHUNK):
                output.write(chunk)
                if digest is not None:
                    digest.update(chunk)
                count += len(chunk)
            if count != member.size:
                raise ValueError("技能包文件大小与声明不一致")
            output.flush()
            os.fsync(output.fileno())
        os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass


def resource_directory(rootfd, kind):
    """Relocate legacy owner state once; resource contents keep their paths.

    Namespace directory locks also serialize migration by MCP worker processes.
    Existing destination settings win conflicts, while old bytes are retained
    in backups. Directory collisions retain both entries without following links.
    """
    entries = RESOURCE_LAYOUT[kind]
    fd = directory(rootfd, kind)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        for old, current in entries:
            try:
                source = os.stat(old, dir_fd=rootfd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            try:
                target = os.stat(current, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                os.rename(old, current, src_dir_fd=rootfd, dst_dir_fd=fd)
                os.fsync(fd)
                os.fsync(rootfd)
                continue
            if stat.S_ISDIR(source.st_mode):
                if not stat.S_ISDIR(target.st_mode):
                    raise ValueError("资源状态目录无效，请保留数据并检查目录类型")
                legacyfd = os.open(old, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
                try:
                    currentfd = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        for name in os.listdir(legacyfd):
                            try:
                                os.stat(name, dir_fd=currentfd, follow_symlinks=False)
                            except FileNotFoundError:
                                destination = name
                            else:
                                destination = name + ".legacy-" + uuid.uuid4().hex
                            os.rename(name, destination, src_dir_fd=legacyfd, dst_dir_fd=currentfd)
                        os.fsync(currentfd)
                        os.fsync(legacyfd)
                    finally:
                        os.close(currentfd)
                finally:
                    os.close(legacyfd)
                os.rmdir(old, dir_fd=rootfd)
            else:
                if stat.S_ISREG(source.st_mode) and stat.S_ISREG(target.st_mode):
                    try:
                        previous = json.loads(read_file(rootfd, old))
                        active = json.loads(read_file(fd, current))
                    except (ValueError, OSError, TypeError):
                        pass
                    else:
                        if (isinstance(previous, dict) and isinstance(active, dict)
                                and all(isinstance(value, bool) for value in previous.values())
                                and all(isinstance(value, bool) for value in active.values())):
                            merged = {**previous, **active}
                            if merged != active:
                                atomic_write(fd, current, json.dumps(merged).encode())
                backups = directory(fd, ".backups")
                try:
                    os.rename(old, old + ".legacy-" + uuid.uuid4().hex,
                              src_dir_fd=rootfd, dst_dir_fd=backups)
                    os.fsync(backups)
                finally:
                    os.close(backups)
            os.fsync(fd)
            os.fsync(rootfd)
        try:
            migrate_order(fd)
        except (ValueError, OSError):
            # A broken presentation preference must not hide installed resources.
            # Preserve the bytes; read_order reports the problem and rejects writes.
            pass
        fcntl.flock(fd, fcntl.LOCK_UN)
        return fd
    except BaseException:
        os.close(fd)
        raise


def resource_names(fd):
    return sorted(name for name in os.listdir(fd) if not name.startswith(".")
                  and stat.S_ISDIR(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode))


def migrate_order(fd):
    raw = read_file(fd, LEGACY_PINS)
    if raw is None:
        return
    if read_file(fd, ORDER) is None:
        pins = json.loads(raw)
        if not isinstance(pins, dict) or any(not isinstance(value, bool) for value in pins.values()):
            raise ValueError("旧资源置顶文件无效，请修复后重试")
        names = sorted(resource_names(fd), key=lambda name: not pins.get(name, False))
        atomic_write(fd, ORDER, json.dumps(dict(zip(names, range(len(names))))).encode())
    # The new order is authoritative if migration was interrupted after writing it.
    read_order(fd)
    os.unlink(LEGACY_PINS, dir_fd=fd)
    os.fsync(fd)


def read_order(fd):
    raw = read_file(fd, ORDER)
    if raw is None and read_file(fd, LEGACY_PINS) is not None:
        raise ValueError("旧资源排序尚未迁移，请检查 .pins.json")
    values = json.loads(raw) if raw is not None else {}
    if (not isinstance(values, dict) or any(type(value) is not int or value < 0 for value in values.values())
            or len(set(values.values())) != len(values)):
        raise ValueError("资源排序文件格式无效")
    return values, version(raw) if raw is not None else None


def order_items(items, order):
    return sorted(items, key=lambda item: (order.get(item["id"], float("inf")), item["id"]))


def reorder_resources(fd, payload):
    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        order, revision = read_order(fd)
        if "order_version" not in payload or payload["order_version"] != revision:
            return {"conflict": True}
        names = payload.get("order")
        available = resource_names(fd)
        if (not isinstance(names, list) or any(not isinstance(name, str) for name in names)
                or len(set(names)) != len(names) or any(name not in available for name in names)):
            raise ValueError("资源排序列表无效")
        remaining = [item["id"] for item in order_items([{"id": name} for name in available], order) if item["id"] not in names]
        names = names + remaining
        raw = json.dumps(dict(zip(names, range(len(names))))).encode()
        atomic_write(fd, ORDER, raw)
        return {"order": names, "order_version": version(raw)}
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)


def write_package(fd, files, *, readonly=False, digests=None):
    # Members are private until publication. Sync each file's data, then sync
    # each completed directory once instead of after every member rename.
    for path, member in files.items():
        current = os.dup(fd)
        try:
            for part in path.split("/")[:-1]:
                child = directory(current, part)
                os.close(current)
                current = child
            name = path.split("/")[-1]
            digest = hashlib.sha256() if digests is not None else None
            if digest is None:
                write_member(current, name, member)
            else:
                write_member(current, name, member, digest=digest)
                digests[path] = digest.digest()
            os.chmod(name, 0o444 if readonly else 0o600, dir_fd=current, follow_symlinks=False)
        finally:
            os.close(current)
    def finish(current):
        for name in os.listdir(current):
            info = os.stat(name, dir_fd=current, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                try:
                    finish(child)
                finally:
                    os.close(child)
        if readonly:
            os.fchmod(current, 0o555)
        os.fsync(current)
    finish(fd)


def personal(payload, root="/workspace", *, supplied=None):
    if payload.get('operation') == 'skill_stage':
        from skill_imports import stage_json
        return stage_json(payload, root=root)
    if payload.get('operation') == 'skill_import':
        from skill_imports import legacy
        return legacy(payload, root=root, supplied=supplied)
    operation = payload["operation"]
    if operation not in {"list", "skill_inspect", "skill_update", "skill_uninstall", "skill_toggle", "skill_reorder"}:
        raise ValueError("未知个人资源操作")
    recovery_warnings = []
    if operation == 'list':
        from skill_imports import recover_pending
        recovery_warnings = recover_pending(root)
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    skillsfd = None
    try:
        warnings = recovery_warnings
        if operation == "skill_inspect":
            with members(payload, supplied=supplied) as files:
                return {"content": skill_text(files)}
        try:
            skillsfd = resource_directory(rootfd, "skills")
        except (ValueError, OSError) as error:
            if operation != "list":
                raise
            return {"skills": [], "warnings": ["skills 目录无法读取：" + str(error)]}
        if operation == "skill_reorder":
            return reorder_resources(skillsfd, payload)
        if operation in {"list", "skill_toggle"}:
            try:
                raw_settings = read_file(skillsfd, SETTINGS)
                settings = json.loads(raw_settings or b"{}")
            except (ValueError, OSError) as error:
                if operation != "list":
                    raise
                warnings.append("技能开关文件无效，个人技能暂时停用：" + str(error))
                settings = {}
                invalid_settings = True
            else:
                invalid_settings = not isinstance(settings, dict)
            if not isinstance(settings, dict):
                if operation != "list":
                    raise ValueError("个人技能开关文件格式无效")
                settings = {}
                warnings.append("技能开关文件无效，个人技能暂时停用")
        try:
            order, order_version = read_order(skillsfd)
        except (ValueError, OSError) as error:
            order, order_version = {}, None
            warnings.append("技能排序设置无法读取：" + str(error))
        try:
            if operation == "list":
                skills = []
                for name in sorted(os.listdir(skillsfd)):
                    if name.startswith("."):
                        continue
                    info = os.stat(name, dir_fd=skillsfd, follow_symlinks=False)
                    if not stat.S_ISDIR(info.st_mode):
                        continue
                    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=skillsfd)
                    try:
                        source = read_file(fd, "SKILL.md")
                        if source is None or len(source) > MAX_SKILL_TEXT:
                            continue
                        skills.append({
                            "id": name, "content": source.decode("utf-8-sig"),
                            "enabled": not invalid_settings and settings.get(name, True) is not False,
                            "path": "/workspace/skills/" + name, "version": tree_version(fd),
                        })
                    except (ValueError, OSError) as error:
                        warnings.append("技能 " + name + " 未载入：" + str(error))
                    finally:
                        os.close(fd)
                return {"skills": order_items(skills, order), "order_version": order_version, "warnings": warnings}
            name = safe_name(payload["name"])
            if operation in {"skill_update", "skill_uninstall"}:
                # Async imports publish outside the manager's workspace lock.
                # Keep revision checks and all edits/renames under their namespace lock.
                fcntl.flock(skillsfd, fcntl.LOCK_EX)
                fd = None
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=skillsfd)
                    if not payload.get("version") or payload["version"] != tree_version(fd):
                        return {"conflict": True}
                    text = None
                    if operation == "skill_update":
                        if not isinstance(payload.get("content"), str):
                            raise ValueError("缺少技能内容")
                        text = payload["content"].encode("utf-8")
                        if len(text) > MAX_SKILL_TEXT:
                            raise ValueError("SKILL.md 不能超过 64 KiB")
                        target_name = safe_name(payload.get("new_name", name))
                    backups = directory(skillsfd, ".backups")
                    backup_name = name + "-" + uuid.uuid4().hex
                    try:
                        if operation == "skill_uninstall":
                            try:
                                saved_order, _ = read_order(skillsfd)
                            except (ValueError, OSError):
                                saved_order = {}
                            previous_order = read_file(skillsfd, ORDER) if name in saved_order else None
                            # Keep the complete package recoverable outside the active catalog.
                            os.rename(name, backup_name, src_dir_fd=skillsfd, dst_dir_fd=backups)
                            try:
                                if name in saved_order:
                                    saved_order.pop(name)
                                    atomic_write(skillsfd, ORDER, json.dumps(saved_order).encode())
                                os.fsync(skillsfd)
                                os.fsync(backups)
                            except BaseException:
                                os.rename(backup_name, name, src_dir_fd=backups, dst_dir_fd=skillsfd)
                                if previous_order is not None and read_file(skillsfd, ORDER) != previous_order:
                                    atomic_write(skillsfd, ORDER, previous_order)
                                raise
                            return {"id": name, "uninstalled": True}
                        backup = directory(backups, backup_name)
                        try:
                            previous = read_file(fd, "SKILL.md")
                            if previous is not None:
                                atomic_write(backup, "SKILL.md", previous)
                        finally:
                            os.close(backup)
                        renamed = target_name != name
                        if renamed:
                            try:
                                os.mkdir(target_name, 0o700, dir_fd=skillsfd)
                            except FileExistsError:
                                return {"conflict": True}
                            try:
                                os.rename(name, target_name, src_dir_fd=skillsfd, dst_dir_fd=skillsfd)
                            except BaseException:
                                os.rmdir(target_name, dir_fd=skillsfd)
                                raise
                        changed_settings = []
                        try:
                            atomic_write(fd, "SKILL.md", text)
                            if renamed:
                                for filename in (SETTINGS, ORDER):
                                    raw = read_file(skillsfd, filename)
                                    if raw is None:
                                        continue
                                    values = json.loads(raw)
                                    if not isinstance(values, dict):
                                        raise ValueError("技能设置文件格式无效")
                                    if name in values:
                                        values[target_name] = values.pop(name)
                                        changed_settings.append((filename, raw))
                                        atomic_write(skillsfd, filename, json.dumps(values).encode())
                                os.fsync(skillsfd)
                        except BaseException:
                            if renamed:
                                os.rename(target_name, name, src_dir_fd=skillsfd, dst_dir_fd=skillsfd)
                            if previous is not None:
                                atomic_write(fd, "SKILL.md", previous)
                            else:
                                try:
                                    os.unlink("SKILL.md", dir_fd=fd)
                                except FileNotFoundError:
                                    pass
                            for filename, raw in changed_settings:
                                atomic_write(skillsfd, filename, raw)
                            raise
                        return {"id": target_name, "version": tree_version(fd)}
                    finally:
                        os.close(backups)
                finally:
                    if fd is not None:
                        os.close(fd)
                    fcntl.flock(skillsfd, fcntl.LOCK_UN)
            if operation == "skill_toggle":
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=skillsfd)
                os.close(fd)
                if not isinstance(payload["enabled"], bool):
                    raise ValueError("技能开关值无效")
                settings[name] = payload["enabled"]
                atomic_write(skillsfd, SETTINGS, json.dumps(settings).encode())
                return {"id": name, "enabled": settings[name]}
            raise ValueError("未知个人资源操作")
        finally:
            os.close(skillsfd)
            skillsfd = None
    finally:
        if skillsfd is not None:
            os.close(skillsfd)
        os.close(rootfd)


def package_version(fd, name):
    try:
        package = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    except FileNotFoundError:
        return None
    try:
        return tree_version(package)
    finally:
        os.close(package)


def rename_directory(sourcefd, source, targetfd, target, *, exchange=False):
    """Publish without overwriting a new target, or atomically exchange two trees."""
    rename = ctypes.CDLL(None, use_errno=True).renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(sourcefd, os.fsencode(source), targetfd, os.fsencode(target), 2 if exchange else 1):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def discard_staging(parent, name, fd):
    """Remove only this invocation's unpublished tree, never a swapped old package."""
    try:
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    owned = os.fstat(fd)
    if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino):
        return
    def writable(currentfd):
        os.fchmod(currentfd, 0o700)
        for child_name in os.listdir(currentfd):
            info = os.stat(child_name, dir_fd=currentfd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(child_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=currentfd)
                try:
                    writable(child)
                finally:
                    os.close(child)
    writable(fd)
    remove_contents(fd)
    os.rmdir(name, dir_fd=parent)


def install_personal(rootfd, skillsfd, name, expected, files, *, transaction=None):
    if package_version(skillsfd, name) != expected:
        return {"conflict": True}
    staging_name = ".skill-import-" + uuid.uuid4().hex
    staging = directory(rootfd, staging_name)
    backups = None
    committed = False
    try:
        if transaction is not None:
            transaction.extracting(staging_name, os.fstat(staging))
        write_package(staging, files)
        fingerprint = tree_version(staging)
        fcntl.flock(skillsfd, fcntl.LOCK_EX)
        try:
            # Extraction may be slow; never replace changes made while it ran.
            if package_version(skillsfd, name) != expected:
                return {"conflict": True}
            if expected is None:
                if transaction is not None:
                    transaction.publishing(fingerprint, None, None)
                try:
                    rename_directory(rootfd, staging_name, skillsfd, name)
                except OSError as error:
                    if error.errno == errno.EEXIST:
                        return {"conflict": True}
                    raise
                try:
                    os.fsync(skillsfd)
                    os.fsync(rootfd)
                except BaseException:
                    os.rename(name, staging_name, src_dir_fd=skillsfd, dst_dir_fd=rootfd)
                    raise
            else:
                backups = directory(skillsfd, ".backups")
                backup_name = name + "-" + uuid.uuid4().hex
                if transaction is not None:
                    transaction.publishing(fingerprint,
                        os.stat(name, dir_fd=skillsfd, follow_symlinks=False), backup_name)
                rename_directory(rootfd, staging_name, skillsfd, name, exchange=True)
                moved = False
                try:
                    os.rename(staging_name, backup_name, src_dir_fd=rootfd, dst_dir_fd=backups)
                    moved = True
                    os.fsync(skillsfd)
                    os.fsync(backups)
                    os.fsync(rootfd)
                except BaseException:
                    if moved:
                        rename_directory(backups, backup_name, skillsfd, name, exchange=True)
                        os.rename(backup_name, staging_name, src_dir_fd=backups, dst_dir_fd=rootfd)
                    else:
                        rename_directory(rootfd, staging_name, skillsfd, name, exchange=True)
                    raise
            committed = True
        finally:
            fcntl.flock(skillsfd, fcntl.LOCK_UN)
        return {"id": name, "version": fingerprint, "path": "/workspace/skills/" + name}
    finally:
        if backups is not None:
            os.close(backups)
        try:
            if not committed:
                discard_staging(rootfd, staging_name, staging)
        finally:
            os.close(staging)


def source_fingerprint(package):
    """Exact source identity, computed here rather than trusting client hashes."""
    digest = hashlib.sha256()
    def field(value):
        if not isinstance(value, str):
            raise ValueError('技能包内容无效')
        digest.update(str(len(value)).encode() + b':')
        for offset in range(0, len(value), COPY_CHUNK):
            digest.update(value[offset:offset + COPY_CHUNK].encode())
    field(package.get('kind', 'skill'))
    if package.get('archive'):
        field('archive')
        field(package['archive'])
    else:
        field('files')
        for item in package.get('files', []):
            field(item['path'])
            field(item['data'])
    return digest.hexdigest()


def global_install(payload, root="/opt/workbench-global"):
    """Only the trusted manager invokes this as root, with server-loaded archives."""
    os.makedirs(root, mode=0o755, exist_ok=True)
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    result = []
    sources = None
    try:
        try:
            sources = os.open('.sources', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
        except FileNotFoundError:
            pass
        for package in payload["packages"]:
            is_skill = package.get("kind", "skill") == "skill"
            source_key = source_fingerprint(package)
            cached = read_file(sources, source_key, max_bytes=128 * 1024) if sources is not None else None
            if cached:
                cached = json.loads(cached)
                key = cached['key']
                if not re.fullmatch('[a-f0-9]{64}', key):
                    raise ValueError('全局技能缓存地址无效')
                try:
                    existing = os.open(key, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
                except FileNotFoundError:
                    pass  # A removed content directory invalidates only this hint.
                else:
                    try:
                        content = read_file(existing, 'SKILL.md', max_bytes=MAX_SKILL_TEXT).decode('utf-8-sig') if is_skill else ''
                        result.append({'name': package['name'], 'path': root + '/' + key + cached['suffix'], 'content': content})
                    finally:
                        os.close(existing)
                    continue
            with members(package, require_skill=is_skill) as files:
                # Compute the original content address while extracting once.
                temporary = ".global-" + uuid.uuid4().hex
                fd = directory(rootfd, temporary)
                try:
                    digests = {}
                    write_package(fd, files, readonly=True, digests=digests)
                    digest = hashlib.sha256()
                    for path in sorted(digests):
                        digest.update(path.encode() + b"\0" + digests[path])
                    key = digest.hexdigest()
                    try:
                        rename_directory(rootfd, temporary, rootfd, key)
                    except OSError as error:
                        if error.errno != errno.EEXIST:
                            raise
                        existing = os.open(key, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
                        os.close(existing)
                        discard_staging(rootfd, temporary, fd)
                except BaseException:
                    discard_staging(rootfd, temporary, fd)
                    raise
                finally:
                    os.close(fd)
                suffix = '' if is_skill else '/' + next(iter(files))
                if sources is None:
                    sources = directory(rootfd, '.sources')
                atomic_write(sources, source_key, json.dumps({'key': key, 'suffix': suffix}).encode())
                result.append({"name": package["name"], "path": root + "/" + key + suffix, "content": skill_text(files) if is_skill else ""})
        os.fsync(rootfd)
        return {"skills": result}
    finally:
        if sources is not None:
            os.close(sources)
        os.close(rootfd)


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        print(json.dumps(global_install(request) if request.get("operation") == "global_install" else personal(request)))
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)
