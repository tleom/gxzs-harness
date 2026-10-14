"""Large valid catalogs work; discovery remains byte-bounded and diagnosable."""
import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Requires Linux MCP runtime")


@pytest.fixture
def modules():
    pytest.importorskip("mcp")
    base = Path(__file__).parents[1]
    for name in ("file_ops", "resource_ops", "mcp_ops", "mcp_worker"):
        spec = importlib.util.spec_from_file_location(name, base / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules["mcp_ops"], sys.modules["mcp_worker"]


def tool(i, **extra):
    return {"name": f"tool_{i}", "description": "Lookup", "inputSchema": {"type": "object"}, **extra}


class Item:
    def __init__(self, data):
        self.data = data

    def model_dump(self, **_):
        return self.data


class Page:
    def __init__(self, tools, cursor=None):
        self.tools = [Item(value) for value in tools]
        self.next_cursor = cursor

    def model_dump(self, **_):
        return {"tools": [item.data for item in self.tools], "nextCursor": self.next_cursor}


class Client:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.requests = []

    async def list_tools(self, **request):
        self.requests.append(request)
        return next(self.pages)


@pytest.mark.parametrize("count", [319, 1200])
def test_more_than_200_tools_survive_save_cache_and_paged_discovery(modules, tmp_path, count):
    ops, worker = modules
    tools = [tool(i) for i in range(count)]
    client = Client([Page(tools[:180], "page2"), Page(tools[180:])])
    assert asyncio.run(worker.discover(client)) == tools
    assert client.requests == [{"cursor": None, "cache_mode": "refresh"}, {"cursor": "page2", "cache_mode": "refresh"}]
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "demo", "content": json.dumps({"url": "https://example.com/mcp"})}, str(tmp_path))
    ops.personal_mcp({"operation": "mcp_cache", "name": "demo", "version": saved["version"], "tools": tools}, str(tmp_path))
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item["status"] == "ready" and item["tools"] == tools


def test_paged_catalog_is_still_byte_bounded(modules):
    ops, worker = modules
    pages = [Page([tool(i, description="x" * 16000) for i in range(40)], "next"), Page([tool(i, description="x" * 16000) for i in range(40, 80)])]
    with pytest.raises(ops.ManifestError) as error:
        asyncio.run(worker.discover(Client(pages)))
    assert error.value.code in {"MCP_DISCOVERY_TOO_LARGE", "MCP_MANIFEST_TOO_LARGE"}
    with pytest.raises(ops.ManifestError, match="1 MiB"):
        ops.tool_manifest([tool(i, description="x" * 16000) for i in range(80)])


def test_empty_pages_with_distinct_large_cursors_are_byte_bounded(modules):
    ops, worker = modules
    with pytest.raises(ops.ManifestError) as error:
        asyncio.run(worker.discover(Client([Page([], "a" * 600000), Page([], "b" * 600000)])))
    assert error.value.code == "MCP_DISCOVERY_TOO_LARGE"


def test_duplicate_names_and_cursor_loops_are_rejected(modules):
    ops, worker = modules
    with pytest.raises(ops.ManifestError, match="重复"):
        asyncio.run(worker.discover(Client([Page([tool(1)], "next"), Page([tool(1)])])))
    with pytest.raises(ops.ManifestError) as error:
        asyncio.run(worker.discover(Client([Page([], "next"), Page([], "next")])))
    assert error.value.code == "MCP_MANIFEST_CURSOR_REPEAT"


def test_manifest_diagnostic_survives_transport_groups_without_leaking_secrets(modules):
    ops, worker = modules
    error = ExceptionGroup("private endpoint secret", [ValueError("Bearer private-key"), ops.ManifestError("MCP 工具目录超过 1 MiB", "MCP_MANIFEST_TOO_LARGE")])
    assert worker.discovery_failure(error) == {"error": "MCP 工具目录超过 1 MiB", "code": "MCP_MANIFEST_TOO_LARGE"}
    assert "private" not in json.dumps(worker.discovery_failure(ValueError("private key")))


@pytest.mark.parametrize("extra", [{"name": ""}, {"inputSchema": {"type": "string"}}, {"inputSchema": {"type": "object", "$ref": "https://example.com/private"}}])
def test_existing_name_and_schema_constraints_remain(modules, extra):
    ops, _ = modules
    with pytest.raises(ops.ManifestError):
        ops.tool_manifest([tool(1, **extra)])
