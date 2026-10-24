import json
import subprocess
import time
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import mcp_isolation as isolation


@pytest.fixture
def helper(monkeypatch):
    monkeypatch.setenv('WORKBENCH_SANDBOX_PREFIX', 'isolated-fixture')
    monkeypatch.setenv('GXZS_OWNER_CGROUP_PREFIX', '')
    worker = isolation.TrustedWorkerContainer('workspace', 'a' * 32, 'global:fixture')
    yield worker
    isolation.LIVE.pop(worker.name, None)


def info(helper):
    return {'Id': 'immutable-id', 'Name': '/' + helper.name,
            'Config': {'Labels': helper.labels}, 'State': {'Running': True}}


def test_trusted_container_has_no_owner_mounts_programs_ports_or_platform_credentials(helper, monkeypatch):
    monkeypatch.setattr(isolation, 'ensure_network', lambda deadline: 'separate-bridge')
    volumes = Mock()
    monkeypatch.setattr(isolation, 'ensure_volume', volumes)
    run = Mock(return_value=SimpleNamespace(returncode=0))
    monkeypatch.setattr(isolation, 'docker', run)
    helper.start(__import__('time').monotonic() + 10)
    command = run.call_args_list[0].args
    assert '--read-only' in command
    assert command[command.index('--network') + 1] == 'separate-bridge'
    assert not set(command) & {'-v', '--volume', '--publish', '-p', '--pid', '--privileged'}
    assert '--no-healthcheck' in command
    mounts = [command[index+1] for index, arg in enumerate(command) if arg == '--mount']
    assert len(mounts) == 2 and all(value.startswith('type=volume,source=isolated-fixture-mcp-data-') for value in mounts)
    assert all(call.args[1]['gxzs.workspace'] == 'workspace' and call.args[1]['gxzs.mcp-server'] == 'global:fixture'
               for call in volumes.call_args_list)
    assert {command[index+1] for index, arg in enumerate(command) if arg == '-e'} == {
        'PATH=' + isolation.TRUSTED_PATH, 'NODE_PATH=' + isolation.TRUSTED_NODE_PATH, 'HOME=/home/gxzs', 'LANG=C.UTF-8'}
    assert command[command.index('--entrypoint') + 1] == '/usr/local/bin/python'
    assert not any('/opt/user-env' in arg or 'TOKEN=' in arg for arg in command)
    assert [command[index+1] for index, arg in enumerate(command) if arg == '--tmpfs'] == [
        '/var/lib/gxzs-tmp/current:rw,exec,nosuid,nodev,uid=1000,gid=1000,mode=700']


def test_network_must_be_separate_and_disable_peer_ingress(monkeypatch):
    monkeypatch.setenv('WORKBENCH_SANDBOX_PREFIX', 'fixture')
    observed = {'Driver': 'bridge', 'Scope': 'local', 'Labels': {'workbench': 'fixture', 'gxzs.purpose': 'global-mcp'},
                'Options': {'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'true'}}
    monkeypatch.setattr(isolation, 'docker', lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout=json.dumps([observed])))
    assert isolation.ensure_network() == 'fixture-global-mcp'
    observed['Options']['com.docker.network.bridge.enable_icc'] = 'true'
    with pytest.raises(RuntimeError, match='identity'):
        isolation.ensure_network()


@pytest.mark.parametrize('failure', [RuntimeError('Docker unavailable'), subprocess.TimeoutExpired('docker', 1)])
def test_uncertain_inspection_or_removal_keeps_capacity_reserved(helper, monkeypatch, failure):
    monkeypatch.setattr(isolation, 'inspect', Mock(side_effect=failure))
    assert helper.close() is False
    assert helper.name in isolation.LIVE


def test_cleanup_uses_inspected_id_and_rejects_a_reused_name(helper, monkeypatch):
    inspect = Mock(side_effect=[info(helper), None])
    remove = Mock()
    monkeypatch.setattr(isolation, 'inspect', inspect)
    monkeypatch.setattr(isolation, 'docker', remove)
    assert helper.close() is True
    assert remove.call_args.args == ('rm', '-f', 'immutable-id')
    assert inspect.call_args.args == ('immutable-id',)
    assert helper.name not in isolation.LIVE
    forged = info(helper)
    forged['Config'] = {'Labels': {**helper.labels, 'gxzs.workspace': 'other'}}
    inspect.side_effect = [forged]
    remove.reset_mock()
    assert helper.close() is False
    remove.assert_not_called()


def test_failed_start_still_owns_a_cleanup_handle(monkeypatch):
    import mcp_runtime
    start = Mock(side_effect=RuntimeError('create timed out after dispatch'))
    close = Mock(return_value=False)
    monkeypatch.setattr(isolation.TrustedWorkerContainer, 'start', start)
    monkeypatch.setattr(isolation.TrustedWorkerContainer, 'close', close)
    with pytest.raises(mcp_runtime.WorkerStartError) as failure:
        mcp_runtime.Worker('owner', 'global:reports', 'v1', 5,
                           configuration={'transport': 'stdio'}, workspace='workspace')
    worker = failure.value.worker
    try:
        assert worker.process is None
        assert worker.close() is False
        close.assert_called_once()
    finally:
        isolation.LIVE.pop(worker.isolation.name, None)


def test_orphan_cleanup_preserves_live_workers_and_checks_all_labels(helper, monkeypatch):
    entry = {'name': helper.name, 'workspace': helper.workspace, 'token': helper.token, 'server': helper.server}
    monkeypatch.setattr(isolation, 'docker', Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps(entry) + '\n')))
    inspect = Mock(return_value=info(helper))
    close = Mock(return_value=True)
    monkeypatch.setattr(isolation, 'inspect', inspect)
    monkeypatch.setattr(isolation.TrustedWorkerContainer, 'close', close)
    found, confirmed = isolation.discover_orphans(time.monotonic()+1)
    assert confirmed and not found
    inspect.assert_not_called()
    isolation.LIVE.pop(helper.name, None)
    found, confirmed = isolation.discover_orphans(time.monotonic()+1)
    assert confirmed and len(found) == 1
    assert found[0].workspace == helper.workspace and found[0].server == helper.server
    close.assert_not_called()


def test_owner_sandbox_stop_cannot_confirm_a_still_running_isolated_worker(monkeypatch):
    import mcp_runtime as runtime
    monkeypatch.setattr(runtime, 'discover_orphans', Mock(return_value=([], True)))
    worker = Mock(isolation=object())
    worker.close.return_value = False
    monkeypatch.setitem(runtime.WORKERS, ('isolation-fence', 'global:reports'), worker)
    try:
        assert runtime.fence_workspace('isolation-fence') is False
        assert worker in runtime.CLOSING
        worker.close.return_value = True
        assert runtime.fence_workspace('isolation-fence') is True
        assert worker not in runtime.CLOSING
    finally:
        runtime.CLOSING.pop(worker, None)


def test_network_lock_and_docker_operations_use_the_call_deadline(monkeypatch):
    run = Mock()
    monkeypatch.setattr(isolation, 'docker', run)
    isolation.NETWORK_GUARD.acquire()
    try:
        before = time.monotonic()
        with pytest.raises(TimeoutError):
            isolation.ensure_network(before+.01)
        assert time.monotonic()-before < .2
        run.assert_not_called()
    finally:
        isolation.NETWORK_GUARD.release()
    observed = {'Driver': 'bridge', 'Scope': 'local', 'Labels': {'workbench': isolation.prefix(), 'gxzs.purpose': 'global-mcp'},
                'Options': {'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.enable_ip_masquerade': 'true'}}
    run.return_value = SimpleNamespace(returncode=0, stdout=json.dumps([observed]))
    isolation.ensure_network(time.monotonic()+.05)
    assert 0 < run.call_args.kwargs['timeout'] <= .050001


def test_data_is_stable_across_connections_and_separate_for_each_owner_and_server(helper, monkeypatch):
    monkeypatch.setattr(isolation, 'ensure_network', lambda deadline: 'network')
    volumes = Mock()
    monkeypatch.setattr(isolation, 'ensure_volume', volumes)
    monkeypatch.setattr(isolation, 'docker', Mock(return_value=SimpleNamespace(returncode=0)))
    all_names = []
    workers = [helper, isolation.TrustedWorkerContainer(helper.workspace, 'b'*32, helper.server),
               isolation.TrustedWorkerContainer('another-owner', 'c'*32, helper.server),
               isolation.TrustedWorkerContainer(helper.workspace, 'd'*32, 'global:other')]
    try:
        for worker in workers:
            volumes.reset_mock()
            worker.start(time.monotonic()+1)
            all_names.append([call.args[0] for call in volumes.call_args_list])
        assert all_names[0] == all_names[1]
        assert set(all_names[0]).isdisjoint(all_names[2])
        assert set(all_names[0]).isdisjoint(all_names[3])
    finally:
        for worker in workers:
            isolation.LIVE.pop(worker.name, None)


def test_existing_data_volume_with_another_identity_is_never_used(monkeypatch):
    observed = {'Name': 'volume', 'Driver': 'local', 'Scope': 'local', 'Labels': {'gxzs.workspace': 'another-owner'}}
    run = Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps([observed])))
    monkeypatch.setattr(isolation, 'docker', run)
    with pytest.raises(RuntimeError, match='identity'):
        isolation.ensure_volume('volume', {'gxzs.workspace': 'owner'}, time.monotonic()+1)
    assert run.call_count == 1


def test_failed_start_cleanup_joins_the_same_fair_queue(monkeypatch):
    import mcp_runtime as runtime
    clock = [10.0]
    monkeypatch.setattr(runtime.time, 'monotonic', lambda: clock[0])
    bad = object.__new__(runtime.Worker)
    bad.process, bad.isolation, bad.cleanup_guard, bad.last_close_attempt = None, Mock(), threading.Lock(), 0
    def wait_until_deadline(*, deadline):
        clock[0] = deadline
        return False
    bad.isolation.close.side_effect = wait_until_deadline
    good = Mock(last_close_attempt=1)
    good.close.return_value = True
    assert not runtime.close_workers([bad, good])
    assert bad.last_close_attempt == 10.0
    runtime.close_workers([bad, good])
    good.close.assert_called_once()


def test_workspace_fence_discovers_restart_orphans_and_never_accepts_unknown_inventory(monkeypatch):
    import mcp_runtime as runtime
    orphan = isolation.TrustedWorkerContainer('restart-owner', 'e'*32, 'global:fixture')
    close = Mock(return_value=False)
    def confirmed_close(**kwargs):
        if close.return_value is True:
            isolation.LIVE.pop(orphan.name, None)
        return close.return_value
    close.side_effect = confirmed_close
    monkeypatch.setattr(orphan, 'close', close)
    inventory = Mock(side_effect=[([orphan], True), ([], False), ([], True)])
    monkeypatch.setattr(runtime, 'discover_orphans', inventory)
    try:
        assert runtime.fence_workspace('restart-owner') is False
        assert orphan in runtime.CLOSING
        close.return_value = True
        assert runtime.fence_workspace('restart-owner') is False
        assert runtime.fence_workspace('restart-owner') is True
        assert orphan not in runtime.CLOSING
    finally:
        runtime.CLOSING.pop(orphan, None)
        isolation.LIVE.pop(orphan.name, None)


def test_fence_waits_for_a_helper_between_discovery_and_queue_registration(monkeypatch):
    import mcp_runtime as runtime
    helper = isolation.TrustedWorkerContainer('registration-owner', 'f'*32, 'global:fixture')
    monkeypatch.setattr(runtime, 'discover_orphans', Mock(return_value=([], True)))
    try:
        assert runtime.fence_workspace('registration-owner') is False
        isolation.LIVE.pop(helper.name, None)
        assert runtime.fence_workspace('registration-owner') is True
    finally:
        isolation.LIVE.pop(helper.name, None)



def test_worker_bootstrap_and_supervisor_share_the_call_deadline(monkeypatch):
    import ast
    import base64
    import zlib
    import mcp_runtime as runtime
    process = Mock()
    helper = Mock(name='isolated')
    helper.name = 'isolated'
    monkeypatch.setattr(runtime, 'TrustedWorkerContainer', Mock(return_value=helper))
    monkeypatch.setattr(runtime.subprocess, 'Popen', Mock(return_value=process))
    monkeypatch.setattr(runtime.threading, 'Thread', Mock())
    monkeypatch.setattr(runtime.time, 'monotonic', lambda: 10.0)
    monkeypatch.setattr(runtime.time, 'time', lambda: 1000.0)
    write = Mock(return_value=None)
    monkeypatch.setattr(runtime, 'write_request', write)
    runtime.Worker('owner', 'global:fixture', 'v1', 10, source='pass',
                   configuration={'transport':'stdio'}, workspace='workspace', deadline=10.05)
    helper.start.assert_called_once_with(10.05)
    assert 0 < write.call_args.kwargs['timeout'] <= .050001
    command = runtime.subprocess.Popen.call_args.args[0]
    packed = ast.parse(command[command.index('-c')+1]).body[1].value.args[0].args[0].args[0].value
    source = zlib.decompress(base64.b64decode(packed)).decode()
    supervise = ast.parse(source).body[-1].value
    assert supervise.func.id == 'supervise' and supervise.args[3].value == pytest.approx(1000.05)


def test_orphan_inventory_and_close_share_one_budget_and_alternate_priority(monkeypatch):
    import mcp_runtime as runtime
    import mcp_policy
    clock = [100.0]
    monkeypatch.setattr(runtime.time, 'monotonic', lambda: clock[0])
    for name in ('WORKERS','CLOSING','LAST_USED'):
        monkeypatch.setattr(runtime, name, {})
    monkeypatch.setattr(runtime, 'ACTIVE', set())
    monkeypatch.setattr(runtime, 'ORPHAN_SCAN_FIRST', True)
    orphan = Mock(workspace='owner', server='global:fixture', last_close_attempt=0)
    def close(*, deadline):
        assert clock[0] < deadline
        clock[0]+=.1
        return True
    orphan.close.side_effect = close
    calls = []
    def inventory(deadline, workspace):
        calls.append(deadline)
        clock[0] = deadline
        return ([orphan] if len(calls)==1 else []), True
    monkeypatch.setattr(runtime, 'discover_orphans', inventory)
    budget = mcp_policy.get('cleanup_timeout_seconds')
    runtime.reap_workers()
    assert clock[0] == 100.0+budget and orphan in runtime.CLOSING
    orphan.close.assert_not_called()
    runtime.reap_workers()
    assert clock[0] == 100.0+budget*2
    orphan.close.assert_called_once()
    assert orphan not in runtime.CLOSING


@pytest.mark.parametrize('server', ['global:fixture', None])
def test_new_connection_cannot_share_data_with_an_unconfirmed_predecessor(monkeypatch, server):
    import mcp_runtime as runtime
    old = Mock()
    monkeypatch.setitem(runtime.CLOSING, old, ('data-owner',server,None))
    start = Mock()
    monkeypatch.setattr(runtime, 'Worker', start)
    result = runtime.invoke('data-owner', 'owner', {'operation':'mcp_test','scope':'global',
        'name':'global:fixture','version':'v1'}, {'version':'v1','enabled':True,'timeout':10})
    assert result['code'] == 'MCP_BUSY'
    start.assert_not_called()


def test_fence_during_authorization_cannot_start_a_late_helper(monkeypatch):
    import mcp_runtime as runtime
    from concurrent.futures import ThreadPoolExecutor
    entered, release = threading.Event(), threading.Event()
    monkeypatch.setattr(runtime, 'discover_orphans', Mock(return_value=([], True)))
    monkeypatch.setattr(runtime, 'validate_grant', lambda *args: 'run')
    start = Mock()
    monkeypatch.setattr(runtime, 'Worker', start)
    def authorize(payload):
        entered.set()
        assert release.wait(2)
        return True
    with ThreadPoolExecutor() as executor:
        future = executor.submit(runtime.invoke, 'late-owner', 'owner', {'operation':'mcp_call','scope':'global',
            'server_id':'fixture','name':'global:fixture','tool':'read','version':'v1','authorization':{}},
            {'version':'v1','enabled':True,'timeout':10,'configuration':{}}, authorize=authorize)
        try:
            assert entered.wait(1)
            assert runtime.fence_workspace('late-owner') is True
        finally:
            release.set()
        assert '未执行' in future.result()['error']
    start.assert_not_called()


@pytest.mark.parametrize('body', [[], {}, [None], ['invalid']])
def test_malformed_inspection_cannot_look_like_absence_or_release_capacity(helper, monkeypatch, body):
    monkeypatch.setattr(isolation, 'docker', Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps(body))))
    assert helper.close() is False
    assert helper.name in isolation.LIVE


def test_cold_start_reclaims_restart_predecessor_before_reusing_private_data(monkeypatch):
    import mcp_runtime as runtime
    for key in ('WORKERS','CLOSING','LAST_USED'):
        monkeypatch.setattr(runtime,key,{})
    events=[]
    orphan=Mock(workspace='cold-owner',server='global:fixture',last_close_attempt=0)
    orphan.close.side_effect=lambda **kwargs: events.append('old-closed') or True
    monkeypatch.setattr(runtime,'discover_orphans',Mock(return_value=([orphan],True)))
    fresh=Mock(version='v1',token='fresh')
    fresh.process.poll.return_value=None
    fresh.response.return_value={'ready':True}
    fresh.send.return_value=None
    start=Mock(side_effect=lambda *args,**kwargs: events.append('new-started') or fresh)
    monkeypatch.setattr(runtime,'Worker',start)
    result=runtime.invoke('cold-owner','owner',{'operation':'mcp_test','scope':'global','name':'global:fixture','version':'v1'},
        {'version':'v1','enabled':True,'timeout':5,'configuration':{}})
    assert result['ready'] and events==['old-closed','new-started']
    assert orphan not in runtime.CLOSING
