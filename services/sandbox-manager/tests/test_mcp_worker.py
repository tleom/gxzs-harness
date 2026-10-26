"""Real MCP transports and process lifetime; run in the sandbox MCP image."""

import importlib.util
import json
import os
import selectors
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="Requires the Linux MCP runtime"
)

SERVER = """
import asyncio, json, os, sys
from pathlib import Path
from mcp.server.mcpserver import Context, MCPServer
from mcp.types import CallToolResult, TextContent
server = MCPServer("real-fixture")
calls = 0
@server.tool()
def add(value: int, ctx: Context) -> CallToolResult:
    global calls
    calls += 1
    result = {"value": value + 1, "calls": calls, "pid": os.getpid(), "cwd": os.getcwd(),
            "platform_secret": os.environ.get("SHELLCTL_AUTH_TOKEN"),
            "owner_env": os.environ.get("OWNER_CONFIG"),
            "authorization": getattr(ctx.request_context.request, "headers", {}).get("authorization")}
    return CallToolResult(content=[TextContent(type="text", text=json.dumps(result))], structured_content=result)
@server.tool()
def failure() -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text="business-error")],
                          structured_content={"reason": "rejected"}, is_error=True)
@server.tool()
async def slow(counter: str) -> str:
    path = Path(counter)
    path.write_text(path.read_text() + "1" if path.exists() else "1")
    await asyncio.sleep(20)
    return "done"
@server.tool()
def large() -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text="x" * (9 * 1024 * 1024))],
                          structured_content={"value": "complete structured result"})
if __name__ == "__main__":
    transport = sys.argv[1]
    server.run(transport=transport, **({"host": "127.0.0.1", "port": int(sys.argv[2])} if transport != "stdio" else {}))
"""


@pytest.fixture
def modules():
    pytest.importorskip("mcp")
    base = Path(__file__).parents[1]
    for name in ("file_ops", "resource_ops", "mcp_ops"):
        spec = importlib.util.spec_from_file_location(name, base / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return base, sys.modules["mcp_ops"]


class Connection:
    def __init__(self, base, root, version, reorder_discovery=False):
        source = (
            f"import sys,asyncio; sys.path.insert(0,{str(base)!r})\nimport mcp_worker as worker\n"
        )
        if reorder_discovery:
            source += ("original = worker.discover\nflip = False\n"
                       "async def reordered(client):\n global flip\n tools = await original(client)\n"
                       " flip = not flip\n return list(reversed(tools)) if flip else tools\n"
                       "worker.discover = reordered\n")
        source += f"asyncio.run(worker.serve('demo',{version!r},{str(root)!r}))"
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-u", "-c", source],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": os.environ["PATH"], "HOME": "/tmp", "LANG": "C.UTF-8"},
        )
        self.ready = self.read()
        assert self.ready.get("ready"), self.ready

    def read(self):
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            assert selector.select(20), "MCP worker did not respond"
        line = self.process.stdout.readline()
        assert line, self.process.stderr.read().decode()
        return json.loads(line)

    def call(self, tool, arguments=None, **overrides):
        request = {
            "operation": "mcp_call",
            "tool": tool,
            "arguments": arguments or {},
            "manifest_version": self.ready["manifest_version"],
            **overrides,
        }
        self.process.stdin.write(json.dumps(request).encode() + b"\n")
        self.process.stdin.flush()
        return self.read()

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=8)
        finally:
            if self.process.poll() is None:
                self.process.kill()
                self.process.wait()
        assert self.process.returncode == 0, self.process.stderr.read().decode()


def test_global_stdio_uses_independent_owner_processes_and_shared_global_configuration(modules, tmp_path):
    base, _ = modules
    script = tmp_path / 'global-fixture.py'
    script.write_text(SERVER)
    config = {'transport': 'stdio', 'command': sys.executable, 'args': [str(script), 'stdio'],
              'env': {'OWNER_CONFIG': 'global-fixture-key'}, 'timeout': 5}
    workers = []
    try:
        for owner in ('owner-a', 'owner-b'):
            root = tmp_path / owner
            root.mkdir()
            source = (f'import sys,asyncio,json; sys.path.insert(0,{str(base)!r}); '
                      f'from mcp_worker import serve; asyncio.run(serve("global:demo","global-v1",{str(root)!r},json.loads(sys.stdin.readline())))')
            worker = object.__new__(Connection)
            worker.process = subprocess.Popen([sys.executable, '-I', '-u', '-c', source], stdin=subprocess.PIPE,
                                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                               env={'PATH': os.environ['PATH'], 'HOME': '/tmp', 'LANG': 'C.UTF-8'})
            workers.append(worker)
            worker.process.stdin.write(json.dumps(config).encode() + b'\n')
            worker.process.stdin.flush()
            worker.ready = worker.read()
            assert worker.ready.get('ready'), worker.ready
            assert not (root / 'mcp').exists()
        results = [worker.call('add', {'value': 2})['result']['structuredContent'] for worker in workers]
        assert results[0]['pid'] != results[1]['pid']
        assert all(item['calls'] == 1 and item['owner_env'] == 'global-fixture-key' for item in results)
    finally:
        for worker in workers:
            worker.close()


@pytest.fixture(params=["stdio", "streamable-http", "sse"])
def connected(request, modules, tmp_path):
    base, ops = modules
    script = tmp_path / "server.py"
    script.write_text(SERVER)
    server = None
    transport = request.param
    config = {"transport": transport, "timeout": 5}
    if transport == "stdio":
        config.update(
            command=sys.executable,
            args=[str(script), "stdio"],
            env={"OWNER_CONFIG": "owner-value"},
        )
    else:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        server = subprocess.Popen(
            [sys.executable, str(script), transport, str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.05)
        config["url"] = f"http://127.0.0.1:{port}/" + (
            "sse" if transport == "sse" else "mcp"
        )
        config["headers"] = {"Authorization": "Bearer owner-http-test"}
    saved = ops.personal_mcp(
        {"operation": "mcp_save", "name": "demo", "content": json.dumps(config)},
        str(tmp_path),
    )
    connection = None
    try:
        connection = Connection(base, tmp_path, saved["runtime_version"])
        yield connection, ops, tmp_path, transport
    finally:
        if connection:
            connection.close()
        if server:
            server.terminate()
            server.wait(timeout=10)


def test_transports_schema_results_persistence_and_clean_exit(connected):
    connection, ops, root, transport = connected
    assert {tool["name"] for tool in connection.ready["tools"]} == {
        "add",
        "failure",
        "slow",
        "large",
    }
    assert connection.call("add", {"value": "wrong"}) == {
        "error": "MCP 工具参数不符合声明"
    }
    response = connection.call("add", {"value": 2})
    assert "structuredContent" in response.get("result", {}), response
    first = response["result"]["structuredContent"]
    second = connection.call("add", {"value": 4})["result"]["structuredContent"]
    assert (first["value"], second["value"], second["calls"]) == (3, 5, 2)
    assert first["pid"] == second["pid"]
    if transport == "stdio":
        assert first["cwd"] == str(root)
        assert first["platform_secret"] is None and first["owner_env"] == "owner-value"
    else:
        assert first["authorization"] == "Bearer owner-http-test"
    failure = connection.call("failure")["result"]
    assert failure["isError"] and failure["structuredContent"] == {"reason": "rejected"}
    assert (
        "声明已改变"
        in connection.call("add", {"value": 1}, manifest_version="stale")["error"]
    )
    ops.personal_mcp(
        {"operation": "mcp_toggle", "name": "demo", "enabled": False}, str(root)
    )
    assert "已停用" in connection.call("add", {"value": 1})["error"]


def test_legacy_binding_stays_callable_across_reordered_refresh_and_reconnect(connected):
    initial, ops, root, _ = connected
    base = Path(__file__).parents[1]
    path = root / "mcp/.cache/demo.json"
    cache = json.loads(path.read_text())
    tools = sorted(cache["tools"], key=lambda item: item["name"], reverse=True)
    legacy = ops.legacy_manifest_version(tools)
    assert legacy != ops.manifest_version(tools)
    path.write_text(json.dumps({**cache, "tools": tools, "manifest_version": legacy}))
    for _ in range(2):
        connection = Connection(base, root, initial.ready["version"], reorder_discovery=True)
        try:
            assert connection.ready["manifest_version"] == legacy
            for _ in range(3):
                connection.process.stdin.write(json.dumps({"operation": "mcp_test"}).encode() + b"\n")
                connection.process.stdin.flush()
                assert connection.read()["manifest_version"] == legacy
                response = connection.call("add", {"value": 3}, manifest_version=legacy)
                assert response["result"]["structuredContent"]["value"] == 4
                assert ops.personal_mcp({"operation": "mcp_list"}, str(root))["mcp"][0]["manifest_version"] == legacy
        finally:
            connection.close()


def test_timeout_does_not_replay_business_call(connected):
    connection, _, root, _ = connected
    counter = root / "counter"
    result = connection.call("slow", {"counter": str(counter)})
    assert result["uncertain"] and "不要自动重试" in result["error"]
    assert counter.read_text() == "1"


def test_live_connection_survives_presentation_edit_but_rejects_connection_change(connected):
    connection, ops, root, _ = connected
    first = connection.call('add', {'value': 1})['result']['structuredContent']
    read = ops.personal_mcp({'operation': 'mcp_read', 'name': 'demo'}, str(root))
    config = json.loads(read['content'])
    config.update(display_name='新展示名', description='新说明')
    saved = ops.personal_mcp({'operation': 'mcp_save', 'name': 'demo', 'version': read['version'],
                              'content': json.dumps(config, indent=4)}, str(root))
    assert saved['runtime_version'] == connection.ready['version'] and saved['connection_changed'] is False
    second = connection.call('add', {'value': 2})['result']['structuredContent']
    assert first['pid'] == second['pid'] and second['calls'] == first['calls'] + 1
    config['timeout'] = 6
    changed = ops.personal_mcp({'operation': 'mcp_save', 'name': 'demo', 'version': saved['version'],
                                'content': json.dumps(config)}, str(root))
    assert changed['connection_changed'] is True and changed['runtime_version'] != saved['runtime_version']
    assert connection.call('add', {'value': 3}) == {'conflict': True}


def test_manager_disconnect_cancels_inflight_call_without_waiting_for_tool_timeout(
    connected,
):
    connection, _, root, _ = connected
    counter = root / "disconnect-counter"
    request = {
        "operation": "mcp_call",
        "tool": "slow",
        "arguments": {"counter": str(counter)},
        "manifest_version": connection.ready["manifest_version"],
    }
    connection.process.stdin.write(json.dumps(request).encode() + b"\n")
    connection.process.stdin.flush()
    deadline = time.monotonic() + 3
    while not counter.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert counter.read_text() == "1"
    started = time.monotonic()
    connection.process.stdin.close()
    connection.process.wait(timeout=4)
    assert time.monotonic() - started < 4
    assert connection.process.returncode == 0, connection.process.stderr.read().decode()


def test_direct_config_change_fences_existing_connection(connected):
    connection, _, root, _ = connected
    path = root / "mcp/demo/mcp.json"
    path.write_text(path.read_text() + "\n")
    assert connection.call("add", {"value": 1})['result']['structuredContent']['value'] == 2
    config = json.loads(path.read_text())
    config['timeout'] = config['timeout'] + 1
    path.write_text(json.dumps(config))
    assert connection.call("add", {"value": 1}) == {"conflict": True}


def test_large_result_reaches_native_host_intact_for_every_transport(connected):
    connection, _, root, _ = connected
    result = connection.call('large')['result']
    assert len(result['content'][0]['text']) == 9 * 1024 * 1024
    assert result['structuredContent'] == {'value': 'complete structured result'}
    assert not result.get('isError')
    assert not (root / '.agent-output').exists()
