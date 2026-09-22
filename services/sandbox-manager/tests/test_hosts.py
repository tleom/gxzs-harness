import json
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hosts import Hosts


def setup(tmp_path, monkeypatch):
    for key, value in {
        'GXZS_HOST_IMAGE': 'host:test', 'GXZS_HOST_NETWORK': 'control',
        'WORKBENCH_MANAGER_HOST_STATE': '/srv/manager', 'GXZS_HOST_PLATFORM_URL': 'http://backend/internal/workbench',
        'GXZS_HOST_MANAGER_URL': 'http://manager:5010', 'WORKBENCH_SANDBOX_MANAGER_TOKEN': 'secret',
        'GXZS_SANDBOX_HELPER_HASH': 'a' * 64,
    }.items(): monkeypatch.setenv(key, value)
    created = {}
    def docker(*args, **kwargs):
        if args[0] == 'inspect':
            return SimpleNamespace(returncode=0 if created else 1, stdout=json.dumps([created]) if created else '')
        if args[0] == 'create':
            created.update(Image='sha256:test', Config={'Image': 'host:test', 'Labels': {'gxzs.owner': 't:1', 'gxzs.workspace': 'workspace', 'gxzs.generation': '1'}}, State={'Running': True}, NetworkSettings={'Ports': {'3081/tcp': [{'HostPort': '32001'}]}})
        return SimpleNamespace(returncode=0, stdout='')
    control = Mock(side_effect=docker)
    ensure = Mock()
    locks = {}
    admission = Mock()
    admission.active.return_value = 0
    host = Hosts(tmp_path, control, ensure, lambda key: ('sandbox-' + key, 'token'), lambda key: locks.setdefault(key, threading.RLock()), admission)
    host.heartbeat = Mock()
    host._ssh = Mock()
    host.healthy = Mock(return_value=True)
    payload = dict(owner_id='t:1', generation=1, instance_id='host-1', platform_token='derived', assertion_key='key', assertion_issuer='gxzs')
    return host, control, ensure, payload, created


def test_first_use_creates_once_and_reuses_workspace(tmp_path, monkeypatch):
    host, docker, sandbox, payload, _ = setup(tmp_path, monkeypatch)
    first = host.ensure('workspace', payload)
    second = host.ensure('workspace', payload)
    assert first == second
    assert first['ready'] is True
    assert len([call for call in docker.call_args_list if call.args[0] == 'create']) == 1
    assert sandbox.call_count == 2
    assert 'platform_token' not in first


def test_does_not_adopt_another_owners_container(tmp_path, monkeypatch):
    host, _, _, payload, created = setup(tmp_path, monkeypatch)
    created.update(Config={'Image': 'host:test', 'Labels': {'gxzs.owner': 'other:2'}})
    with pytest.raises(ValueError, match='not managed'):
        host.ensure('workspace', payload)


def test_identity_mismatch_keeps_existing_workspace(tmp_path, monkeypatch):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    with pytest.raises(ValueError, match='identity changed'):
        host.ensure('workspace', {**payload, 'owner_id': 't:2'})


def test_cross_machine_gateway_receives_private_published_address(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    monkeypatch.setenv('GXZS_HOST_ADVERTISE_IP', '10.16.9.237')
    monkeypatch.setenv('GXZS_HOST_BIND_IP', '10.16.9.237')
    assert host.ensure('workspace', payload)['endpoint'] == 'http://10.16.9.237:32001'
    assert any('10.16.9.237::3081' in call.args for call in docker.call_args_list)


def test_failed_start_is_tracked_and_retains_owner(tmp_path, monkeypatch):
    host, _, sandbox, payload, _ = setup(tmp_path, monkeypatch)
    sandbox.side_effect = RuntimeError('unavailable')
    with pytest.raises(RuntimeError):
        host.ensure('workspace', payload)
    record = json.loads((host.root / 'workspace' / 'host.json').read_text())
    assert record['owner_id'] == 't:1'
    assert record['ready'] is False
    with pytest.raises(ValueError, match='identity changed'):
        host.ensure('workspace', {**payload, 'owner_id': 't:2'})


def test_idle_shutdown_fences_before_reporting_stopped(tmp_path, monkeypatch):
    import os
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    activity = tmp_path / 'workspace'
    activity.touch()
    os.utime(activity, (1, 1))
    host.maintain()
    stops = [call.args[-1] for call in docker.call_args_list if call.args[0] == 'stop']
    assert stops == ['host-1', 'sandbox-workspace']
    host.admission.fence.assert_called_once_with('t:1', 'host-1')
    assert host.heartbeat.call_args.args[1] == 'stopped'


def test_active_task_prevents_idle_shutdown(tmp_path, monkeypatch):
    import os
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    (tmp_path / 'workspace').touch()
    os.utime(tmp_path / 'workspace', (1, 1))
    host.admission.active.return_value = 1
    host.maintain()
    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)
    assert host.heartbeat.call_args.args[1] == 'ready'


def test_schedule_validates_owner_and_stopped_host(tmp_path, monkeypatch):
    host, _, _, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    request = {**payload, 'run_id': 'r', 'chat_id': 'c', 'action': 'acquire'}
    with pytest.raises(ValueError, match='identity mismatch'):
        host.schedule('workspace', {**request, 'owner_id': 't:2'})
    created['State']['Running'] = False
    with pytest.raises(ValueError, match='stopped'):
        host.schedule('workspace', request)
    host.admission.request.assert_not_called()


def test_maintenance_and_admission_share_workspace_lock(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    entered = threading.Event()
    original = host.healthy
    host.healthy = lambda endpoint: (entered.set(), original(endpoint))[1]
    with ThreadPoolExecutor(max_workers=1) as pool:
        with host.lock('workspace'):
            pending = pool.submit(host.maintain)
            assert not entered.wait(0.1)
        pending.result(timeout=5)
    assert entered.is_set()
