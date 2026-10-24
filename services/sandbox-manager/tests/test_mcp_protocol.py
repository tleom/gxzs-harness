import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import sys
import pytest

import mcp_protocol


def test_closed_request_surface():
    for method, params in [('tools/call', {}), ('resources/read', {'uri': 'x', 'owner_id': 'other'}),
                           ('prompts/get', {'name': 'x', 'arguments': {'a': 1}})]:
        with pytest.raises(ValueError):
            mcp_protocol.validate_request(method, params, {'resources': {}, 'prompts': {}})
    with pytest.raises(ValueError):
        mcp_protocol.validate_request('resources/read', {'uri': 'x'}, {})


def test_real_sdk_resource_templates_and_prompts(tmp_path):
    from mcp import Client
    from mcp.client.stdio import StdioServerParameters, stdio_client
    source = tmp_path / 'server.py'
    source.write_text('''from mcp.server.mcpserver import MCPServer
server = MCPServer("resource-fixture", instructions="Use this fixture's materials")
@server.resource("fixture://document")
def document() -> str:
    return "resource document"
@server.resource("fixture://cases/{case_id}")
def case(case_id: str) -> str:
    return "case " + case_id
@server.prompt()
def analyze(case_id: str) -> str:
    return "analyze " + case_id
server.run(transport="stdio")
''', encoding='utf-8')

    async def check():
        async with Client(stdio_client(StdioServerParameters(command=sys.executable, args=[str(source)]))) as client:
            info = mcp_protocol.metadata(client)
            assert 'resources' in info['capabilities'] and 'prompts' in info['capabilities']
            resources = await mcp_protocol.request(client, 'resources/list', {})
            assert resources['resources'][0]['uri'] == 'fixture://document'
            templates = await mcp_protocol.request(client, 'resources/templates/list', {})
            assert templates['resourceTemplates'][0]['uriTemplate'] == 'fixture://cases/{case_id}'
            result = await mcp_protocol.request(client, 'resources/read', {'uri': 'fixture://cases/42'})
            assert result['contents'][0]['text'] == 'case 42'
            prompts = await mcp_protocol.request(client, 'prompts/list', {})
            assert prompts['prompts'][0]['arguments'][0]['required']
            result = await mcp_protocol.request(client, 'prompts/get', {'name': 'analyze', 'arguments': {'case_id': '42'}})
            assert result['messages'][0]['content']['text'] == 'analyze 42'
    asyncio.run(check())
