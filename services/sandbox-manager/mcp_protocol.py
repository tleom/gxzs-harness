"""Allowlisted MCP resource and prompt access through the existing SDK session."""
from mcp import types


METHODS = {
    'resources/list': ('resources', {'cursor'}),
    'resources/templates/list': ('resources', {'cursor'}),
    'resources/read': ('resources', {'uri'}),
    'prompts/list': ('prompts', {'cursor'}),
    'prompts/get': ('prompts', {'name', 'arguments'}),
}


def metadata(client):
    return {
        'protocolVersion': client.protocol_version,
        'capabilities': client.server_capabilities.model_dump(mode='json', by_alias=True, exclude_none=True),
        'instructions': client.instructions or '',
    }


def validate_request(method, params, capabilities):
    if method not in METHODS or not isinstance(params, dict):
        raise ValueError('MCP 操作不支持')
    capability, fields = METHODS[method]
    if capability not in capabilities:
        raise ValueError('MCP 不支持此能力')
    if params.keys() - fields:
        raise ValueError('MCP 操作参数无效')
    for key in ('cursor', 'uri', 'name'):
        if key in params and (not isinstance(params[key], str) or not params[key]):
            raise ValueError('MCP 操作参数无效')
    if method == 'resources/read' and 'uri' not in params:
        raise ValueError('缺少资源 URI')
    if method == 'prompts/get':
        if 'name' not in params:
            raise ValueError('缺少提示词名称')
        arguments = params.get('arguments', {})
        if not isinstance(arguments, dict) or any(not isinstance(key, str) or not isinstance(value, str) for key, value in arguments.items()):
            raise ValueError('提示词参数必须为文字')


async def request(client, method, params):
    validate_request(method, params, metadata(client)['capabilities'])
    session = client.session
    page = types.PaginatedRequestParams(cursor=params.get('cursor'))
    if method == 'resources/list':
        result = await session.list_resources(params=page)
    elif method == 'resources/templates/list':
        result = await session.list_resource_templates(params=page)
    elif method == 'resources/read':
        result = await session.read_resource(params['uri'])
    elif method == 'prompts/list':
        result = await session.list_prompts(params=page)
    else:
        result = await session.get_prompt(params['name'], params.get('arguments', {}))
    return result.model_dump(mode='json', by_alias=True, exclude_none=True)
