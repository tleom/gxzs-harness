import io
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import mcp_policy


def test_policy_rejects_invalid_or_unknown_values_and_cannot_be_edited_by_config():
    with pytest.raises(ValueError):
        mcp_policy.validate({'request_bytes': 0})
    with pytest.raises(ValueError):
        mcp_policy.validate({'max_call_seconds': float('inf')})
    with pytest.raises(ValueError):
        mcp_policy.validate({'owner': 'other'})
    if os.name == 'posix':
        from mcp_ops import configuration
        supplied = configuration(json.dumps({'command': 'node', 'args': [str(i) for i in range(201)],
            'env': {f'KEY_{i}': 'value' for i in range(201)}, 'timeout': 900,
            'resource_policy': {'max_owner_calls': 9999}}).encode())
        assert len(supplied['args']) == len(supplied['env']) == 201
        assert mcp_policy.get('max_owner_calls') == 8


@pytest.mark.skipif(os.name != 'posix', reason='Requires descriptor-based sandbox IO')
def test_request_budget_is_configurable_without_an_extra_result_storage_stage(monkeypatch):
    import mcp_runtime
    limits = mcp_policy.current()
    monkeypatch.setattr(mcp_policy, '_policy', {**limits, 'request_bytes': 4 * 1024 * 1024})
    process = SimpleNamespace(stdin=io.BytesIO())
    assert mcp_runtime.write_request(process, {'arguments': {'text': 'x' * (2 * 1024 * 1024)}}) is None
    assert len(process.stdin.getvalue()) > 2 * 1024 * 1024


@pytest.mark.skipif(os.name != 'posix', reason='Requires the Linux MCP runtime')
def test_invalid_schema_does_not_hide_a_healthy_sibling_tool():
    import asyncio
    pytest.importorskip('mcp')
    from mcp_worker import discover
    definitions = [
        {'name': 'healthy', 'inputSchema': {'type': 'object'}},
        {'name': 'bad', 'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string', 'minLength': 'invalid'}}}},
    ]
    class Page:
        next_cursor = None
        tools = [SimpleNamespace(model_dump=lambda definition=definition, **kwargs: definition) for definition in definitions]
        def model_dump(self, **kwargs):
            return {'tools': definitions}
    class Client:
        async def list_tools(self, **kwargs):
            return Page()
    assert [tool['name'] for tool in asyncio.run(discover(Client()))] == ['healthy']
    assert discover.issues == [{'name': 'bad', 'code': 'MCP_TOOL_UNSUPPORTED'}]
