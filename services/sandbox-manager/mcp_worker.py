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
from contextlib import AsyncExitStack

import httpx2
from jsonschema import Draft202012Validator
from mcp import Client
from mcp.client.sse import sse_client
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client
from mcp_ops import MAX_MANIFEST, ManifestError, load, manifest_version, personal_mcp, tool_manifest

MAX_RESULT = 8 * 1024 * 1024


def emit(value):
    text = json.dumps(value, ensure_ascii=False)
    if len(text.encode()) > MAX_RESULT:
        text = json.dumps(
            {
                "error": "MCP 返回内容超过 8 MiB，执行结果未知，请先核实外部状态",
                "uncertain": True,
            }
        )
    print(text, flush=True)


async def discover(client):
    tools, cursor, visited, size, response_size = [], None, set(), 2, 0
    while True:
        page = await client.list_tools(cursor=cursor, cache_mode="refresh")
        response_size += len(json.dumps(
            page.model_dump(mode="json", by_alias=True, exclude_none=True)
        ).encode())
        if response_size > MAX_MANIFEST:
            raise ManifestError("MCP 工具发现响应累计超过 1 MiB", "MCP_DISCOVERY_TOO_LARGE")
        declarations = tool_manifest([
            item.model_dump(mode="json", by_alias=True, exclude_none=True)
            for item in page.tools
        ])
        for declaration in declarations:
            size += len(json.dumps(declaration).encode()) + (2 if tools else 0)
            if size > MAX_MANIFEST:
                raise ManifestError("MCP 工具目录超过 1 MiB", "MCP_MANIFEST_TOO_LARGE")
            tools.append(declaration)
        cursor = page.next_cursor
        if not cursor:
            break
        if cursor in visited:
            raise ManifestError("MCP 工具目录分页游标重复", "MCP_MANIFEST_CURSOR_REPEAT")
        visited.add(cursor)
    return tool_manifest(tools)


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


async def serve(name, expected_version, root="/workspace"):
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        config, revision = load(rootfd, name)
    finally:
        os.close(rootfd)
    if revision != expected_version:
        emit({"conflict": True})
        return
    timeout = config["timeout"]
    async with AsyncExitStack() as stack:
        if config["transport"] == "stdio":
            # Config env is supplied by this owner; manager/platform env was
            # removed before exec and cannot leak through parent /proc entries.
            # Resolve config paths under the same owner root used for file access.
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
                        timeout=httpx2.Timeout(timeout + 15, connect=min(timeout, 10)),
                        trust_env=False,
                    ),
                    timeout=min(timeout, 10),
                    sse_read_timeout=timeout,
                )
            else:
                http = await stack.enter_async_context(
                    httpx2.AsyncClient(
                        headers=config["headers"],
                        timeout=httpx2.Timeout(timeout + 15, connect=min(timeout, 10)),
                        trust_env=False,
                    )
                )
                transport = streamable_http_client(config["url"], http_client=http)
        client = await stack.enter_async_context(
            Client(transport, read_timeout_seconds=min(timeout, 10))
        )
        tools = await asyncio.wait_for(discover(client), min(timeout, 10))
        for tool in tools:
            try:
                Draft202012Validator.check_schema(tool["inputSchema"])
                if "outputSchema" in tool:
                    Draft202012Validator.check_schema(tool["outputSchema"])
            except Exception:
                raise ManifestError("MCP 工具的 JSON Schema 无效") from None
        catalog = personal_mcp(
            {
                "operation": "mcp_cache",
                "name": name,
                "version": revision,
                "tools": tools,
            },
            root,
        )
        if catalog.get("conflict"):
            emit(catalog)
            return
        fingerprint = manifest_version(tools)
        emit(
            {
                "ready": True,
                "version": revision,
                "manifest_version": fingerprint,
                "tools": tools,
            }
        )
        reader = asyncio.StreamReader(limit=2 * 1024 * 1024)
        pipe, _ = await asyncio.get_running_loop().connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader), sys.stdin
        )
        requests, disconnected = asyncio.Queue(maxsize=2), asyncio.Event()

        async def receive():
            try:
                while line := await asyncio.wait_for(reader.readline(), 600):
                    await requests.put(line)
            finally:
                disconnected.set()

        receiver = asyncio.create_task(receive())
        try:
            while True:
                try:
                    line = await connected(requests.get(), disconnected, 600)
                except (TimeoutError, ConnectionError):
                    return
                if not line:
                    return
                request = json.loads(line)
                state = personal_mcp({"operation": "mcp_probe", "name": name}, root)
                if state["version"] != revision:
                    emit({"conflict": True})
                    return
                if request.get("operation") == "mcp_test":
                    emit(
                        {
                            "ready": True,
                            "version": revision,
                            "manifest_version": fingerprint,
                            "tools": tools,
                        }
                    )
                    continue
                if not state["enabled"]:
                    emit({"error": "个人 MCP 已停用"})
                    return
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
                validator = Draft202012Validator(tool["inputSchema"])
                if not validator.is_valid(arguments):
                    emit({"error": "MCP 工具参数不符合声明"})
                    continue
                try:
                    remaining = (request.get('deadline_ms', int(time.time() * 1000) + 350_000) - time.time() * 1000) / 1000
                    if remaining <= 0:
                        emit({'error': 'MCP 调用已过期，本次操作未执行', 'code': 'MCP_DEADLINE_EXCEEDED'})
                        continue
                    call_timeout = min(timeout, remaining)
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
            await asyncio.gather(receiver, return_exceptions=True)
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
        asyncio.run(serve(sys.argv[1], sys.argv[2]))
    except Exception as error:
        # Exceptions can contain URLs, authorization headers and server stderr.
        emit(discovery_failure(error))
        sys.exit(1)
