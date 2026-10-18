import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tarfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import global_memory as memory
from global_memory import operate


class ImportPathTests(unittest.TestCase):
    def test_repeated_catalog_refresh_does_not_accumulate_source_paths(self):
        from types import SimpleNamespace
        source = '/fixture/fixed-memory-source'
        initial = list(sys.path)
        try:
            with patch.dict(sys.modules, {'md_cg.mcp_server': SimpleNamespace(KERNEL_TOOLS=[])}):
                first = memory.catalog(source)
                for _ in range(1000):
                    self.assertEqual(memory.catalog(source), first)
                self.assertEqual(sys.path.count(source), 1)
                self.assertEqual(len(sys.path), len(initial) + 1)
        finally:
            sys.path[:] = initial


class InstallTests(unittest.TestCase):
    def test_installs_runtime_entry_dependencies_without_unrelated_repository_files(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w:gz') as tar:
            for name in ('md_cg/mdcos.py', 'utf8_boot.py', 'package.json', 'LICENSE', 'data/private.json', '../outside'):
                content = b'fixture'
                item = tarfile.TarInfo('dsh-memory-' + memory.REVISION + '/' + name)
                item.size = len(content)
                tar.addfile(item, io.BytesIO(content))
        archive.seek(0)
        with tempfile.TemporaryDirectory() as folder, patch.object(memory, 'SOURCE', folder), \
                patch('urllib.request.urlopen', return_value=archive):
            memory.install()
            installed = {p.relative_to(folder).as_posix() for p in Path(folder).rglob('*') if p.is_file()}
            self.assertEqual(installed, {'md_cg/mdcos.py', 'utf8_boot.py', 'package.json', 'LICENSE'})


class RoutingTests(unittest.TestCase):
    def test_reaper_retries_completed_close_without_interrupting_active_calls(self):
        finished, active = memory.MemoryCall('owner-a', 'done'), memory.MemoryCall('owner-b', 'active')
        finished.finished = True
        finished.worker, active.worker = Mock(), Mock()
        finished.worker.close.side_effect = [False, True]
        memory.ACTIVE.update([finished, active])
        try:
            self.assertFalse(memory.reap_calls())
            self.assertIn(finished, memory.ACTIVE)
            self.assertTrue(memory.reap_calls())
            self.assertNotIn(finished, memory.ACTIVE)
            self.assertIn(active, memory.ACTIVE)
            active.worker.close.assert_not_called()
            self.assertFalse(active.cancelled.is_set())
        finally:
            memory.ACTIVE.difference_update([finished, active])

    def test_cancel_keeps_unfinished_start_counted_until_startup_returns(self):
        call = memory.MemoryCall('owner-a', 'starting')
        memory.ACTIVE.add(call)
        try:
            self.assertFalse(memory.invalidate('owner-a', 'starting'))
            self.assertIn(call, memory.ACTIVE)
            self.assertTrue(call.cancelled.is_set())
            call.finished = True
            self.assertTrue(memory.reap_calls())
            self.assertNotIn(call, memory.ACTIVE)
        finally:
            memory.ACTIVE.discard(call)

    def test_cancel_does_not_need_a_new_cleanup_thread(self):
        worker = Mock()
        worker.close.return_value = True
        call = memory.MemoryCall('owner-a','binding-a')
        call.worker = worker
        memory.ACTIVE.add(call)
        try:
            with patch.object(threading.Thread,'start',side_effect=RuntimeError('cannot start thread')):
                self.assertTrue(memory.invalidate('owner-a','binding-a'))
            self.assertNotIn(call,memory.ACTIVE)
        finally:
            memory.ACTIVE.discard(call)
    def test_sandbox_embedded_source_does_not_import_manager_state(self):
        code = (
            "import pathlib,sys; source=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'); "
            "scope={'__name__':'sandbox_memory','__file__':'<embedded>'}; "
            "exec(compile(source.split('if __name__ == \"__main__\":')[0], '<embedded>', 'exec'),scope); "
            "assert callable(scope['run_request'])"
        )
        result = subprocess.run([sys.executable, '-I', '-S', '-c', code, memory.__file__],
                                text=True, capture_output=True)
        self.assertEqual(0, result.returncode, result.stderr)

    def setUp(self):
        mock_catalog = patch.object(memory, "catalog", return_value={"version": memory.VERSION, "manifest_version": "manifest"})
        mock_catalog.start()
        self.addCleanup(mock_catalog.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        state = patch.dict(os.environ, {"WORKBENCH_MANAGER_STATE": self.temp.name})
        state.start()
        self.addCleanup(state.stop)
        self.docker = Mock(return_value=Mock(returncode=0, stdout=json.dumps({"content": [], "isError": False})))
        self.authorize = Mock(return_value=True)
        self.ensure = Mock()
        self.worker = Mock()
        self.worker.response.side_effect = [{'ready': True}, {'content': [], 'isError': False}]
        self.worker.close.return_value = True
        self.worker.send.return_value = None
        self.worker_factory = Mock(return_value=self.worker)
        self.payload = {"operation": "call", "tool": "cg", "arguments": {"op": "read", "query": "preference"},
                        "version": memory.VERSION, "manifest_version": memory.catalog()["manifest_version"],
                        "request_key": "11111111-1111-4111-8111-111111111111:call", "authorization": {
                        "workspace_id": "owner-a", "run_id": "11111111-1111-4111-8111-111111111111",
                        "binding_id": "11111111-1111-4111-8111-111111111111", "version": "resource-version", "runtime_version": memory.VERSION,
                        "manifest_version": "manifest", "arguments": {"op": "read", "query": "preference"},
                        "request_key": "call", "resource_id": "global:mcp:global-memory:cg"}}

    def run_call(self, key="owner-a"):
        return operate(key, self.payload, docker=self.docker, ensure=self.ensure,
                       identity=lambda owner: ("sandbox-" + owner, "unused"),
                       lock=lambda _: threading.RLock(), authorize=self.authorize,
                       worker_factory=self.worker_factory)

    def test_other_owner_is_rejected_before_any_execution(self):
        with self.assertRaises(ValueError):
            self.run_call("owner-b")
        self.docker.assert_not_called()
        self.authorize.assert_not_called()

    def test_expired_authorization_never_executes(self):
        self.authorize.return_value = False
        self.assertIn("error", self.run_call())
        self.docker.assert_not_called()

    def test_owner_container_and_repeated_call_executes_again(self):
        result = self.run_call()
        calls = self.docker.call_count
        self.payload["authorization"]["signature"] = "new-grant-on-retry"
        self.worker.response.side_effect = [{'ready': True}, {'content': [], 'isError': False}]
        self.assertEqual(result, self.run_call())
        self.assertGreater(self.docker.call_count, calls)
        self.assertEqual(self.worker_factory.call_count, 2)
        self.assertEqual(self.worker.send.call_count, 2)
        self.assertEqual(self.worker.send.call_args.args[:2], ('cg', {'op': 'read', 'query': 'preference'}))

    def test_cancel_during_consume_prevents_dispatch(self):
        def authorize(callback):
            if callback['action'] == 'consume':
                self.assertTrue(memory.invalidate('owner-a', self.payload['authorization']['binding_id']))
            return True
        self.authorize.side_effect = authorize
        self.assertIn('未执行', self.run_call()['error'])
        self.worker.send.assert_not_called()

    def test_cancel_in_flight_returns_unknown_but_later_call_can_retry(self):
        def response(cancelled, timeout=None):
            if self.worker.send.call_count == 0:
                return {'ready': True}
            self.assertTrue(memory.invalidate('owner-a', self.payload['authorization']['binding_id']))
            self.assertTrue(cancelled.is_set())
            return {'uncertain': True, 'error': 'stopped'}
        self.worker.response.side_effect = response
        self.assertTrue(self.run_call()['uncertain'])
        self.worker.response.side_effect = [{'ready': True}, {'content': [], 'isError': False}]
        self.assertFalse(self.run_call().get('uncertain', False))
        self.assertEqual(self.worker.send.call_count, 2)

    def test_engine_unknown_result_does_not_suppress_a_later_call(self):
        from mcp_outcomes import has_unconfirmed
        self.worker.response.side_effect = [{'ready': True}, memory.error_result('unknown', uncertain=True)]
        self.assertTrue(self.run_call()['uncertain'])
        self.assertTrue(has_unconfirmed('owner-a', self.payload['authorization']['binding_id']))
        self.worker.response.side_effect = [{'ready': True}, {'content': [], 'isError': False}]
        self.assertFalse(self.run_call().get('uncertain', False))
        self.assertEqual(self.worker.send.call_count, 2)
        self.assertTrue(has_unconfirmed('owner-a', self.payload['authorization']['binding_id']))

    def test_confirmed_memory_result_survives_outcome_cleanup_error(self):
        import sqlite3
        from mcp_outcomes import has_unconfirmed
        with patch('mcp_outcomes.complete_call', side_effect=sqlite3.OperationalError('locked')):
            result = self.run_call()
        self.assertFalse(result['isError'])
        self.assertTrue(has_unconfirmed('owner-a', self.payload['authorization']['binding_id']))

    def test_late_stop_after_definitive_memory_response_clears_marker(self):
        from mcp_outcomes import has_unconfirmed
        self.worker.send.side_effect = lambda _tool, _arguments, _remaining, _cancelled, on_dispatch: on_dispatch()
        responses = iter([{'ready': True}, {'content': [], 'isError': False}])
        def response(cancelled, timeout=None):
            value = next(responses)
            if 'content' in value:
                cancelled.set()
            return value
        self.worker.response.side_effect = response
        result = self.run_call()
        self.assertFalse(result['isError'])
        self.assertFalse(has_unconfirmed('owner-a', self.payload['authorization']['binding_id']))

    def test_bad_operation_rejected_before_worker(self):
        self.payload['arguments'] = {'op': 'identity', 'action': 'add', 'subject_id': 'user:example'}
        result = self.run_call()
        self.assertTrue(result['isError'])
        self.assertFalse(result['uncertain'])
        self.assertIn('observe', result['content'][0]['text'])
        self.worker_factory.assert_not_called()
        self.authorize.assert_not_called()

    def test_unconfirmed_worker_exit_is_not_reported_fenced(self):
        self.worker.close.return_value = False
        self.run_call()
        self.assertFalse(memory.invalidate('owner-a', self.payload['authorization']['binding_id']))
        self.worker.close.return_value = True
        memory.invalidate('owner-a')
        with memory.GUARD:
            memory.ACTIVE.clear()

    def test_version_and_argument_boundaries(self):
        self.payload["version"] = "old"
        self.assertTrue(self.run_call()["conflict"])
        self.docker.assert_not_called()
        for args in ({"query": "x", "root": "/other-user"}, {"owner_id": "other"}, {"query": "x" * (1024 * 1024)}):
            with self.assertRaises(ValueError):
                memory.validate("cg", args)
        with self.assertRaises(ValueError):
            memory.validate("unknown-tool", {})


class ContractTests(unittest.TestCase):
    def test_info_warning_is_not_a_tool_failure_and_preserves_full_health_report(self):
        report = {'ok': False, 'buckets': 1, 'nodes': 2, 'total_nodes': 2,
                  'problems': ['bucket concentration'], 'os': {'fixture': True}}
        result = memory.tool_result('cg', {'op': 'info'}, report)
        self.assertFalse(result['isError'])
        self.assertEqual(report, json.loads(result['content'][0]['text']))
        self.assertFalse(report['ok'])
        for value in ({**report, 'error': 'diagnostic failed'}, {'ok': False},
                      {**report, 'os': None}, {**report, 'problems': []}):
            self.assertTrue(memory.tool_result('cg', {'op': 'info'}, value)['isError'])
        self.assertTrue(memory.tool_result('cg', {'op': 'write'}, report)['isError'])
        self.assertTrue(memory.tool_result('stg', {'op': 'info'}, report)['isError'])

    def test_required_operation_and_platform_capabilities_fail_before_storage(self):
        invalid = [({}, 'op'), ({'op': 'maintain'}, 'op'),
                   ({'op': 'write', 'layer': 'anchor', 'content': 'example'}, 'knowledge'),
                   ({'op': 'identity', 'action': 'add'}, 'observe'),
                   ({'op': 'identity', 'action': 'anchor'}, 'observe'),
                   ({'op': 'write'}, 'content')]
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'untouched'
            for arguments, hint in invalid:
                result = memory.run_request({'tool': 'cg', 'arguments': arguments}, root=target, source='unused')
                self.assertTrue(result['isError'])
                self.assertFalse(result['uncertain'])
                self.assertIn(hint, result['content'][0]['text'])
                self.assertFalse(target.exists())

    def test_catalog_does_not_mutate_upstream_or_advertise_unavailable_operations(self):
        upstream = [{'name': name, 'inputSchema': {'type': 'object', 'required': ['op'],
                     'properties': {'op': {'type': 'string', '_req': True},
                                    'content': {'type': 'string'}, 'node_id': {'type': 'string'}}}}
                    for name in ('cg', 'stg')]
        original = json.dumps(upstream)
        tools = memory.platform_tools(upstream)
        self.assertEqual(original, json.dumps(upstream))
        self.assertEqual(list(memory.CG_OPS), tools[0]['inputSchema']['properties']['op']['enum'])
        self.assertEqual(list(memory.STG_OPS), tools[1]['inputSchema']['properties']['op']['enum'])
        self.assertNotIn('anchor', tools[0]['inputSchema']['properties']['layer']['enum'])
        self.assertIn('committed=true', tools[0]['description'])

    def test_unexpected_engine_exception_never_claims_no_side_effects_or_exposes_details(self):
        with patch.object(memory, 'execute', side_effect=ValueError('secret-content-and-internal-path')):
            result = memory.run_request({'tool': 'cg', 'arguments': {'op': 'read'}})
        self.assertTrue(result['isError'])
        self.assertTrue(result['uncertain'])
        self.assertNotIn('secret', json.dumps(result))


@unittest.skipUnless(os.environ.get("GLOBAL_MEMORY_TEST_SOURCE"), "Set GLOBAL_MEMORY_TEST_SOURCE to the pinned upstream source")
class EngineTests(unittest.TestCase):
    def test_real_two_node_info_preserves_unhealthy_diagnostics_without_mcp_failure(self):
        source = os.environ['GLOBAL_MEMORY_TEST_SOURCE']
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'HOME': folder}):
            for number in (1, 2):
                output = memory.run_request({'tool': 'cg', 'arguments': {
                    'op': 'write', 'node_id': 'info_fixture_' + str(number),
                    'content': 'ORCHID573 isolated diagnostic fixture ' + str(number),
                    'content_kind': 'text', 'layer': 'knowledge'}}, root=folder + '/memory', source=source)
                self.assertFalse(output['isError'])
                self.assertTrue(json.loads(output['content'][0]['text'])['committed'])
            output = memory.run_request({'tool': 'cg', 'arguments': {'op': 'info'}}, root=folder + '/memory', source=source)
            health = json.loads(output['content'][0]['text'])
            self.assertFalse(output['isError'])
            self.assertFalse(health['ok'])
            self.assertEqual(health['buckets'], 1)
            self.assertEqual(health['nodes'], 2)
            self.assertEqual(health['total_nodes'], 2)
            self.assertTrue(health['problems'])
            self.assertIsInstance(health['os'], dict)
            from md_cg import mcp_server
            with patch.object(mcp_server, 'call_tool', return_value={**health, 'error': 'fixture failure'}):
                output = memory.run_request({'tool': 'cg', 'arguments': {'op': 'info'}}, root=folder + '/memory', source=source)
            self.assertTrue(output['isError'])
            with patch.object(mcp_server, 'call_tool', side_effect=OSError('fixture failure')):
                output = memory.run_request({'tool': 'cg', 'arguments': {'op': 'info'}}, root=folder + '/memory', source=source)
            self.assertTrue(output['isError'])
            self.assertTrue(output['uncertain'])

    def test_real_engine_update_identity_and_error_boundaries(self):
        source = os.environ['GLOBAL_MEMORY_TEST_SOURCE']
        helper = str(Path(memory.__file__).resolve().parent)
        code = "import sys,json; sys.path.insert(0,sys.argv[1]); import global_memory as m; print(json.dumps(m.run_request(json.loads(sys.argv[4]),root=sys.argv[2],source=sys.argv[3])))"
        with tempfile.TemporaryDirectory() as folder:
            def call(arguments):
                process = subprocess.run([sys.executable, '-I', '-S', '-c', code, helper, str(Path(folder) / 'memory'), source,
                                          json.dumps({'tool': 'cg', 'arguments': arguments})],
                                         env={**os.environ, 'HOME': folder}, text=True, capture_output=True, check=True)
                return json.loads(process.stdout)
            def success(arguments):
                output = call(arguments)
                self.assertFalse(output['isError'], output)
                return json.loads(output['content'][0]['text'])
            first = success({'op': 'write', 'content': 'ORCHID573 requests English reports', 'content_kind': 'text', 'layer': 'knowledge'})
            self.assertTrue(first['committed'])
            updated = success({'op': 'write', 'node_id': first['id'], 'content': 'ORCHID573 requests Chinese reports', 'content_kind': 'text', 'layer': 'knowledge'})
            self.assertTrue(updated['committed'])
            self.assertEqual(first['id'], updated['id'])
            current = success({'op': 'read', 'node_id': first['id']})
            self.assertIn('Chinese reports', json.dumps(current))
            self.assertNotIn('English reports', json.dumps(current))
            observed = success({'op': 'identity', 'action': 'observe', 'subject_id': 'user:fixture', 'content': 'ORCHID573 requests concise reports', 'verification_basis': 'data'})
            self.assertTrue(observed['ok'])
            for args in ({'query': 'ORCHID573'}, {'op': 'identity', 'action': 'add', 'subject_id': 'user:fixture'},
                         {'op': 'write', 'content': 'example', 'content_kind': 'text', 'layer': 'anchor'}):
                rejected = call(args)
                self.assertTrue(rejected['isError'])
                self.assertFalse(rejected['uncertain'])

    def test_exception_after_commit_preserves_uncertainty_and_known_close_failure_preserves_success(self):
        source = os.environ['GLOBAL_MEMORY_TEST_SOURCE']
        sys.path.insert(0, source)
        from md_cg import mcp_server
        from md_cg.mdcos import MdCGSecure
        real_call, real_close = mcp_server.call_tool, MdCGSecure.close
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'HOME': folder}):
            args = {'op': 'write', 'content': 'ORCHID573 fixture only', 'content_kind': 'text', 'layer': 'knowledge', 'node_id': 'fixture_write'}
            def after_commit(*params):
                value = real_call(*params)
                self.assertTrue(value['committed'])
                raise OSError('secret source path')
            with patch.object(mcp_server, 'call_tool', side_effect=after_commit):
                result = memory.run_request({'tool': 'cg', 'arguments': args}, root=folder + '/a', source=source)
            self.assertTrue(result['uncertain'])
            self.assertTrue(list(Path(folder + '/a/data').rglob('fixture_write.md')))
            def failed_close(graph):
                real_close(graph)
                raise OSError('secret flush path')
            with patch.object(MdCGSecure, 'close', failed_close):
                result = memory.run_request({'tool': 'cg', 'arguments': args}, root=folder + '/b', source=source)
            self.assertFalse(result['isError'], result)
            value = json.loads(result['content'][0]['text'])
            self.assertTrue(value['committed'])
            self.assertIn('warning', value)
            self.assertNotIn('secret', json.dumps(result))

    def test_persistence_isolation_and_forget_across_processes(self):
        source = os.environ["GLOBAL_MEMORY_TEST_SOURCE"]
        helper = str(Path(memory.__file__).resolve().parent)
        code = "import sys,json; sys.path.insert(0,sys.argv[1]); import global_memory as m; print(json.dumps(m.execute(sys.argv[4],json.loads(sys.argv[5]),root=sys.argv[2],source=sys.argv[3])))"
        with tempfile.TemporaryDirectory() as root:
            def call(owner, name, args):
                home = Path(root) / owner
                home.mkdir(exist_ok=True)
                process = subprocess.run([sys.executable, "-I", "-S", "-c", code, helper, str(home / "memory"), source, name, json.dumps(args)],
                                         env={**os.environ, "HOME": str(home)}, text=True, capture_output=True, check=True)
                output = json.loads(process.stdout)
                self.assertFalse(output["isError"], output)
                return json.loads(output["content"][0]["text"])
            written = call("a", "cg", {"op": "write", "content": "ORCHID573 prefers Chinese reports", "content_kind": "text", "layer": "knowledge", "role": "user"})
            self.assertTrue(written["ok"])
            self.assertTrue(written["committed"], written)
            found = call("a", "cg", {"op": "read", "query": "ORCHID573", "budget_tokens": 1200})
            self.assertTrue(any(row["id"] == written["id"] for row in found["pack"]))
            other = call("b", "cg", {"op": "read", "query": "ORCHID573", "budget_tokens": 1200})
            self.assertEqual([], other["pack"])
            call("a", "cg", {"op": "forget", "node_id": written["id"], "reason": "User requests forgetting"})
            remaining = call("a", "cg", {"op": "read", "query": "ORCHID573", "budget_tokens": 1200})
            self.assertFalse(any(row["id"] == written["id"] for row in remaining["pack"]))


if __name__ == "__main__":
    unittest.main()
