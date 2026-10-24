"""Bind signed grants to the exact manager operation, independently of transport."""
from uuid import UUID


def same_json(left, right):
    # Python considers True == 1; JSON authorization must keep them distinct.
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(same_json(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    return left == right


def validate_grant(key, payload, resource_id):
    if payload.get('operation') == 'mcp_request' and not same_json(
            payload.get('arguments'), {'method': payload.get('method'), 'params': payload.get('params', {})}):
        raise ValueError('MCP request does not match its signed parameters')
    if payload.get('operation') == 'mcp_task' and not same_json(payload.get('arguments'),
            {'method': payload.get('method'), 'params': payload.get('params', {}), 'connection_id': payload.get('connection_id', '')}):
        raise ValueError('MCP task does not match its signed parameters')
    grant = payload.get('authorization') or {}
    binding = str(UUID(grant.get('binding_id', '')))
    if (grant.get('workspace_id') != key or grant.get('run_id') != binding
            or grant.get('resource_id') != resource_id
            or payload.get('request_key') != binding + ':' + str(grant.get('request_key'))
            or grant.get('runtime_version', grant.get('version')) != payload.get('version')
            or grant.get('manifest_version') != payload.get('manifest_version')
            or grant.get('deadline_ms') != payload.get('deadline_ms')
            or not isinstance(grant.get('arguments'), dict)
            or not same_json(grant['arguments'], payload.get('arguments'))):
        raise ValueError('MCP operation does not match its signed grant')
    return binding
