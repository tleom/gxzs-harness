"""Personal skill packages, executed inside the owning sandbox.

No package script is executed during import. All archive members are validated
before writes; user files use no-follow directory descriptors and atomic swaps.
Global packages use a separate root-owned, content-addressed directory.
"""

import base64
import fcntl
import hashlib
import io
import json
import os
import re
import stat
import sys
import uuid
import zipfile

from file_ops import parent_fd, read_file, remove_contents, tree_version, version

MAX_PACKAGE = 20 * 1024 * 1024
MAX_SKILL_TEXT = 64 * 1024
MAX_FILES = 200
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


def members(payload, *, require_skill=True):
    """Normalize a SKILL.md package, accepting one optional enclosing folder."""
    entries = {}
    if payload.get("archive"):
        raw = base64.b64decode(payload["archive"], validate=True)
        if len(raw) > MAX_PACKAGE:
            raise ValueError("技能包超过 20 MiB")
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = [info for info in archive.infolist() if not info.is_dir()]
            if len(infos) > MAX_FILES or sum(info.file_size for info in infos) > MAX_PACKAGE:
                raise ValueError("技能包最多包含 200 个文件，总大小不超过 20 MiB")
            for info in infos:
                mode = info.external_attr >> 16
                if (stat.S_IFMT(mode) and not stat.S_ISREG(mode)) or info.flag_bits & 1:
                    raise ValueError("技能包不能包含链接、特殊文件或加密文件")
                if info.filename in entries:
                    raise ValueError("技能包包含重复路径")
                entries[info.filename] = archive.read(info)
    else:
        for item in payload.get("files", []):
            if item["path"] in entries:
                raise ValueError("技能包包含重复路径")
            entries[item["path"]] = base64.b64decode(item["data"], validate=True)
    if not entries or len(entries) > MAX_FILES or sum(map(len, entries.values())) > MAX_PACKAGE:
        raise ValueError("技能包文件数量或大小超限")
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
    if require_skill:
        if len(entries["SKILL.md"]) > MAX_SKILL_TEXT:
            raise ValueError("SKILL.md 不能超过 64 KiB")
        entries["SKILL.md"].decode("utf-8-sig")
    return entries


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


def write_package(fd, files, *, readonly=False):
    for path, data in files.items():
        current = os.dup(fd)
        try:
            for part in path.split("/")[:-1]:
                child = directory(current, part)
                os.close(current)
                current = child
            name = path.split("/")[-1]
            atomic_write(current, name, data)
            os.chmod(name, 0o444 if readonly else 0o600, dir_fd=current, follow_symlinks=False)
        finally:
            os.close(current)
    if readonly:
        def protect(current):
            for name in os.listdir(current):
                info = os.stat(name, dir_fd=current, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                    try:
                        protect(child)
                    finally:
                        os.close(child)
            os.fchmod(current, 0o555)
        protect(fd)


def personal(payload, root="/workspace"):
    operation = payload["operation"]
    if operation not in {"list", "skill_inspect", "skill_import", "skill_update", "skill_uninstall", "skill_toggle", "skill_reorder"}:
        raise ValueError("未知个人资源操作")
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    skillsfd = None
    try:
        warnings = []
        if operation == "skill_inspect":
            files = members(payload)
            return {"content": files["SKILL.md"].decode("utf-8-sig")}
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
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=skillsfd)
                try:
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
                            # Keep the complete package recoverable outside the active catalog.
                            os.rename(name, backup_name, src_dir_fd=skillsfd, dst_dir_fd=backups)
                            try:
                                if name in saved_order:
                                    saved_order.pop(name)
                                    atomic_write(skillsfd, ORDER, json.dumps(saved_order).encode())
                            except BaseException:
                                os.rename(backup_name, name, src_dir_fd=backups, dst_dir_fd=skillsfd)
                                raise
                            os.fsync(skillsfd)
                            os.fsync(backups)
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
                    os.close(fd)
            if operation == "skill_toggle":
                fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=skillsfd)
                os.close(fd)
                if not isinstance(payload["enabled"], bool):
                    raise ValueError("技能开关值无效")
                settings[name] = payload["enabled"]
                atomic_write(skillsfd, SETTINGS, json.dumps(settings).encode())
                return {"id": name, "enabled": settings[name]}
            if operation != "skill_import":
                raise ValueError("未知个人资源操作")
            files = members(payload)
            try:
                oldfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=skillsfd)
            except FileNotFoundError:
                oldfd = None
            previous = None
            if oldfd is not None:
                try:
                    previous = tree_version(oldfd)
                finally:
                    os.close(oldfd)
            if payload.get("version") != previous:
                return {"conflict": True}
            staging_name = ".skill-import-" + uuid.uuid4().hex
            staging = directory(rootfd, staging_name)
            try:
                write_package(staging, files)
                fingerprint = tree_version(staging)
            finally:
                os.close(staging)
            backups, backup_name = None, None
            if previous is not None:
                backups = directory(skillsfd, ".backups")
                backup_name = name + "-" + uuid.uuid4().hex
                os.rename(name, backup_name, src_dir_fd=skillsfd, dst_dir_fd=backups)
            try:
                os.rename(staging_name, name, src_dir_fd=rootfd, dst_dir_fd=skillsfd)
                os.fsync(skillsfd)
            except BaseException:
                if backups is not None:
                    os.rename(backup_name, name, src_dir_fd=backups, dst_dir_fd=skillsfd)
                raise
            finally:
                if backups is not None:
                    os.close(backups)
            return {"id": name, "version": fingerprint, "path": "/workspace/skills/" + name}
        finally:
            os.close(skillsfd)
            skillsfd = None
    finally:
        if skillsfd is not None:
            os.close(skillsfd)
        os.close(rootfd)


def global_install(payload, root="/opt/workbench-global"):
    """Only the trusted manager invokes this as root, with server-loaded archives."""
    os.makedirs(root, mode=0o755, exist_ok=True)
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    result = []
    try:
        for package in payload["packages"]:
            is_skill = package.get("kind", "skill") == "skill"
            files = members(package, require_skill=is_skill)
            digest = hashlib.sha256()
            for path, data in sorted(files.items()):
                digest.update(path.encode() + b"\0" + hashlib.sha256(data).digest())
            key = digest.hexdigest()
            try:
                fd = os.open(key, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
            except FileNotFoundError:
                temporary = ".global-" + uuid.uuid4().hex
                fd = directory(rootfd, temporary)
                try:
                    write_package(fd, files, readonly=True)
                finally:
                    os.close(fd)
                os.rename(temporary, key, src_dir_fd=rootfd, dst_dir_fd=rootfd)
            else:
                os.close(fd)
            result.append({"name": package["name"], "path": root + "/" + key + ("" if is_skill else "/" + next(iter(files))), "content": files["SKILL.md"].decode("utf-8-sig") if is_skill else ""})
        os.fsync(rootfd)
        return {"skills": result}
    finally:
        os.close(rootfd)


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        print(json.dumps(global_install(request) if request.get("operation") == "global_install" else personal(request)))
    except (ValueError, OSError, zipfile.BadZipFile) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(2)
