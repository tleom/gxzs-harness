"""File-backed personal MCP configuration, executed as the owning sandbox user.

Listing never connects to a server or returns credentials. Configurations are the
source of truth; cached tool declarations are valid only for their config hash.
All file traversal follows the same no-symlink contract as personal skills.
"""

import json
import os
import re
import time
import uuid
from urllib.parse import urlsplit

from file_ops import read_file, version
from resource_ops import SETTINGS, PINS, atomic_write, directory, resource_directory

MAX_CONFIG = 65536
MAX_MANIFEST = 1024 * 1024
DISCOVERY_TTL = 300


class ManifestError(ValueError):
    """Safe, actionable discovery failures; never include server-provided text."""

    def __init__(self, message, code="MCP_MANIFEST_INVALID"):
        super().__init__(message)
        self.code = code


def server_name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?", value):
        raise ValueError("MCP 标识需为 1–64 位小写字母、数字或连字符")
    return value


def string_map(value, label):
    if not isinstance(value, dict) or len(value) > 100:
        raise ValueError(label + " 必须是字符串键值对象，最多 100 项")
    if any(not isinstance(k, str) or not isinstance(v, str) or "\x00" in k + v for k, v in value.items()):
        raise ValueError(label + " 必须是字符串键值对象")
    return value


def configuration(raw):
    if not raw or len(raw) > MAX_CONFIG:
        raise ValueError("mcp.json 必须是非空且不超过 64 KiB 的 UTF-8 JSON")
    value = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("MCP 配置必须是 JSON 对象")
    allowed = {"name", "display_name", "description", "transport", "url", "headers", "command", "args", "env", "cwd", "timeout"}
    if set(value) - allowed:
        raise ValueError("MCP 配置包含不支持的字段")
    for key, maximum in (("name", 120), ("display_name", 120), ("description", 2000)):
        if key in value and (not isinstance(value[key], str) or len(value[key]) > maximum):
            raise ValueError("MCP 名称或说明格式无效")
    transport = value.get("transport") or ("stdio" if value.get("command") else "streamable-http")
    if transport == "http":
        transport = "streamable-http"
    if transport not in {"stdio", "streamable-http", "sse"}:
        raise ValueError("transport 需为 stdio、streamable-http 或 sse")
    timeout = value.get("timeout", 60)
    if type(timeout) not in (int, float) or not 5 <= timeout <= 300:
        raise ValueError("MCP 超时需为 5–300 秒")
    value = {**value, "transport": transport, "timeout": timeout}
    if transport == "stdio":
        if any(key in value for key in ("url", "headers")):
            raise ValueError("stdio 配置使用 command、args 和 env")
        command, args = value.get("command"), value.get("args", [])
        if not isinstance(command, str) or not command.strip() or "\x00" in command:
            raise ValueError("缺少有效的 MCP 启动命令")
        if not isinstance(args, list) or len(args) > 100 or any(not isinstance(v, str) or "\x00" in v for v in args):
            raise ValueError("args 必须是字符串数组，最多 100 项")
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
        if not isinstance(url, str) or len(url) > 4096 or any(c in url for c in "\r\n\x00"):
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


def connection_fingerprint(config):
    return version(json.dumps(connection_configuration(config), sort_keys=True,
                              separators=(",", ":")).encode())


def authentication_version(config):
    return version(json.dumps({key: config.get(key, {}) for key in ("headers", "env")},
                              sort_keys=True, separators=(",", ":")).encode())


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
                    pending.append(value)
            elif isinstance(part, list):
                pending.extend(part)
        description = tool.get("description") or name
        if not isinstance(description, str) or len(description) > 16000:
            raise ManifestError("MCP 工具说明过长或无效")
        declaration = {"name": name, "description": description, "inputSchema": schema}
        if output_schema is not None:
            declaration["outputSchema"] = output_schema
        result.append(declaration)
        seen.add(name)
    if len(json.dumps(result).encode()) > MAX_MANIFEST:
        raise ManifestError("MCP 工具目录超过 1 MiB", "MCP_MANIFEST_TOO_LARGE")
    return result


def manifest_version(tools):
    return version(json.dumps(tools, sort_keys=True, separators=(",", ":")).encode())


def mapping(rootfd, name):
    value = json.loads(read_file(rootfd, name) or b"{}")
    if not isinstance(value, dict) or any(not isinstance(v, bool) for v in value.values()):
        raise ValueError("MCP 开关或置顶设置格式无效")
    return value


def raw_configuration(rootfd, name):
    mcpfd = directory(rootfd, "mcp")
    try:
        fd = os.open(server_name(name), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=mcpfd)
    finally:
        os.close(mcpfd)
    try:
        return read_file(fd, "mcp.json")
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
            pins = mapping(mcpfd, PINS)
        except (ValueError, OSError):
            pins = {}
            warnings.append("MCP 置顶文件无效")
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
                    "pinned": pins.get(name, False),
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
                    )
                except (ValueError, OSError, RecursionError):
                    item.update(enabled=False, status="invalid", error="配置无效，请编辑 mcp.json 后重新测试连接")
                    items.append(item)
                    continue
                try:
                    cached = json.loads(read_file(cachefd, name + ".json") or b"{}")
                    if (isinstance(cached, dict) and cached.get("version") == revision
                            and cached.get("connection_fingerprint") == connection_fingerprint(config)
                            and cached.get("authentication_version") == authentication_version(config)
                            and isinstance(cached.get("discovered_at"), (int, float))
                            and 0 <= time.time() - cached["discovered_at"] < DISCOVERY_TTL):
                        tools = tool_manifest(cached.get("tools", []))
                        fingerprint = manifest_version(tools)
                        if fingerprint == cached.get("manifest_version"):
                            item.update(tools=tools, manifest_version=fingerprint, status="ready",
                                        discovered_at=cached["discovered_at"])
                except (ValueError, OSError, RecursionError):
                    warnings.append(f"个人 MCP {name} 的目录缓存无效，正在重新发现")
                items.append(item)
            return {"mcp": items, "warnings": warnings}
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
        name = server_name(payload.get("name"))
        if operation == "mcp_save":
            content = payload.get("content")
            if not isinstance(content, str):
                raise ValueError("缺少 MCP 配置")
            configuration(content.encode("utf-8"))
        if operation == "mcp_probe":
            config, revision = load(rootfd, name)
            return {
                "id": name,
                "version": revision,
                "timeout": config["timeout"],
                "enabled": mapping(statefd, SETTINGS).get(name, True),
            }
        if operation in {"mcp_toggle", "mcp_pin"}:
            load(rootfd, name)
            field, filename = ("enabled", SETTINGS) if operation == "mcp_toggle" else ("pinned", PINS)
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
                if operation == "mcp_save"
                else os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=mcpfd)
            )
            try:
                raw = read_file(fd, "mcp.json")
                revision = version(raw)
                if operation == "mcp_read":
                    return {"id": name, "content": (raw or b"").decode("utf-8-sig"), "version": revision}
                if payload.get("version") != revision:
                    return {"conflict": True}
                if operation == "mcp_save":
                    content = payload.get("content")
                    if not isinstance(content, str):
                        raise ValueError("缺少 MCP 配置")
                    data = content.encode("utf-8")
                    config = configuration(data)
                    if raw is None and config.get("name", name) != name:
                        raise ValueError("新插件 JSON 中的 name 必须与调用名称一致")
                    cached = None
                    if raw is not None:
                        try:
                            if connection_configuration(configuration(raw)) == connection_configuration(config):
                                cachefd = directory(statefd, ".cache")
                                try:
                                    cached = json.loads(read_file(cachefd, name + ".json") or b"{}")
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
                    atomic_write(fd, "mcp.json", data)
                    if cached is not None:
                        cachefd = directory(statefd, ".cache")
                        try:
                            atomic_write(cachefd, name + ".json", json.dumps({
                                **cached, "version": version(data)
                            }).encode())
                        finally:
                            os.close(cachefd)
                    return {"id": name, "version": version(data)}
                if operation == "mcp_delete":
                    backups = directory(statefd, ".backups")
                    try:
                        os.rename(name, name + "-" + uuid.uuid4().hex, src_dir_fd=mcpfd, dst_dir_fd=backups)
                    finally:
                        os.close(backups)
                    cachefd = directory(statefd, ".cache")
                    try:
                        try:
                            os.unlink(name + ".json", dir_fd=cachefd)
                        except FileNotFoundError:
                            pass
                    finally:
                        os.close(cachefd)
                    for setting in (SETTINGS, PINS):
                        try:
                            values = mapping(statefd, setting)
                        except (ValueError, OSError):
                            continue
                        values.pop(name, None)
                        atomic_write(statefd, setting, json.dumps(values).encode())
                    return {"id": name, "removed": True}
                if operation == "mcp_cache":
                    tools = tool_manifest(payload.get("tools"))
                    config = configuration(raw)
                    cachefd = directory(statefd, ".cache")
                    try:
                        atomic_write(
                            cachefd, name + ".json", json.dumps({
                                "version": revision, "connection_fingerprint": connection_fingerprint(config),
                                "authentication_version": authentication_version(config),
                                "discovered_at": time.time(), "manifest_version": manifest_version(tools),
                                "tools": tools,
                            }).encode()
                        )
                    finally:
                        os.close(cachefd)
                    return {"id": name, "version": revision, "tools": tools}
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
