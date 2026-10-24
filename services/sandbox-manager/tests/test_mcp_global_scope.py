import json
from pathlib import Path
from unittest.mock import patch

import pytest

from mcp_runtime import Invocation, Worker
from mcp_authorization import validate_grant


def test_global_bootstrap_is_sent_privately_not_embedded_in_process_arguments():
    class Process:
        stdin = None
    config = {'transport': 'stdio', 'command': 'fixture', 'env': {'TOKEN': 'secret-fixture-value'}}
    with patch('mcp_runtime.subprocess.Popen', return_value=Process()) as spawn, \
            patch('mcp_runtime.threading.Thread') as thread, \
            patch('mcp_runtime.TrustedWorkerContainer') as isolation, \
            patch('mcp_runtime.write_request', return_value=None) as write:
        isolation.return_value.name = 'trusted-platform-worker'
        Worker('sandbox-a', 'global:cases', 'v1', 60, configuration=config, workspace='workspace')
    args = spawn.call_args.args[0]
    assert 'secret-fixture-value' not in json.dumps(args)
    assert write.call_args.args[1] == config
    assert len(args[args.index('-c') + 1].encode()) < 128 * 1024
    assert 'sandbox-a' not in args
    assert 'trusted-platform-worker' in args
    assert not any('/opt/user-env' in arg for arg in args[:args.index('-c')])
    isolation.return_value.start.assert_called_once()


def test_resource_grant_binds_method_and_params():
    with pytest.raises(ValueError, match='signed parameters'):
        validate_grant('workspace', {'operation': 'mcp_request', 'method': 'resources/read',
                                    'params': {'uri': 'fixture://other'},
                                    'arguments': {'method': 'resources/read', 'params': {'uri': 'fixture://allowed'}}}, 'personal:mcp:cases')


def test_global_identity_has_its_own_worker_namespace():
    with patch('mcp_runtime.validate_grant', return_value='binding') as validate:
        invocation = Invocation('owner-a', {'operation': 'mcp_call', 'name': 'global:cases',
                                           'scope': 'global', 'server_id': 'cases', 'tool': 'lookup'})
    assert invocation.name == 'global:cases'
    assert validate.call_args.args[2] == 'global:mcp:cases:lookup'


def test_task_grant_binds_connection_as_well_as_method_and_task_id():
    with pytest.raises(ValueError, match='signed parameters'):
        validate_grant('workspace', {'operation': 'mcp_task', 'method': 'tasks/cancel',
            'params': {'taskId': 'same'}, 'connection_id': 'another-connection',
            'arguments': {'method': 'tasks/cancel', 'params': {'taskId': 'same'}, 'connection_id': 'original'}}, 'personal:mcp:cases:tool')


def test_discovery_and_idle_reaping_keep_a_live_task_connection(monkeypatch):
    import mcp_runtime as runtime
    import time
    from types import SimpleNamespace
    from unittest.mock import Mock
    worker = SimpleNamespace(version='v1', token='connection', process=SimpleNamespace(poll=lambda: None),
        tasks_active_until=time.time()*1000+60000, ready={'ready': True},
        send=Mock(return_value=None), response=Mock(return_value={'ready': True}), close=Mock(return_value=True))
    identity = ('task-pin-test', 'demo')
    monkeypatch.setitem(runtime.WORKERS, identity, worker)
    runtime.invoke(identity[0], 'container', {'operation':'mcp_test','name':'demo','version':'v1'},
                   {'version':'v1','enabled':True,'timeout':10})
    runtime.reap_workers(idle_seconds=0, max_workers=0, max_owner_workers=0)
    assert runtime.WORKERS[identity] is worker
    worker.close.assert_not_called()
    runtime.WORKERS.pop(identity)


def test_missing_task_connection_is_never_recreated():
    import mcp_runtime as runtime
    with patch('mcp_runtime.Worker') as start:
        response = runtime.invoke('missing-task-test', 'container',
            {'operation':'mcp_browse','name':'demo','version':'v1','connection_id':'lost'},
            {'version':'v1','enabled':True,'timeout':10})
    assert '连接已失效' in response['error']
    start.assert_not_called()
