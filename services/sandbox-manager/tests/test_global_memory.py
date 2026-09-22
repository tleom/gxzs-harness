import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import global_memory as memory
from global_memory import operate
from mcp_journal import Journal


class RoutingTests(unittest.TestCase):
    def setUp(self):
        mock_catalog = patch.object(memory, "catalog", return_value={"version": memory.VERSION, "manifest_version": "manifest"})
        mock_catalog.start()
        self.addCleanup(mock_catalog.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = Journal(Path(self.temp.name))
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
                       lock=lambda _: threading.RLock(), authorize=self.authorize, journal=self.journal,
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

    def test_owner_container_and_retry_deduplication(self):
        result = self.run_call()
        calls = self.docker.call_count
        self.payload["authorization"]["signature"] = "new-grant-on-retry"
        self.assertEqual(result, self.run_call())
        self.assertEqual(calls, self.docker.call_count)
        self.worker_factory.assert_called_once_with('sandbox-owner-a')
        self.assertEqual(self.worker.send.call_count, 1)
        self.assertEqual(self.worker.send.call_args.args[:2], ('cg', {'op': 'read', 'query': 'preference'}))
        self.assertFalse(self.journal.binding_uncertain('owner-a', self.payload['authorization']['binding_id']))

    def test_cancel_during_consume_prevents_dispatch(self):
        def authorize(callback):
            if callback['action'] == 'consume':
                self.assertTrue(memory.invalidate('owner-a', self.payload['authorization']['binding_id']))
            return True
        self.authorize.side_effect = authorize
        self.assertIn('未执行', self.run_call()['error'])
        self.worker.send.assert_not_called()

    def test_cancel_in_flight_returns_unknown_and_never_replays(self):
        def response(cancelled, timeout=None):
            if self.worker.send.call_count == 0:
                return {'ready': True}
            self.assertTrue(memory.invalidate('owner-a', self.payload['authorization']['binding_id']))
            self.assertTrue(cancelled.is_set())
            return {'uncertain': True, 'error': 'stopped'}
        self.worker.response.side_effect = response
        self.assertTrue(self.run_call()['uncertain'])
        self.assertTrue(self.journal.binding_uncertain('owner-a', self.payload['authorization']['binding_id']))
        self.assertTrue(self.run_call()['uncertain'])
        self.assertEqual(self.worker.send.call_count, 1)

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


@unittest.skipUnless(os.environ.get("GLOBAL_MEMORY_TEST_SOURCE"), "Set GLOBAL_MEMORY_TEST_SOURCE to the pinned upstream source")
class EngineTests(unittest.TestCase):
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
