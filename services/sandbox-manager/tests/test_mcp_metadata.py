"""Personal MCP presentation metadata must not disconnect unchanged tools."""

import importlib.util
import copy
import json
import os
from pathlib import Path
import sys

import pytest


pytestmark = pytest.mark.skipif(os.name != "posix", reason="Requires POSIX descriptor operations")


@pytest.fixture
def ops():
    base = Path(__file__).parents[1]
    for name in ("file_ops", "resource_ops", "mcp_ops"):
        spec = importlib.util.spec_from_file_location(name, base / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules["mcp_ops"]


def config(**changes):
    return json.dumps({
        "name": "demo",
        "display_name": "旧展示名",
        "description": "旧说明",
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        **changes,
    })


def test_manifest_is_independent_of_tool_order_but_preserves_definition_changes(ops):
    tools = [{"name": f"tool_{i}", "description": "中文工具", "inputSchema": {"type": "object",
              "properties": {"value": {"type": "array", "prefixItems": [{"type": "string"}, {"type": "number"}]}}}}
             for i in range(226)]
    assert ops.manifest_version(tools) == ops.manifest_version(list(reversed(tools)))
    changed = copy.deepcopy(tools)
    changed[0]["inputSchema"]["properties"]["value"]["prefixItems"].reverse()
    assert ops.manifest_version(tools) != ops.manifest_version(changed)
    assert ops.manifest_version(tools) != ops.manifest_version(tools[:-1])


def test_legacy_cache_survives_reordered_refresh_without_changing_run_binding(ops, tmp_path):
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    tools = [{"name": name, "description": "", "inputSchema": {"type": "object"}} for name in ("z", "a")]
    request = {"operation": "mcp_cache", "name": "demo", "version": saved["version"], "tools": tools}
    ops.personal_mcp(request, str(tmp_path))
    path = tmp_path / "mcp/.cache/demo.json"
    cache = json.loads(path.read_text())
    legacy = ops.legacy_manifest_version(tools)
    path.write_text(json.dumps({**cache, "tools": tools, "manifest_version": legacy}))
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["manifest_version"] == legacy
    refreshed = ops.personal_mcp({**request, "tools": list(reversed(tools))}, str(tmp_path))
    assert refreshed["manifest_version"] == legacy
    assert refreshed["tools"] == tools
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["status"] == "ready"
    changed = [{**tools[0], "annotations": {"readOnlyHint": False}}, tools[1]]
    fresh = ops.personal_mcp({**request, "tools": changed}, str(tmp_path))
    assert fresh["manifest_version"] == ops.manifest_version(changed) != legacy


@pytest.mark.parametrize("field", ["version", "connection_fingerprint", "authentication_version", "manifest_version"])
def test_refresh_never_retains_unverified_legacy_binding(ops, tmp_path, field):
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    tools = [{"name": name, "description": "", "inputSchema": {"type": "object"}} for name in ("z", "a")]
    request = {"operation": "mcp_cache", "name": "demo", "version": saved["version"], "tools": tools}
    ops.personal_mcp(request, str(tmp_path))
    path = tmp_path / "mcp/.cache/demo.json"
    cache = json.loads(path.read_text())
    path.write_text(json.dumps({**cache, "manifest_version": ops.legacy_manifest_version(tools), field: "changed"}))
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["status"] == "unverified"
    assert ops.personal_mcp(request, str(tmp_path))["manifest_version"] == ops.manifest_version(tools)


def test_full_metadata_survives_manifest_cache(ops, tmp_path):
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "my_plugin", "content": config(name="my_plugin")}, str(tmp_path))
    tool = {"name": "lookup", "description": "", "inputSchema": {"type": "object"},
            "annotations": {"readOnlyHint": True, "title": "完整标题"}, "execution": {"taskSupport": "required"}}
    ops.personal_mcp({"operation": "mcp_cache", "name": "my_plugin", "version": saved["version"], "tools": [tool]}, str(tmp_path))
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["tools"] == [tool]


def test_legacy_digit_name_remains_readable_and_can_be_explicitly_renamed(ops, tmp_path):
    folder = tmp_path / "mcp" / "9old"
    folder.mkdir(parents=True)
    (folder / "mcp.json").write_text(config(name="9old"))
    current = ops.personal_mcp({"operation": "mcp_read", "name": "9old"}, str(tmp_path))
    with pytest.raises(ValueError):
        ops.personal_mcp({"operation": "mcp_toggle", "name": "9old", "enabled": True}, str(tmp_path))
    renamed = ops.personal_mcp({"operation": "mcp_save", "name": "9old", "new_name": "valid_name", "version": current["version"],
                               "content": config(name="valid_name")}, str(tmp_path))
    assert renamed["id"] == "valid_name"
    assert not folder.exists()


def test_server_output_schema_survives_cache_and_changes_manifest(ops, tmp_path):
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    tool = {"name": "lookup", "description": "Lookup", "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object", "properties": {"found": {"type": "boolean"}}, "required": ["found"]}}
    ops.personal_mcp({"operation": "mcp_cache", "name": "demo", "version": saved["version"], "tools": [tool]}, str(tmp_path))
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["tools"] == [tool]
    assert ops.manifest_version([tool]) != ops.manifest_version([{**tool, "outputSchema": {"type": "object"}}])
    with pytest.raises(ValueError):
        ops.tool_manifest([{**tool, "outputSchema": {"type": "object", "$ref": "https://example.com/schema"}}])


def test_metadata_edit_preserves_manifest_but_connection_edit_invalidates_it(ops, tmp_path):
    save = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    tools = [{"name": "lookup", "description": "Lookup", "inputSchema": {"type": "object"}}]
    ops.personal_mcp({"operation": "mcp_cache", "name": "demo", "version": save["version"],
                      "tools": tools}, str(tmp_path))
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["status"] == "ready"

    updated = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "version": save["version"],
                                "content": config(display_name="新展示名", description="新说明")}, str(tmp_path))
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["name"] == "新展示名"
    assert item["description"] == "新说明"
    assert item["call_name"] == "demo"
    assert item["status"] == "ready" and item["tools"] == tools
    assert item['runtime_version'] == save['runtime_version'] == updated['runtime_version']
    assert updated['version'] != save['version'] and updated['connection_changed'] is False
    assert ops.personal_mcp({'operation': 'mcp_save', 'name': 'demo', 'version': save['version'],
                             'content': config(display_name='stale')}, str(tmp_path)) == {'conflict': True}

    ops.personal_mcp({"operation": "mcp_save", "name": "demo", "version": updated["version"],
                      "content": config(url="https://other.example.com/mcp")}, str(tmp_path))
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["status"] == "unverified"
    assert ops.personal_mcp({'operation': 'mcp_probe', 'name': 'demo'}, str(tmp_path))['runtime_version'] != save['runtime_version']


@pytest.mark.parametrize('legacy', [False, True])
def test_unicode_cache_remains_readable_at_wire_budget(ops, tmp_path, monkeypatch, legacy):
    original = ops.policy
    monkeypatch.setattr(ops, 'policy', lambda key: 4096 if key == 'response_bytes' else original(key))
    saved = ops.personal_mcp({'operation': 'mcp_save', 'name': 'demo', 'content': config()}, str(tmp_path))
    request = {'operation': 'mcp_cache', 'name': 'demo', 'version': saved['runtime_version'],
               'tools': [{'name': 'lookup', 'description': '查' * 1000, 'inputSchema': {'type': 'object'}}]}
    ops.personal_mcp(request, str(tmp_path))
    path = tmp_path / 'mcp/.cache/demo.json'
    if legacy:
        path.write_text(json.dumps(json.loads(path.read_text())))
        assert path.stat().st_size > 4096
    snapshot = ops.personal_mcp({'operation': 'mcp_list'}, str(tmp_path))
    assert snapshot['mcp'][0]['status'] == 'ready' and snapshot['mcp'][0]['tools'] == request['tools']
    assert not snapshot['warnings']
    with pytest.raises(ops.ManifestError, match='传输预算'):
        ops.personal_mcp({**request, 'tools': [{**request['tools'][0], 'description': '查' * 1400}]}, str(tmp_path))
    assert ops.personal_mcp({'operation': 'mcp_list'}, str(tmp_path))['mcp'][0]['tools'] == request['tools']


def test_cache_envelope_can_exceed_wire_size_without_becoming_unreadable(ops, tmp_path, monkeypatch):
    original = ops.policy
    monkeypatch.setattr(ops, 'policy', lambda key: 1024 if key == 'response_bytes' else original(key))
    saved = ops.personal_mcp({'operation': 'mcp_save', 'name': 'demo', 'content': config()}, str(tmp_path))
    tools = [{'name': 'lookup', 'description': 'x' * 650, 'inputSchema': {'type': 'object'}}]
    ops.personal_mcp({'operation': 'mcp_cache', 'name': 'demo', 'version': saved['version'], 'tools': tools}, str(tmp_path))
    assert (tmp_path / 'mcp/.cache/demo.json').stat().st_size > 1024
    assert ops.personal_mcp({'operation': 'mcp_list'}, str(tmp_path))['mcp'][0]['tools'] == tools


def test_new_config_rejects_name_different_from_call_name(ops, tmp_path):
    with pytest.raises(ValueError, match="name"):
        ops.personal_mcp({"operation": "mcp_save", "name": "demo",
                          "content": config(name="different")}, str(tmp_path))


def test_discovery_age_requests_refresh_and_authentication_edit_invalidates(ops, tmp_path, monkeypatch):
    now = 1_000_000
    monkeypatch.setattr(ops.time, "time", lambda: now)
    save = ops.personal_mcp({"operation": "mcp_save", "name": "demo",
                             "content": config(headers={"Authorization": "Bearer old"})}, str(tmp_path))
    tools = [{"name": "lookup", "description": "", "inputSchema": {"type": "object", "required": ["q"]}}]
    ops.personal_mcp({"operation": "mcp_cache", "name": "demo", "version": save["version"],
                      "tools": tools}, str(tmp_path))
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["status"] == "ready"
    monkeypatch.setattr(ops.time, "time", lambda: now + ops.policy('discovery_cache_seconds'))
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["status"] == "ready" and item["refresh_due"] and item["tools"] == tools
    monkeypatch.setattr(ops.time, "time", lambda: now)
    ops.personal_mcp({"operation": "mcp_save", "name": "demo", "version": save["version"],
                      "content": config(headers={"Authorization": "Bearer new"})}, str(tmp_path))
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["status"] == "unverified"


def test_failed_refresh_hides_tools_but_late_failure_cannot_replace_new_discovery(ops, tmp_path, monkeypatch):
    now = [1_000_000]
    monkeypatch.setattr(ops.time, "time", lambda: now[0])
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    cache = {"operation": "mcp_cache", "name": "demo", "version": saved["version"],
             "tools": [{"name": "lookup", "description": "", "inputSchema": {"type": "object"}}]}
    ops.personal_mcp(cache, str(tmp_path))
    failure = {"operation": "mcp_cache_failure", "name": "demo", "version": saved["version"], "discovered_at": now[0]}
    ops.personal_mcp(failure, str(tmp_path))
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["status"] == "unverified" and item["tools"] == [] and item["enabled"]
    now[0] += 1
    ops.personal_mcp(cache, str(tmp_path))
    assert ops.personal_mcp(failure, str(tmp_path)) == {"conflict": True}
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["status"] == "ready" and item["tools"] == cache["tools"]


def test_corrupt_cache_does_not_disable_valid_plugin(ops, tmp_path):
    ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    (tmp_path / "mcp/.cache").mkdir(exist_ok=True)
    (tmp_path / "mcp/.cache" / "demo.json").write_text("not-json", encoding="utf-8")
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["enabled"] is True
    assert item["status"] == "unverified"


def test_rename_keeps_assets_settings_and_cached_tools(ops, tmp_path):
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    tools = [{"name": "lookup", "description": "lookup", "inputSchema": {"type": "object"}, "outputSchema": {"type": "object"}}]
    ops.personal_mcp({"operation": "mcp_cache", "name": "demo", "version": saved["version"], "tools": tools}, str(tmp_path))
    ops.personal_mcp({"operation": "mcp_toggle", "name": "demo", "enabled": False}, str(tmp_path))
    ops.personal_mcp({"operation": "mcp_reorder", "order": ["demo"], "order_version": None}, str(tmp_path))
    (tmp_path / "mcp/demo/server.py").write_text("# local tool", encoding="utf-8")
    result = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "new_name": "renamed",
                               "version": saved["version"], "content": config(name="renamed")}, str(tmp_path))
    assert result["id"] == "renamed"
    assert not (tmp_path / "mcp/demo").exists()
    assert (tmp_path / "mcp/renamed/server.py").read_text() == "# local tool"
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["id"] == item["call_name"] == "renamed"
    assert item["enabled"] is False
    assert item["tools"] == tools and item["status"] == "ready"
    assert not (tmp_path / "mcp/.cache/demo.json").exists()
    assert (tmp_path / "mcp/.cache/renamed.json").exists()


@pytest.mark.parametrize("target", ["../escape", "/absolute", "UPPER", "a/b", "", "9bad", "a" * 65])
def test_invalid_rename_does_not_change_original(ops, tmp_path, target):
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    with pytest.raises(ValueError):
        ops.personal_mcp({"operation": "mcp_save", "name": "demo", "new_name": target,
                          "version": saved["version"], "content": config()}, str(tmp_path))
    assert (tmp_path / "mcp/demo/mcp.json").read_text() == config()


def test_rename_conflict_and_missing_source_do_not_replace_anything(ops, tmp_path):
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    outside = tmp_path / "other"
    outside.mkdir()
    (tmp_path / "mcp/taken").symlink_to(outside, target_is_directory=True)
    for target in ("taken", "demo"):
        result = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "new_name": target,
                                   "version": "stale", "content": config(name=target)}, str(tmp_path))
        assert result == {"conflict": True}
    result = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "new_name": "taken",
                               "version": saved["version"], "content": config(name="taken")}, str(tmp_path))
    assert result == {"conflict": True}
    assert (tmp_path / "mcp/taken").is_symlink() and not list(outside.iterdir())
    with pytest.raises(FileNotFoundError):
        ops.personal_mcp({"operation": "mcp_save", "name": "missing", "new_name": "renamed",
                          "content": config(name="renamed")}, str(tmp_path))
    assert not (tmp_path / "mcp/missing").exists()
    assert not (tmp_path / "mcp/renamed").exists()
    assert (tmp_path / "mcp/demo/mcp.json").read_text() == config()


@pytest.mark.parametrize("failure", ["mcp.json", ".order.json", "renamed.json"])
@pytest.mark.parametrize("transport", ["streamable-http", "stdio"])
def test_rename_rolls_back_config_settings_and_cache_on_save_failure(ops, tmp_path, monkeypatch, failure, transport):
    content = config() if transport == "streamable-http" else json.dumps({
        "name": "demo", "transport": "stdio", "command": "python",
        "args": ["/workspace/mcp/demo/server.py"], "cwd": "/workspace/mcp/demo"})
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": content}, str(tmp_path))
    ops.personal_mcp({"operation": "mcp_cache", "name": "demo", "version": saved["version"],
                      "tools": [{"name": "lookup", "inputSchema": {"type": "object"}}]}, str(tmp_path))
    ops.personal_mcp({"operation": "mcp_toggle", "name": "demo", "enabled": False}, str(tmp_path))
    ops.personal_mcp({"operation": "mcp_reorder", "order": ["demo"], "order_version": None}, str(tmp_path))
    paths = ["demo/mcp.json", ".settings.json", ".order.json", ".cache/demo.json"]
    previous = {path: (tmp_path / "mcp" / path).read_bytes() for path in paths}
    original_write = ops.atomic_write
    injected = False

    def fail_once(fd, filename, data):
        nonlocal injected
        if not injected and filename == failure:
            injected = True
            raise OSError("injected save failure")
        return original_write(fd, filename, data)

    monkeypatch.setattr(ops, "atomic_write", fail_once)
    if transport == "stdio" and failure == "renamed.json":
        original_unlink = ops.os.unlink

        def fail_cache_removal(filename, *args, **kwargs):
            nonlocal injected
            if not injected and filename == "demo.json":
                injected = True
                raise OSError("injected save failure")
            return original_unlink(filename, *args, **kwargs)

        monkeypatch.setattr(ops.os, "unlink", fail_cache_removal)
    with pytest.raises(OSError, match="injected"):
        ops.personal_mcp({"operation": "mcp_save", "name": "demo", "new_name": "renamed",
                          "version": saved["version"], "content": json.dumps({**json.loads(content), "name": "renamed"})}, str(tmp_path))
    assert injected
    assert not (tmp_path / "mcp/renamed").exists()
    assert not (tmp_path / "mcp/.cache/renamed.json").exists()
    assert {path: (tmp_path / "mcp" / path).read_bytes() for path in paths} == previous


def test_old_client_save_and_rename_connection_change(ops, tmp_path):
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": config()}, str(tmp_path))
    # Older callers store the display label in name and do not send new_name.
    updated = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "version": saved["version"],
                                "content": config(name="旧展示名")}, str(tmp_path))
    ops.personal_mcp({"operation": "mcp_cache", "name": "demo", "version": updated["version"],
                      "tools": [{"name": "lookup", "inputSchema": {"type": "object"}}]}, str(tmp_path))
    result = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "new_name": "renamed",
                               "version": updated["version"], "content": config(name="renamed", url="https://other.example.com/mcp")}, str(tmp_path))
    assert result["id"] == "renamed"
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["status"] == "unverified" and item["tools"] == []


def test_stdio_rename_relocates_only_literal_paths_inside_own_package(ops, tmp_path):
    content = json.dumps({"name": "demo", "transport": "stdio", "command": "/workspace/mcp/demo/python",
                          "args": ["/workspace/mcp/demo/server.py", "/workspace/mcp/demo-other/server.py", "server.py",
                                   "-c", "print('/workspace/mcp/demo/server.py')", "/workspace/mcp/demo/server.py --flag"],
                          "cwd": "/workspace/mcp/demo", "env": {"EXAMPLE": "/workspace/mcp/demo/data"}})
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": content}, str(tmp_path))
    package = tmp_path / "mcp/demo"
    (package / "server.py").write_text("# tool", encoding="utf-8")
    (package / "python").write_text("# launcher", encoding="utf-8")
    renamed_content = json.dumps({**json.loads(content), "name": "new-name"})
    result = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "new_name": "new-name",
                               "version": saved["version"], "content": renamed_content}, str(tmp_path))
    read = ops.personal_mcp({"operation": "mcp_read", "name": "new-name"}, str(tmp_path))
    assert read["version"] == result["version"]
    value = json.loads(read["content"])
    assert value["name"] == "new-name"
    assert value["command"] == "/workspace/mcp/new-name/python"
    assert value["cwd"] == "/workspace/mcp/new-name"
    assert value["args"][0] == "/workspace/mcp/new-name/server.py"
    assert value["args"][1:] == json.loads(content)["args"][1:]
    assert value["env"] == json.loads(content)["env"]
    assert (tmp_path / value["args"][0].removeprefix("/workspace/")).read_text() == "# tool"


def test_stdio_rename_preserves_real_paths_with_spaces_and_does_not_follow_links(ops, tmp_path):
    content = json.dumps({"name": "demo", "transport": "stdio", "command": "/workspace/mcp/demo/python launcher",
                          "args": ["/workspace/mcp/demo/server file.py", "/workspace/mcp/demo/tool data/", "/workspace/mcp/demo/",
                                   "/workspace/mcp/demo/server file.py --mode test", "echo /workspace/mcp/demo/server file.py",
                                   "/workspace/mcp/demo-other/server file.py", "server file.py",
                                   "/workspace/mcp/demo/missing.py", "/workspace/mcp/demo/external/file.py",
                                   "/workspace/mcp/demo/file-link.py"],
                          "cwd": "/workspace/mcp/demo/tool data/", "env": {"EXAMPLE": "/workspace/mcp/demo/server file.py"}})
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": content}, str(tmp_path))
    package = tmp_path / "mcp/demo"
    (package / "python launcher").write_text("# launcher", encoding="utf-8")
    (package / "server file.py").write_text("# real tool", encoding="utf-8")
    (package / "tool data").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "file.py").write_text("# external", encoding="utf-8")
    (package / "external").symlink_to(outside, target_is_directory=True)
    (package / "file-link.py").symlink_to(outside / "file.py")
    ops.personal_mcp({"operation": "mcp_save", "name": "demo", "new_name": "renamed",
                      "version": saved["version"], "content": json.dumps({**json.loads(content), "name": "renamed"})}, str(tmp_path))
    read = ops.personal_mcp({"operation": "mcp_read", "name": "renamed"}, str(tmp_path))
    value = json.loads(read["content"])
    assert value["command"] == "/workspace/mcp/renamed/python launcher"
    assert value["cwd"] == "/workspace/mcp/renamed/tool data/"
    assert value["args"][:3] == ["/workspace/mcp/renamed/server file.py", "/workspace/mcp/renamed/tool data/", "/workspace/mcp/renamed/"]
    assert value["args"][3:] == json.loads(content)["args"][3:]
    assert value["env"] == json.loads(content)["env"]
    assert (tmp_path / value["args"][0].removeprefix("/workspace/")).read_text() == "# real tool"
    assert (outside / "file.py").read_text() == "# external"
