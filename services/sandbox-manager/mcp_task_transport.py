"""Task frames on the SDK's existing transport; core negotiation stays in Client."""
import asyncio
from contextlib import asynccontextmanager
from uuid import uuid4
from typing import ClassVar

import anyio
from mcp import types
from mcp.shared.message import SessionMessage, ClientMessageMetadata
from mcp.shared.exceptions import MCPError
from pydantic import TypeAdapter


class TaskControlParams(types.RequestParams):
    model_config = {'extra': 'allow'}


class TaskControlRequest(types.Request[TaskControlParams, str]):
    name_param: ClassVar[str] = 'taskId'


class TaskTransport:
    def __init__(self, streams):
        self.streams = streams
        self.pending = {}
        self.server_info = None
        self.closed = False

    @asynccontextmanager
    async def transport(self):
        send, receive = anyio.create_memory_object_stream(32)

        async def forward():
            try:
                async for message in self.streams[0]:
                    data = None if isinstance(message, Exception) else message.message
                    request_id = getattr(data, 'id', None)
                    if request_id in self.pending:
                        future = self.pending[request_id]
                        if not future.done():
                            future.set_result(data.model_dump(mode='json', by_alias=True, exclude_none=True))
                        continue
                    result = getattr(data, 'result', None)
                    if isinstance(result, dict) and 'protocolVersion' in result and 'capabilities' in result:
                        self.server_info = result
                    await send.send(message)
            finally:
                self.closed = True
                for future in self.pending.values():
                    if not future.done():
                        future.set_exception(ConnectionError('MCP connection closed'))
                await send.aclose()

        task = asyncio.create_task(forward())
        try:
            yield receive, self.streams[1]
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await receive.aclose()

    async def request(self, method, params, version, session):
        if method not in {'tools/call', 'tasks/get', 'tasks/result', 'tasks/cancel', 'tasks/update'}:
            raise ValueError('MCP task method not supported')
        if version >= '2026-07-28':
            # The SDK owns negotiated envelopes, routing headers and cancellation.
            request = (types.CallToolRequest(params=types.CallToolRequestParams(**params))
                       if method == 'tools/call' else
                       TaskControlRequest(method=method, params=TaskControlParams(**params)))
            try:
                result = await session.send_request(
                    request,
                    TypeAdapter(dict[str, object]))
                return {'result': result}
            except MCPError as error:
                return {'error': error.error.model_dump(mode='json', by_alias=True, exclude_none=True)}
        request_id = 'gxzs-task-' + uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        headers = {'MCP-Protocol-Version': version}
        try:
            await self.streams[1].send(SessionMessage(
                types.JSONRPCRequest(jsonrpc='2.0', id=request_id, method=method, params=params),
                ClientMessageMetadata(headers=headers)))
            response = await future
            return {'error': response['error']} if 'error' in response else {'result': response['result']}
        finally:
            self.pending.pop(request_id, None)
