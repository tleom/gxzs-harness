"""File-backed personal MCP configuration, executed as the owning sandbox user.

Listing never connects to a server or returns credentials. Configurations are the
source of truth; cached tool declarations are valid only for their config hash.
All file traversal follows the same no-symlink contract as personal skills.
"""

import fcntl
import json
import math
import os
import re
import stat
import time
import uuid
from urllib.parse import urlsplit

from file_ops import parent_fd, read_file, version
from resource_ops import SETTINGS, ORDER, atomic_write, directory, resource_directory, read_order, order_items, reorder_resources

from mcp_policy import get as policy

class ManifestError(ValueError):
    """Safe, actionable discovery failures; never include server-provided text."""

    def __init__(self, message, code="MCP_MANIFEST_INVALID"):
        super().__init__(message)
        self.code = code


def server_name(value):
    # Legacy digit-leading folders remain readable so users can rename them.
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", value):
        raise ValueError("MCP 标识需为 1–64 位小写字母、数字、下划线或连字符")
    return value


def plugin_name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", value):
        raise ValueError("插件调用名须以小写字母开头，只含小写字母、数字、下划线或连字符，最多 64 位")
    return value


def string_map(value, label):
    if not isinstance(value, dict):
        raise ValueError(label + " 必须是字符串键值对象")
    if any(not isinstance(k, str) or not isinstance(v, str) or "\x00" in k + v for k, v in value.items()):
        raise ValueError(label + " 必须是字符串键值对象")
    return value


def configuration(raw):
    if not raw or len(raw) > policy('request_bytes'):
        raise ValueError("mcp.json 必须是非空且符合传输预算的 UTF-8 JSON")
    value = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("MCP 配置必须是 JSON 对象")
    # Preserve extension fields; only explicitly supported connection fields are executed.
    for key in ("name", "display_name", "description"):
        if key in value and (not isinstance(value[key], str)):
            raise ValueError("MCP 名称或说明格式无效")
    transport = value.get("transport") or ("stdio" if value.get("command") else "streamable-http")
    if transport == "http":
        transport = "streamable-http"
    if transport not in {"stdio", "streamable-http", "sse"}:
        raise ValueError("transport 需为 stdio、streamable-http 或 sse")
    timeout = value.get("timeout", policy("call_timeout_seconds"))
    if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("MCP 超时需为正数秒")
    value = {**value, "transport": transport, "timeout": timeout}
    if transport == "stdio":
        if any(key in value for key in ("url", "headers")):
            raise ValueError("stdio 配置使用 command、args 和 env")
        command, args = value.get("command"), value.get("args", [])
        if not isinstance(command, str) or not command.strip() or "\x00" in command:
            raise ValueError("缺少有效的 MCP 启动命令")
        if not isinstance(args, list) or any(not isinstance(v, str) or "\x00" in v for v in args):
            raise ValueError("args 必须是字符串数组")
        value["args"] = args
        value["env"] = string_map(value.get("env", {}), "env")
        cwd = value.get("cwd", "/workspace")
        if not isinstance(cwd, str) or not cwd.startswith("/workspace") or "\x00" in cwd:
            raise ValueError("工作目录需位于 /workspace 下")
        if os.path.commonpath(["/workspace", os.path.normpath(cwd)]) != "/workspace":
            raise ValueError("工作目录需位于 /workspace 下")
        value["cwd"] = cwd
    else:
        if any(key in value for key in ("command", "args", "env", "cwd")):
            raise ValueError("远程 MCP 配置使用 url 和 headers")
        url = value.get("url")
        if not isinstance(url, str) or any(c in url for c in "\r\n\x00"):
            raise ValueError("缺少有效的 MCP URL")
        parsed = urlsplit(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            raise ValueError("MCP URL 需为 HTTP(S) 地址；认证信息请填写 headers")
        value["headers"] = string_map(value.get("headers", {}), "headers")
        if any("\r" in k + v or "\n" in k + v for k, v in value["headers"].items()):
            raise ValueError("MCP headers 不能包含换行")
    return value


def connection_configuration(config):
    """Presentation metadata does not change the tools exposed by a connection."""
    return {key: value for key, value in config.items()
            if key not in {"name", "display_name", "description"}}


def relocated_configuration(config, name, target_name, package_fd):
    """Relocate literal package paths when its owning directory is renamed."""
    if config.get("transport") != "stdio" or name == target_name:
        return config
    source, target = "/workspace/mcp/" + name, "/workspace/mcp/" + target_name

    def relocate(value):
        if not isinstance(value, str):
            return value
        if value.rstrip("/") == source:
            return target + value[len(source):]
        if not value.startswith(source + "/"):
            return value
        try:
            parent, leaf = parent_fd(package_fd, value[len(source) + 1:].rstrip("/"))
            try:
                info = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode) or (stat.S_ISREG(info.st_mode) and not value.endswith("/")):
                    return target + value[len(source):]
            finally:
                os.close(parent)
        except (ValueError, OSError):
            pass
        return value

    return {**config, "command": relocate(config["command"]),
            "args": [relocate(value) for value in config["args"]],
            "cwd": relocate(config["cwd"])}


def connection_fingerprint(config):
    return version(json.dumps(connection_configuration(config), sort_keys=True,
                              separators=(",", ":")).encode())


def authentication_version(config):
    return version(json.dumps({key: config.get(key, {}) for key in ("headers", "env")},
                              sort_keys=True, separators=(",", ":")).encode())


def cache_limit():
    # Old caches escaped Unicode (up to 3x its UTF-8 size). The extra space is
    # for fixed hashes/timestamps, not an additional tool-definition budget.
    return policy('response_bytes') * 3 + 4096


def read_cache(fd, name):
    return read_file(fd, name, max_bytes=cache_limit())


def encode_catalog(value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    if len(data) + 1 > policy('response_bytes'):
        raise ManifestError('MCP 完整工具目录超过可配置的响应传输预算', 'MCP_DISCOVERY_TOO_LARGE')
    return data


def encode_cache(value):
    encode_catalog({'ready': True, 'version': value['version'], 'manifest_version': value['manifest_version'],
                    'tools': value['tools'], 'server_info': value.get('server_info', {})})
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    if len(data) > cache_limit():
        raise ManifestError('MCP 目录缓存超过存储预算', 'MCP_DISCOVERY_TOO_LARGE')
    return data


def tool_manifest(tools):
    if not isinstance(tools, list):
        raise ManifestError("MCP 工具目录必须是数组")
    result, seen = [], set()
    for tool in tools:
        if not isinstance(tool, dict):
            raise ManifestError("MCP 工具声明无效")
        name, schema = tool.get("name"), tool.get("inputSchema")
        if not isinstance(name, str) or not name or len(name) > 128 or name in seen:
            raise ManifestError("MCP 工具名称无效或重复")
        if not isinstance(schema, dict) or schema.get("type") != "object":
            raise ManifestError("MCP 工具参数必须是 object JSON Schema")
        output_schema = tool.get("outputSchema")
        if output_schema is not None and (not isinstance(output_schema, dict) or output_schema.get("type") != "object"):
            raise ManifestError("MCP 工具输出必须是 object JSON Schema")
        pending = [schema, output_schema]
        while pending:
            part = pending.pop()
            if isinstance(part, dict):
                for key, value in part.items():
                    if key in {"$ref", "$dynamicRef"} and (not isinstance(value, str) or not value.startswith("#")):
                        raise ManifestError("MCP 参数声明不能引用外部 JSON Schema")
                    if key in {"properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"} and isinstance(value, dict):
                        pending.extend(child for child in value.values() if isinstance(child, (dict, bool)))
                    elif key in {"anyOf", "allOf", "oneOf", "prefixItems", "items"} and isinstance(value, list):
                        pending.extend(value)
                    elif key in {"additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "additionalItems", "unevaluatedItems", "if", "then", "else", "not", "contentSchema", "items"}:
                        pending.append(value)
        description = tool.get("description", "")
        if not isinstance(description, str):
            raise ManifestError("MCP 工具说明无效")
        declaration = {"name": name, "description": description, "inputSchema": schema}
        if output_schema is not None:
            declaration["outputSchema"] = output_schema
        for key in ("annotations", "execution"):
            if key in tool:
                if not isinstance(tool[key], dict):
                    raise ManifestError("MCP 工具元数据必须是对象")
                declaration[key] = tool[key]
        result.append(declaration)
        seen.add(name)
    return result


def manifest_version(tools):
    # tools/list order is presentation, while arrays inside a schema remain significant.
    return legacy_manifest_version(sorted(tools, key=lambda tool: tool["name"]))


def legacy_manifest_version(tools):
    return version(json.dumps(tools, sort_keys=True, separators=(",", ":")).encode())


def cached_manifest(cached, config, revision):
    """Validate the old binding before retaining its version for an unchanged catalog."""
    if (not isinstance(cached, dict) or cached.get("version") != revision
            or cached.get("connection_fingerprint") != connection_fingerprint(config)
            or cached.get("authentication_version") != authentication_version(config)
            or not isinstance(cached.get("discovered_at"), (int, float))
            or not 0 <= time.time() - cached["discovered_at"]):
        return None
    tools = tool_manifest(cached.get("tools", []))
    fingerprint = cached.get("manifest_version")
    if fingerprint not in (manifest_version(tools), legacy_manifest_version(tools)):
        return None
    encode_catalog({'ready': True, 'version': revision, 'manifest_version': fingerprint,
                    'tools': tools, 'server_info': cached.get('server_info', {})})
    return tools, fingerprint


def mapping(rootfd, name):
    value = json.loads(read_file(rootfd, name) or b"{}")
    if not isinstance(value, dict) or any(not isinstance(v, bool) for v in value.values()):
        raise ValueError("MCP 开关设置格式无效")
    return value


def raw_configuration(rootfd, name):
    mcpfd = directory(rootfd, "mcp")
    try:
        fd = os.open(server_name(name), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=mcpfd)
    finally:
        os.close(mcpfd)
    try:
        return read_file(fd, "mcp.json", max_bytes=policy('request_bytes'))
    finally:
        os.close(fd)


def load(rootfd, name):
    raw = raw_configuration(rootfd, name)
    return configuration(raw), version(raw)


def snapshot(rootfd, selected=None):
    mcpfd = resource_directory(rootfd, "mcp")
    try:
        warnings = []
        try:
            settings = mapping(mcpfd, SETTINGS)
            settings_valid = True
        except (ValueError, OSError):
            settings, settings_valid = {}, False
            warnings.append("MCP 开关文件无效，个人 MCP 暂时停用")
        try:
            order, order_version = read_order(mcpfd)
        except (ValueError, OSError):
            order, order_version = {}, None
            warnings.append("MCP 排序文件无效")
        cachefd = directory(mcpfd, ".cache")
        items = []
        try:
            for name in ([server_name(selected)] if selected is not None else sorted(os.listdir(mcpfd))):
                if name.startswith("."):
                    continue
                item = {
                    "id": name,
                    "name": name,
                    "description": "",
                    "scope": "personal",
                    "readonly": False,
                    "path": "/workspace/mcp/" + name,
                    "enabled": settings_valid and settings.get(name, True),
                    "version": None,
                    "tools": [],
                    "status": "unverified",
                }
                try:
                    raw = raw_configuration(rootfd, name)
                    revision = version(raw)
                    item["version"] = revision
                    config = configuration(raw)
                    item.update(
                        name=config.get("display_name") or config.get("name") or name,
                        call_name=name,
                        description=config.get("description", ""),
                        transport=config["transport"],
                        version=revision,
                        runtime_version=connection_fingerprint(config),
                    )
                except (ValueError, OSError, RecursionError):
                    item.update(enabled=False, status="invalid", error="配置无效，请编辑 mcp.json 后重新测试连接")
                    items.append(item)
                    continue
                try:
                    cached = json.loads(read_cache(cachefd, name + ".json") or b"{}")
                    verified = cached_manifest(cached, config, revision)
                    if verified:
                        tools, fingerprint = verified
                        item["discovered_at"] = cached["discovered_at"]
                        # Age requests revalidation; it is not evidence that a
                        # previously verified, unchanged plugin is unavailable.
                        if not cached.get("refresh_failed"):
                            item.update(server_info=cached.get("server_info", {}), tools=tools, manifest_version=fingerprint, status="ready",
                                        refresh_due=time.time() - cached["discovered_at"] >= policy('discovery_cache_seconds'))
                except (ValueError, OSError, RecursionError):
                    warnings.append(f"个人 MCP {name} 的目录缓存无效，正在重新发现")
                items.append(item)
            return {"mcp": order_items(items, order), "order_version": order_version, "warnings": warnings}
        finally:
            os.close(cachefd)
    finally:
        os.close(mcpfd)


def personal_mcp(payload, root="/workspace"):
    operation = payload["operation"]
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    statefd = None
    try:
        statefd = resource_directory(rootfd, "mcp")
        if operation == "mcp_list":
            return snapshot(rootfd, payload.get('name'))
        if operation == "mcp_reorder":
            return reorder_resources(statefd, payload)
        name = server_name(payload.get("name"))
        target_name = name
        if operation == "mcp_save":
            target_name = plugin_name(payload.get("new_name", name))
            content = payload.get("content")
            if not isinstance(content, str):
                raise ValueError("缺少 MCP 配置")
            configuration(content.encode("utf-8"))
        if operation == "mcp_probe":
            config, revision = load(rootfd, name)
            result = {
                "id": name,
                "version": revision,
                "runtime_version": connection_fingerprint(config),
                "timeout": config["timeout"],
                "enabled": mapping(statefd, SETTINGS).get(name, True),
            }
            if payload.get("include_discovery_state"):
                result["discovered_at"] = snapshot(rootfd, name)["mcp"][0].get("discovered_at")
            return result
        if operation == "mcp_toggle":
            if operation == "mcp_toggle" and payload.get("enabled") is True:
                plugin_name(name)
            load(rootfd, name)
            field, filename = "enabled", SETTINGS
            if not isinstance(payload.get(field), bool):
                raise ValueError("MCP 设置需为布尔值")
            values = mapping(statefd, filename)
            values[name] = payload[field]
            atomic_write(statefd, filename, json.dumps(values).encode())
            return {"id": name, field: values[name]}
        mcpfd = directory(rootfd, "mcp")
        try:
            fd = (
                directory(mcpfd, name)
                if operation == "mcp_save" and target_name == name
                else os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=mcpfd)
            )
            try:
                raw = read_file(fd, "mcp.json", max_bytes=policy('request_bytes'))
                revision = version(raw)
                if operation == "mcp_read":
                    return {"id": name, "content": (raw or b"").decode("utf-8-sig"), "version": revision}
                try:
                    runtime_revision = connection_fingerprint(configuration(raw)) if raw is not None else None
                except (ValueError, RecursionError):
                    runtime_revision = None  # Invalid files must remain editable/deletable with their CAS version.
                expected = payload.get("version")
                if expected != revision and not (operation in {"mcp_cache", "mcp_cache_failure"} and expected == runtime_revision):
                    return {"conflict": True}
                if operation == "mcp_save":
                    content = payload.get("content")
                    if not isinstance(content, str):
                        raise ValueError("缺少 MCP 配置")
                    data = content.encode("utf-8")
                    config = configuration(data)
                    renamed = target_name != name
                    if (raw is None or renamed) and config.get("name", target_name) != target_name:
                        raise ValueError("插件 JSON 中的 name 必须与调用名称一致")
                    if renamed and raw is None:
                        raise ValueError("原插件配置不存在")
                    relocated = relocated_configuration(config, name, target_name, fd)
                    if relocated != config:
                        config = relocated
                        data = json.dumps(config, ensure_ascii=False, indent=2).encode("utf-8")
                        config = configuration(data)
                    cached = None
                    connection_changed = renamed or raw is None or runtime_revision != connection_fingerprint(config)
                    if raw is not None:
                        try:
                            if connection_configuration(configuration(raw)) == connection_configuration(config):
                                cachefd = directory(statefd, ".cache")
                                try:
                                    cached = json.loads(read_cache(cachefd, name + ".json") or b"{}")
                                    if (not isinstance(cached, dict) or cached.get("version") != revision
                                            or cached.get("connection_fingerprint") != connection_fingerprint(config)
                                            or cached.get("authentication_version") != authentication_version(config)):
                                        cached = None
                                    else:
                                        tool_manifest(cached.get("tools", []))
                                finally:
                                    os.close(cachefd)
                        except (ValueError, OSError, RecursionError):
                            cached = None
                    if raw is not None:
                        backups = directory(statefd, ".backups")
                        try:
                            atomic_write(backups, name + "-" + uuid.uuid4().hex + ".json", raw)
                        finally:
                            os.close(backups)
                    if renamed:
                        try:
                            os.mkdir(target_name, 0o700, dir_fd=mcpfd)
                        except FileExistsError:
                            return {"conflict": True}
                        try:
                            os.rename(name, target_name, src_dir_fd=mcpfd, dst_dir_fd=mcpfd)
                        except BaseException:
                            os.rmdir(target_name, dir_fd=mcpfd)
                            raise
                    changed_settings = []
                    changed_cache = []
                    cachefd = None
                    try:
                        atomic_write(fd, "mcp.json", data)
                        if renamed:
                            for filename in (SETTINGS, ORDER):
                                previous = read_file(statefd, filename)
                                if previous is None:
                                    continue
                                values = json.loads(previous)
                                if not isinstance(values, dict):
                                    raise ValueError("MCP 设置文件格式无效")
                                if name in values:
                                    values[target_name] = values.pop(name)
                                    changed_settings.append((filename, previous))
                                    atomic_write(statefd, filename, json.dumps(values).encode())
                        if cached is not None or renamed:
                            cachefd = directory(statefd, ".cache")
                            target_cache = target_name + ".json"
                            changed_cache.append((target_cache, read_cache(cachefd, target_cache)))
                            if cached is not None:
                                atomic_write(cachefd, target_cache, encode_cache({
                                    **cached, "version": version(data)
                                }))
                            else:
                                try:
                                    os.unlink(target_cache, dir_fd=cachefd)
                                except FileNotFoundError:
                                    pass
                            if renamed:
                                old_cache = name + ".json"
                                changed_cache.append((old_cache, read_cache(cachefd, old_cache)))
                                try:
                                    os.unlink(old_cache, dir_fd=cachefd)
                                except FileNotFoundError:
                                    pass
                        os.fsync(mcpfd)
                    except BaseException:
                        if renamed:
                            os.rename(target_name, name, src_dir_fd=mcpfd, dst_dir_fd=mcpfd)
                        if raw is not None:
                            atomic_write(fd, "mcp.json", raw)
                        else:
                            try:
                                os.unlink("mcp.json", dir_fd=fd)
                            except FileNotFoundError:
                                pass
                        for filename, previous in changed_settings:
                            atomic_write(statefd, filename, previous)
                        for filename, previous in reversed(changed_cache):
                            if previous is None:
                                try:
                                    os.unlink(filename, dir_fd=cachefd)
                                except FileNotFoundError:
                                    pass
                            else:
                                atomic_write(cachefd, filename, previous)
                        raise
                    finally:
                        if cachefd is not None:
                            os.close(cachefd)
                    return {"id": target_name, "version": version(data), "runtime_version": connection_fingerprint(config),
                            "connection_changed": connection_changed}
                if operation == "mcp_delete":
                    backups = directory(statefd, ".backups")
                    backup_name = name + "-" + uuid.uuid4().hex
                    changed_settings = []
                    moved = False
                    try:
                        os.rename(name, backup_name, src_dir_fd=mcpfd, dst_dir_fd=backups)
                        moved = True
                        for setting in (SETTINGS, ORDER):
                            try:
                                values = read_order(statefd)[0] if setting == ORDER else mapping(statefd, setting)
                            except (ValueError, OSError):
                                continue
                            if name not in values:
                                continue
                            previous = read_file(statefd, setting)
                            values.pop(name)
                            changed_settings.append((setting, previous))
                            atomic_write(statefd, setting, json.dumps(values).encode())
                        os.fsync(mcpfd)
                        os.fsync(backups)
                        cachefd = directory(statefd, ".cache")
                        try:
                            try:
                                os.unlink(name + ".json", dir_fd=cachefd)
                            except FileNotFoundError:
                                pass
                        finally:
                            os.close(cachefd)
                    except BaseException:
                        if moved:
                            os.rename(backup_name, name, src_dir_fd=backups, dst_dir_fd=mcpfd)
                        for setting, previous in changed_settings:
                            # An atomic write can fail before changing the file.
                            if read_file(statefd, setting) != previous:
                                atomic_write(statefd, setting, previous)
                        raise
                    finally:
                        os.close(backups)
                    return {"id": name, "removed": True}
                if operation == "mcp_cache_failure":
                    cachefd = directory(statefd, ".cache")
                    try:
                        fcntl.flock(cachefd, fcntl.LOCK_EX)
                        cached = json.loads(read_cache(cachefd, name + ".json") or b"{}")
                        # A late failure must not invalidate a newer discovery.
                        if (cached.get("version") != revision or payload.get("discovered_at") is None
                                or cached.get("discovered_at") != payload["discovered_at"]):
                            return {"conflict": True}
                        atomic_write(cachefd, name + ".json", encode_cache({**cached, "refresh_failed": True}))
                    finally:
                        os.close(cachefd)
                    return {"id": name, "version": revision}
                if operation == "mcp_cache":
                    tools = tool_manifest(payload.get("tools"))
                    config = configuration(raw)
                    fingerprint = manifest_version(tools)
                    cachefd = directory(statefd, ".cache")
                    try:
                        fcntl.flock(cachefd, fcntl.LOCK_EX)
                        try:
                            previous = json.loads(read_cache(cachefd, name + ".json") or b"{}")
                            verified = cached_manifest(previous, config, revision)
                        except (ValueError, OSError, RecursionError):
                            verified = None
                        # Keep a verified legacy version across upgrade/reconnect only
                        # when every definition still matches. Never accept a caller alias.
                        if verified and manifest_version(verified[0]) == fingerprint:
                            tools, fingerprint = verified
                        atomic_write(
                            cachefd, name + ".json", encode_cache({
                                "version": revision, "connection_fingerprint": connection_fingerprint(config),
                                "authentication_version": authentication_version(config),
                                "discovered_at": time.time(), "manifest_version": fingerprint,
                                "tools": tools, "server_info": payload.get("server_info", {}),
                            })
                        )
                    finally:
                        os.close(cachefd)
                    return {"id": name, "version": revision, "tools": tools, "manifest_version": fingerprint}
                raise ValueError("不支持的 MCP 配置操作")
            finally:
                os.close(fd)
        finally:
            os.close(mcpfd)
    finally:
        if statefd is not None:
            os.close(statefd)
        os.close(rootfd)


if __name__ == "__main__":
    import sys

    try:
        print(json.dumps(personal_mcp(json.load(sys.stdin))))
    except (ValueError, OSError):
        print(json.dumps({"error": "MCP 配置操作失败，请检查格式、路径和版本后重试"}))
        sys.exit(1)
