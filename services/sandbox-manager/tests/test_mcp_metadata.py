"""Personal MCP presentation metadata must not disconnect unchanged tools."""

import importlib.util
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

    ops.personal_mcp({"operation": "mcp_save", "name": "demo", "version": updated["version"],
                      "content": config(url="https://other.example.com/mcp")}, str(tmp_path))
    assert ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]["status"] == "unverified"


def test_new_config_rejects_name_different_from_call_name(ops, tmp_path):
    with pytest.raises(ValueError, match="name"):
        ops.personal_mcp({"operation": "mcp_save", "name": "demo",
                          "content": config(name="different")}, str(tmp_path))
