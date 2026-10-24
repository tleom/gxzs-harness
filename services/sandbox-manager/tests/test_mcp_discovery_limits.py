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


def test_schema_nodes_do_not_include_literal_data_or_property_names(modules):
    ops, worker = modules
    schema = {"type": "object", "properties": {"$ref": {"type": "string"},
              "options": {"type": "object", "default": {"required": "data", "$ref": "ordinary"}}},
              "required": ["$ref"], "examples": [{"$ref": "literal"}]}
    tools = [tool(1, inputSchema=schema, outputSchema=schema)]
    assert ops.tool_manifest(tools) == tools
    assert asyncio.run(worker.discover(Client([Page(tools)]))) == tools


@pytest.mark.parametrize("keyword", ["items", "not", "contains", "if", "additionalProperties", "contentSchema"])
def test_external_references_at_schema_nodes_still_rejected(modules, keyword):
    ops, _ = modules
    schema = {"type": "object", keyword: {"$ref": "https://external.invalid/schema"}}
    with pytest.raises(ops.ManifestError):
        ops.tool_manifest([tool(1, inputSchema=schema)])


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


def test_manifest_can_exceed_the_previous_aggregate_budget(modules):
    ops, worker = modules
    pages = [Page([tool(i, description="x" * 16000) for i in range(40)], "next"), Page([tool(i, description="x" * 16000) for i in range(40, 80)])]
    assert len(asyncio.run(worker.discover(Client(pages)))) == 80
    assert len(ops.tool_manifest([tool(i, description="x" * 20000) for i in range(80)])) == 80


@pytest.mark.parametrize('schema', [
    {'type': 'object', 'dependentRequired': {'credit': ['billing']}},
    {'$schema': 'https://json-schema.org/draft/2020-12/schema', 'type': 'object', 'dependentRequired': {'credit': ['billing']}},
    {'$schema': 'https://json-schema.org/draft/2019-09/schema', 'type': 'object', 'dependentRequired': {'credit': ['billing']}},
    {'$schema': 'http://json-schema.org/draft-07/schema#', 'type': 'object', 'properties': {'tuple': {'type': 'array', 'items': [{'type': 'string'}]}}},
    {'$schema': 'http://json-schema.org/draft-06/schema#', 'type': 'object', 'properties': {'tuple': {'type': 'array', 'items': [{'type': 'string'}]}}},
])
def test_discovery_respects_default_and_explicit_schema_dialects(modules, schema):
    _, worker = modules
    tools = [tool(1, inputSchema=schema), tool(2)]
    assert asyncio.run(worker.discover(Client([Page(tools)]))) == tools


def test_discovery_retains_the_configured_per_response_transport_budget(modules, monkeypatch):
    ops, worker = modules
    import mcp_policy
    monkeypatch.setattr(mcp_policy, '_policy', {**mcp_policy.current(), 'response_bytes': 1024})
    with pytest.raises(ops.ManifestError) as error:
        asyncio.run(worker.discover(Client([Page([], "a" * 600000), Page([], "b" * 600000)])))
    assert error.value.code == "MCP_DISCOVERY_TOO_LARGE"


def test_protocol_pages_are_merged_once_and_aggregate_overflow_is_a_directory_error(modules, monkeypatch, capsys):
    _, worker = modules
    import mcp_policy
    monkeypatch.setattr(mcp_policy, '_policy', {**mcp_policy.current(), 'response_bytes': 1024})
    pages = [Page([tool(1, description='x' * 600)], 'second'), Page([tool(2, description='x' * 600)])]
    assert all(len(json.dumps(page.model_dump()).encode()) < 1024 for page in pages)
    tools = asyncio.run(worker.discover(Client(pages)))
    assert len(tools) == 2
    worker.emit({'ready': True, 'tools': tools})
    result = json.loads(capsys.readouterr().out)
    assert result['code'] == 'MCP_DISCOVERY_TOO_LARGE'
    assert 'uncertain' not in result and 'ready' not in result


def test_received_oversized_result_is_a_transport_error_without_execution_uncertainty(modules, monkeypatch, capsys):
    _, worker = modules
    import mcp_policy
    monkeypatch.setattr(mcp_policy, '_policy', {**mcp_policy.current(), 'response_bytes': 1024})
    worker.emit({'result': {'content': [{'type': 'text', 'text': 'x' * 2000}]}})
    result = json.loads(capsys.readouterr().out)
    assert result['code'] == 'MCP_RESPONSE_TOO_LARGE'
    assert '已收到' in result['error'] and '勿自动重放' in result['error']
    assert 'uncertain' not in result


def test_resources_only_connection_stays_empty_tools_and_does_not_invent_a_tool(modules, tmp_path):
    ops, worker = modules
    client = Client([Page([])])
    client.server_instructions = 'Resource context is not a tool declaration'
    client.resources = [{'uri': 'fixture://resource', 'name': 'resource'}]
    tools = asyncio.run(worker.discover(client))
    assert tools == []
    assert client.requests == [{"cursor": None, "cache_mode": "refresh"}]
    saved = ops.personal_mcp({"operation": "mcp_save", "name": "context-only",
                             "content": json.dumps({"url": "https://example.com/mcp"})}, str(tmp_path))
    ops.personal_mcp({"operation": "mcp_cache", "name": "context-only", "version": saved["version"],
                      "tools": tools}, str(tmp_path))
    item = ops.personal_mcp({"operation": "mcp_list"}, str(tmp_path))["mcp"][0]
    assert item['status'] == 'ready'  # Connection discovery succeeded; UI must check tools.length.
    assert item['tools'] == []


def test_duplicate_names_and_cursor_loops_are_rejected(modules):
    ops, worker = modules
    found = asyncio.run(worker.discover(Client([Page([tool(1), tool(2)], "next"), Page([tool(1)])])))
    assert [item['name'] for item in found] == ['tool_2']
    assert worker.discover.issues == [{'name': 'tool_1', 'code': 'MCP_TOOL_UNSUPPORTED'}]
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
