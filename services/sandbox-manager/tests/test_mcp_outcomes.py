"""Persistent stop-state markers, independent of request-key deduplication."""

import importlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_two_calls_are_independent_and_unknown_survives_reload(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKBENCH_MANAGER_STATE', str(tmp_path))
    import mcp_outcomes

    workspace, binding = str(uuid4()), str(uuid4())
    mcp_outcomes.record_pending(workspace, binding, 'call-a')
    mcp_outcomes.record_pending(workspace, binding, 'call-b')
    assert mcp_outcomes.has_unconfirmed(workspace, binding)
    mcp_outcomes.complete_call(workspace, binding, 'call-b')
    assert mcp_outcomes.has_unconfirmed(workspace, binding)
    assert not mcp_outcomes.has_unconfirmed(workspace, str(uuid4()))
    importlib.reload(mcp_outcomes)
    assert mcp_outcomes.has_unconfirmed(workspace, binding)
    mcp_outcomes.complete_call(workspace, binding, 'call-a')
    assert not mcp_outcomes.has_unconfirmed(workspace, binding)


def test_parallel_outcomes_and_stop_reads_do_not_lock_database(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKBENCH_MANAGER_STATE', str(tmp_path))
    import mcp_outcomes

    def call(index):
        binding = 'binding-' + str(index)
        call_id = 'call-' + str(index)
        mcp_outcomes.record_pending('workspace', binding, call_id)
        assert mcp_outcomes.has_unconfirmed('workspace', binding)
        mcp_outcomes.complete_call('workspace', binding, call_id)
        assert not mcp_outcomes.has_unconfirmed('workspace', binding)

    with ThreadPoolExecutor(max_workers=32) as pool:
        list(pool.map(call, range(64)))
