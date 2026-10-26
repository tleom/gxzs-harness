"""A persistent MCP connection inside one owner's sandbox, driven over private stdio.

The manager starts this interpreter through `env -i`. Its stdout is the manager
protocol, never the MCP server's stdout. A failed or timed-out business call is
reported once and the connection closes; it is never replayed automatically.
"""

import asyncio
import json
import os
import sys
import time
import hashlib
from contextlib import AsyncExitStack, asynccontextmanager

import httpx2
from jsonschema import Draft202012Validator
from jsonschema.validators import validator_for
from jsonschema.exceptions import SchemaError
from mcp import Client
from mcp.client.extension import advertise
from mcp.client.sse import sse_client
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client
import mcp.client.streamable_http as http_transport
from mcp_ops import ManifestError, load, manifest_version, personal_mcp, tool_manifest, configuration
from mcp_protocol import metadata, request as protocol_request
from mcp_task_transport import TaskTransport
from mcp_policy import get as policy


class PolicyEventSource(httpx2.EventSource):
    def __init__(self, response, max_event_size=None):
        super().__init__(response, max_event_size=policy('response_bytes'))


# MCP SDK 2.2 constructs EventSource directly, bypassing AsyncClient.sse.
# Adapt only this sandbox-local interpreter; retain SDK redirect/cancel logic.
httpx2.EventSource = PolicyEventSource
http_transport.EventSource = PolicyEventSource


def emit(value, encoded=None):
    encoded = encoded if encoded is not None else json.dumps(value, ensure_ascii=False).encode()
    if len(encoded) + 1 > policy('response_bytes'):
        discovery = bool(value.get('ready'))
        failure = {
                "error": "MCP 完整工具目录超过可配置的响应传输预算" if discovery else
                         "MCP 响应已收到但超过可配置的传输预算，请勿自动重放业务调用",
                "code": "MCP_DISCOVERY_TOO_LARGE" if discovery else "MCP_RESPONSE_TOO_LARGE",
            }
        if 'request_id' in value:
            failure['request_id'] = value['request_id']
        encoded = json.dumps(failure).encode()
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.write(b'\n')
    sys.stdout.buffer.flush()


async def discover(client):
    tools, cursor, visited = [], None, set()
    while True:
        page = await client.list_tools(cursor=cursor, cache_mode="refresh")
        if len(json.dumps(page.model_dump(mode='json', by_alias=True, exclude_none=True), ensure_ascii=False).encode()) > policy('response_bytes'):
            raise ManifestError('MCP 工具发现响应超过传输预算', 'MCP_DISCOVERY_TOO_LARGE')
        declarations = [
            item.model_dump(mode="json", by_alias=True, exclude_none=True)
            for item in page.tools
        ]
        tools.extend(declarations)
        cursor = page.next_cursor
        if not cursor:
            break
        stamp = hashlib.sha256(cursor.encode()).digest()
        if stamp in visited:
            raise ManifestError("MCP 工具目录分页游标重复", "MCP_MANIFEST_CURSOR_REPEAT")
        visited.add(stamp)
    valid, blocked, issues = {}, set(), []
    for declaration in tools:
        name = declaration.get('name')
        try:
            checked = tool_manifest([declaration])[0]
            if name in valid or name in blocked:
                valid.pop(name, None)
                blocked.add(name)
                raise ManifestError('MCP 工具名称重复')
            validator_for(checked['inputSchema'], default=Draft202012Validator).check_schema(checked['inputSchema'])
            if 'outputSchema' in checked:
                validator_for(checked['outputSchema'], default=Draft202012Validator).check_schema(checked['outputSchema'])
            valid[name] = checked
        except (ValueError, TypeError, KeyError, SchemaError):
            issues.append({'name': name if isinstance(name, str) else '', 'code': 'MCP_TOOL_UNSUPPORTED'})
    discover.issues = issues
    return list(valid.values())


async def connected(awaitable, disconnected, timeout):
    """EOF cancels an in-flight call as well as an idle reader."""
    task = asyncio.ensure_future(awaitable)
    ended = asyncio.create_task(disconnected.wait())
    try:
        done, _ = await asyncio.wait(
            (task, ended), timeout=timeout, return_when=asyncio.FIRST_COMPLETED
        )
        if ended in done:
            raise ConnectionError("Manager disconnected")
        if task not in done:
            raise TimeoutError()
        return await task
    finally:
        for item in (task, ended):
            if not item.done():
                item.cancel()
        await asyncio.gather(task, ended, return_exceptions=True)


def publish_catalog(name, root, revision, tools, fingerprint, server_info, global_scope):
    ready = {'ready': True, 'version': revision, 'manifest_version': fingerprint,
             'tools': tools, 'server_info': server_info}
    encoded = json.dumps(ready, ensure_ascii=False).encode()
    if len(encoded) + 1 > policy('response_bytes'):
        raise ManifestError('MCP 完整工具目录超过可配置的响应传输预算', 'MCP_DISCOVERY_TOO_LARGE')
    cached = {} if global_scope else personal_mcp({
        'operation': 'mcp_cache', 'name': name, 'version': revision, 'tools': tools,
        'issues': getattr(discover, 'issues', []), 'server_info': server_info,
    }, root)
    if not cached.get('conflict') and cached.get('manifest_version'):
        ready['manifest_version'] = cached['manifest_version']
        ready['tools'] = cached['tools']
        encoded = json.dumps(ready, ensure_ascii=False).encode()
    emit(cached if cached.get('conflict') else ready, None if cached.get('conflict') else encoded)
    return None if cached.get('conflict') else ready['manifest_version']


async def serve(name, expected_version, root="/workspace", global_config=None):
    if global_config is not None:
        config = configuration(json.dumps(global_config).encode())
        if config["transport"] != "stdio":
            raise ValueError("全局沙盒 MCP 仅支持 stdio")
        revision = expected_version
    else:
        config, revision = load_personal(name, root)
    await serve_connection(name, expected_version, root, config, revision, global_config is not None)


def load_personal(name, root):
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        config, revision = load(rootfd, name)
    finally:
        os.close(rootfd)
    return config, revision


async def serve_connection(name, expected_version, root, config, revision, global_scope):
    if revision != expected_version:
        emit({"conflict": True})
        return
    timeout = config["timeout"]
    async with AsyncExitStack() as stack:
        if config["transport"] == "stdio":
            # Personal workers use the owner's environment. Platform workers run
            # in a separate trusted container without owner files or processes.
            transport = stdio_client(
                StdioServerParameters(
                    command=config["command"],
                    args=config["args"],
                    env=config["env"],
                    cwd=os.path.join(
                        root, os.path.relpath(config["cwd"], "/workspace")
                    ),
                ),
                errlog=stack.enter_context(open(os.devnull, "w")),
            )
        else:
            if config["transport"] == "sse":
                transport = sse_client(
                    config["url"],
                    httpx_client_factory=lambda **_: httpx2.AsyncClient(
                        headers=config["headers"],
                        timeout=httpx2.Timeout(None, connect=policy("connect_timeout_seconds"), write=policy('write_timeout_seconds')),
                        trust_env=False,
                    ),
                    timeout=policy("connect_timeout_seconds"),
                    sse_read_timeout=policy('max_call_seconds'),
                )
            else:
                http = await stack.enter_async_context(
                    httpx2.AsyncClient(
                        headers=config["headers"],
                        timeout=httpx2.Timeout(None, connect=policy("connect_timeout_seconds"), write=policy('write_timeout_seconds')),
                        trust_env=False,
                    )
                )
                transport = streamable_http_client(config["url"], http_client=http)
        async with asyncio.timeout(policy('connect_timeout_seconds')):
            streams = await stack.enter_async_context(transport)

        task_transport = TaskTransport(streams)

        async with asyncio.timeout(policy('initialize_timeout_seconds')):
            client = await stack.enter_async_context(
                Client(task_transport.transport(), read_timeout_seconds=policy("discovery_timeout_seconds"),
                       extensions=[advertise('io.modelcontextprotocol/tasks')])
            )
        server_info = task_transport.server_info or metadata(client)
        task_expiries = {}
        active_tasks = set()
        tools = await asyncio.wait_for(discover(client), policy("discovery_timeout_seconds")) if "tools" in server_info["capabilities"] else []
        fingerprint = manifest_version(tools)
        fingerprint = publish_catalog(name, root, revision, tools, fingerprint, server_info, global_scope)
        if fingerprint is None:
            return
        reader = asyncio.StreamReader(limit=policy("request_bytes"))
        pipe, _ = await asyncio.get_running_loop().connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
        )
        requests, disconnected = asyncio.Queue(maxsize=2), asyncio.Event()

        async def receive():
            try:
                while line := await reader.readline():
                    await requests.put(line)
            finally:
                disconnected.set()

        pending_tasks = set()

        async def handle_task(request):
            def respond(value):
                if 'request_id' in request:
                    value['request_id'] = request['request_id']
                emit(value)
            try:
                for task_id, expiry in list(task_expiries.items()):
                    if expiry <= time.time() * 1000:
                        task_expiries.pop(task_id)
                        active_tasks.discard(task_id)
                if request.get('manifest_version') != fingerprint:
                    raise ValueError('MCP 能力声明已改变')
                method, params = request['method'], request['params']
                if method == 'tools/call':
                    tool = next((item for item in tools if item['name'] == params.get('name')), None)
                    if tool is None or not validator_for(tool['inputSchema'], default=Draft202012Validator)(tool['inputSchema']).is_valid(params.get('arguments', {})):
                        raise ValueError('MCP 工具或参数无效')
                elif params.get('taskId') not in task_expiries:
                    raise ValueError('MCP 任务连接已失效，请核实外部状态')
                remaining = (request['deadline_ms'] - time.time() * 1000) / 1000
                if remaining <= 0:
                    raise TimeoutError()
                response = await connected(task_transport.request(method, params, client.protocol_version, client.session), disconnected, min(timeout, remaining))
                result = response.get('result', {})
                task = result.get('task', result if result.get('resultType') == 'task' else {})
                if method == 'tools/call' and isinstance(task.get('taskId'), str):
                    task_expiries[task['taskId']] = request['deadline_ms']
                    active_tasks.add(task['taskId'])
                settled = (method == 'tasks/result' and isinstance(result.get('content'), list)
                           or result.get('taskId') == params.get('taskId') and (
                               result.get('status') in {'failed', 'cancelled'}
                               or result.get('status') == 'completed' and isinstance(result.get('result'), dict)
                               and isinstance(result['result'].get('content'), list)))
                if settled:
                    active_tasks.discard(params.get('taskId'))
                # Keep the known reference until its original deadline so a lost
                # reply can be queried again without pinning an already settled task.
                response['tasks_active_until'] = max((task_expiries[t] for t in active_tasks), default=0)
                respond(response)
            except ValueError as error:
                respond({'error': str(error)})
            except TimeoutError:
                read_only = request.get('method') in {'tasks/get', 'tasks/result'}
                respond({'error': 'MCP 任务查询超时，任务仍可查询或取消' if read_only else 'MCP 任务通信超时，结果未知；请核实外部状态',
                         'code': 'MCP_TASK_TIMEOUT', 'uncertain': not read_only})
            except Exception:
                respond({'error': 'MCP 任务通信中断，结果未知；请核实外部状态', 'uncertain': True,
                         'connection_lost': task_transport.closed})

        receiver = asyncio.create_task(receive())
        try:
            while True:
                try:
                    line = await connected(requests.get(), disconnected, None)
                except (TimeoutError, ConnectionError):
                    return
                if not line:
                    return
                request = json.loads(line)
                state = {"version": revision, "enabled": True} if global_scope else personal_mcp({"operation": "mcp_probe", "name": name}, root)
                if state["version"] != revision:
                    emit({"conflict": True, **({'request_id': request['request_id']} if 'request_id' in request else {})})
                    return
                if request.get("operation") == "mcp_test":
                    # Active Tasks retain their negotiated declarations. Normal
                    # refresh reuses this SDK connection and private data.
                    if max((task_expiries[t] for t in active_tasks), default=0) <= time.time() * 1000 and 'tools' in server_info['capabilities']:
                        remaining = (request.get('deadline_ms', int(time.time()*1000 + policy('discovery_timeout_seconds')*1000)) - time.time()*1000) / 1000
                        tools = await connected(discover(client), disconnected, min(policy('discovery_timeout_seconds'), remaining))
                        fingerprint = manifest_version(tools)
                    fingerprint = publish_catalog(name, root, revision, tools, fingerprint, server_info, global_scope)
                    if fingerprint is None:
                        return
                    continue
                if not state["enabled"]:
                    emit({"error": "个人 MCP 已停用", **({'request_id': request['request_id']} if 'request_id' in request else {})})
                    return
                if request.get("operation") == "mcp_task":
                    task = asyncio.create_task(handle_task(request))
                    pending_tasks.add(task)
                    task.add_done_callback(pending_tasks.discard)
                    continue
                if request.get("operation") in {"mcp_browse", "mcp_request"}:
                    try:
                        if request.get("operation") == "mcp_request" and request.get("manifest_version") != fingerprint:
                            raise ValueError("MCP 能力声明已改变，请开始新一轮任务")
                        remaining = (request.get('deadline_ms', int(time.time() * 1000 + timeout * 1000)) - time.time() * 1000) / 1000
                        if remaining <= 0:
                            raise ValueError("MCP 请求已过期")
                        result = await connected(protocol_request(client, request.get("method"), request.get("params", {})), disconnected, min(timeout, remaining))
                        emit({"result": result})
                    except ValueError as error:
                        emit({"error": str(error)})
                    except Exception:
                        emit({"error": "MCP 内容读取失败，请检查连接后重试"})
                    continue
                if request.get("manifest_version") != fingerprint:
                    emit({"error": "MCP 工具声明已改变，请刷新插件后开始新一轮任务"})
                    continue
                tool = next(
                    (item for item in tools if item["name"] == request.get("tool")),
                    None,
                )
                arguments = request.get("arguments", {})
                if tool is None or not isinstance(arguments, dict):
                    emit({"error": "MCP 工具或参数无效"})
                    continue
                validator = validator_for(tool['inputSchema'], default=Draft202012Validator)(tool['inputSchema'])
                if not validator.is_valid(arguments):
                    emit({"error": "MCP 工具参数不符合声明"})
                    continue
                try:
                    remaining = (request.get('deadline_ms', int(time.time() * 1000 + policy('max_call_seconds') * 1000)) - time.time() * 1000) / 1000
                    if remaining <= 0:
                        emit({'error': 'MCP 调用已过期，本次操作未执行', 'code': 'MCP_DEADLINE_EXCEEDED'})
                        continue
                    call_timeout = min(timeout, remaining, policy("max_call_seconds"))
                    # Use the session's one-request API. High-level input-required
                    # loops can repeat a call and are inappropriate for writes.
                    result = await connected(
                        client.session.call_tool(
                            tool["name"],
                            arguments,
                            read_timeout_seconds=call_timeout,
                        ),
                        disconnected,
                        call_timeout,
                    )
                    emit(
                        {
                            "result": result.model_dump(
                                mode="json", by_alias=True, exclude_none=True
                            )
                        }
                    )
                except Exception:
                    emit(
                        {
                            "error": "MCP 调用中断或超时，执行结果未知；请先核实外部状态，不要自动重试",
                            "uncertain": True,
                        }
                    )
                    return
        finally:
            receiver.cancel()
            for task in pending_tasks:
                task.cancel()
            await asyncio.gather(receiver, *pending_tasks, return_exceptions=True)
            pipe.close()


def discovery_failure(error):
    """Transport exception groups must not hide safe manifest diagnostics."""
    if isinstance(error, ManifestError):
        return {"error": str(error), "code": error.code}
    for nested in getattr(error, "exceptions", ()):
        result = discovery_failure(nested)
        if result.get("code"):
            return result
    return {"error": "MCP 连接失败，请检查地址、认证、依赖和服务状态后重新测试"}


if __name__ == "__main__":
    try:
        asyncio.run(serve(sys.argv[1], sys.argv[2], global_config=json.loads(sys.stdin.readline()) if len(sys.argv) > 3 and sys.argv[3] == "global" else None))
    except Exception as error:
        # Exceptions can contain URLs, authorization headers and server stderr.
        emit(discovery_failure(error))
        sys.exit(1)
