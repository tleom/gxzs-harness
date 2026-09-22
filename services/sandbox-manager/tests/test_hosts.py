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
        if args[:2] == ('image', 'inspect'):
            return SimpleNamespace(returncode=0, stdout=json.dumps([{'Id': 'sha256:test'}]))
        if args[0] == 'inspect':
            return SimpleNamespace(returncode=0 if created else 1, stdout=json.dumps([created]) if created else '')
        if args[0] == 'create':
            created.update(Image='sha256:test', Config={'Image': 'host:test', 'Labels': {'gxzs.owner': 't:1', 'gxzs.workspace': 'workspace', 'gxzs.generation': '1', 'gxzs.credentials': 'owner-v1'}}, State={'Running': True}, NetworkSettings={'Ports': {'3081/tcp': [{'HostPort': '32001'}]}})
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
    payload = dict(owner_id='t:1', generation=1, instance_id='host-1', platform_token='derived', assertion_key='a2V5', assertion_issuer='gxzs')
    return host, control, ensure, payload, created


def test_first_use_creates_once_and_reuses_workspace(tmp_path, monkeypatch):
    host, docker, sandbox, payload, _ = setup(tmp_path, monkeypatch)
    first = host.ensure('workspace', payload)
    second = host.ensure('workspace', payload)
    assert first == second
    assert first['ready'] is False
    assert first['state'] == 'provisioning'
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


def migrated_host(tmp_path, monkeypatch):
    host, docker, _, payload, created = setup(tmp_path, monkeypatch)
    payload.update(instance_id='gxzs-migration-host-0', run_id='r', chat_id='c', action='acquire')
    created.update(Config={'Env': [
        'GXZS_HOST_OWNER_ID=t:1', 'GXZS_HOST_GENERATION=1',
        'GXZS_HOST_INSTANCE_ID=gxzs-migration-host-0', 'GXZS_SANDBOX_WORKSPACE_ID=workspace',
    ]}, State={'Running': True})
    return host, docker, payload, created


def test_migrated_host_can_schedule_without_lifecycle_adoption(tmp_path, monkeypatch):
    host, docker, payload, _ = migrated_host(tmp_path, monkeypatch)
    host.admission.request.return_value = {'state': 'running'}
    assert host.schedule('workspace', payload) == {'state': 'running'}
    host.admission.request.assert_called_once_with('t:1', 1, 'gxzs-migration-host-0', 'r', 'c', 'acquire', False)
    assert not (host.root / 'workspace' / 'host.json').exists()
    assert all(call.args[0] == 'inspect' for call in docker.call_args_list)


@pytest.mark.parametrize('key,value', [('owner_id', 't:2'), ('generation', 2), ('instance_id', 'gxzs-migration-host-1')])
def test_migrated_host_rejects_other_identity(tmp_path, monkeypatch, key, value):
    host, _, payload, _ = migrated_host(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match='identity mismatch'):
        host.schedule('workspace', {**payload, key: value})
    host.admission.request.assert_not_called()


def test_migrated_host_rejects_other_workspace_and_stopped_container(tmp_path, monkeypatch):
    host, _, payload, created = migrated_host(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match='identity mismatch'):
        host.schedule('other-workspace', payload)
    created['State']['Running'] = False
    with pytest.raises(ValueError, match='stopped'):
        host.schedule('workspace', payload)
    host.admission.request.assert_not_called()


def test_unregistered_host_does_not_bypass_registration(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match='not registered'):
        host.schedule('workspace', {**payload, 'action': 'acquire'})
    docker.assert_not_called()
    host.admission.request.assert_not_called()


def test_explicit_retry_uses_its_new_admission_ticket(tmp_path, monkeypatch):
    host, _, payload, _ = migrated_host(tmp_path, monkeypatch)
    host.schedule('workspace', {**payload, 'ticket_id': 'new-ticket'})
    host.admission.request.assert_called_once_with('t:1', 1, 'gxzs-migration-host-0', 'new-ticket', 'c', 'acquire', False)


def test_creation_does_not_wait_for_readiness_under_workspace_lock(tmp_path, monkeypatch):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.healthy.side_effect = AssertionError('ensure must not wait for dependent plugin bootstrap')
    result = host.ensure('workspace', payload)
    assert result['state'] == 'provisioning'
    assert result['endpoint'] == 'http://host-1:3081'
    host.heartbeat.assert_called_once()


def test_health_probe_does_not_hold_workspace_lock(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    def healthy(_):
        with ThreadPoolExecutor(max_workers=1) as pool:
            def callback():
                with host.lock('workspace'):
                    return True
            return pool.submit(callback).result(timeout=1)
    host.healthy = healthy
    host.maintain()
    result = json.loads((host.root / 'workspace' / 'host.json').read_text())
    assert result['ready']
    assert host.heartbeat.call_args.args[1] == 'ready'


def test_draining_keeps_heartbeat_and_existing_admission(tmp_path, monkeypatch):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    first = host.ensure('workspace', payload)
    host.admission.active.return_value = 1
    request = {**payload, 'generation': 2, 'instance_id': 'host-2', 'expected_generation': 1, 'expected_instance_id': 'host-1'}
    result = host.replace('workspace', request)
    assert result['state'] == 'draining' and result['generation'] == 1
    host.maintain()
    assert host.heartbeat.call_args.args[1] == 'draining'
    schedule = {**payload, 'run_id': 'r', 'chat_id': 'c'}
    with pytest.raises(ValueError, match='draining'):
        host.schedule('workspace', {**schedule, 'action': 'acquire'})
    host.schedule('workspace', {**schedule, 'action': 'renew'})
    assert host.admission.request.call_args.args[5] == 'renew'
    host.admission.fence.assert_not_called()


def test_replace_stops_then_fences_and_keeps_home_across_restart(tmp_path, monkeypatch):
    host, control, _, payload, created = setup(tmp_path, monkeypatch)
    initial = host.ensure('workspace', payload)
    containers = {'host-1': json.loads(json.dumps(created)), 'sandbox-workspace': {'State': {'Running': True}}}
    ordered = []
    def docker(*args, **kwargs):
        ordered.append(args)
        if args[:2] == ('image', 'inspect'):
            return SimpleNamespace(returncode=0, stdout=json.dumps([{'Id': 'sha256:test'}]))
        if args[0] == 'inspect':
            info = containers.get(args[1])
            return SimpleNamespace(returncode=0 if info else 1, stdout=json.dumps([info]) if info else '')
        if args[0] == 'stop':
            containers[args[-1]]['State']['Running'] = False
        if args[0] == 'create':
            instance = args[args.index('--name') + 1]
            info = json.loads(json.dumps(created))
            info['Config']['Labels']['gxzs.generation'] = '2'
            containers[instance] = info
        if args[0] == 'start':
            containers[args[1]]['State']['Running'] = True
        return SimpleNamespace(returncode=0, stdout='')
    host.docker = Mock(side_effect=docker)
    host.admission.fence.side_effect = lambda *args: ordered.append(('fence', *args))
    request = {**payload, 'generation': 2, 'instance_id': 'host-2', 'expected_generation': 1, 'expected_instance_id': 'host-1'}
    result = host.replace('workspace', request)
    assert result['generation'] == 2 and result['home_volume'] == initial['home_volume']
    fence_index = next(i for i, call in enumerate(ordered) if call[0] == 'fence')
    assert len([call for call in ordered[:fence_index] if call[0] == 'stop']) == 2
    assert any(initial['home_volume'] + ':/srv/dsh' in call for call in ordered if call[0] == 'create')
    # Same durable transition is accepted after a coordinator response loss.
    assert host.replace('workspace', request)['generation'] == 2
    assert len([call for call in ordered if call[0] == 'create']) == 1


def test_changed_digest_and_legacy_credentials_require_replace(tmp_path, monkeypatch):
    host, _, _, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    created['Image'] = 'sha256:previous'
    with pytest.raises(ValueError, match='digest changed'):
        host.ensure('workspace', payload)
    created['Image'] = 'sha256:test'
    created['Config']['Labels'].pop('gxzs.credentials')
    with pytest.raises(ValueError, match='credential rollout'):
        host.ensure('workspace', payload)


def test_liveness_accepts_initializing_503(tmp_path, monkeypatch):
    from io import BytesIO
    from urllib.error import HTTPError
    host, _, _, _, _ = setup(tmp_path, monkeypatch)
    host.opener.open = Mock(side_effect=HTTPError('http://host/health', 503, 'initializing', {}, BytesIO(b'{"live":true,"ready":false}')))
    assert host.alive('http://host')


def test_ssh_installs_keys_as_sandbox_owner_without_chown(tmp_path, monkeypatch):
    import io
    import os
    host, _, _, _, _ = setup(tmp_path, monkeypatch)
    folder = host.root / 'workspace'
    ssh = folder / 'ssh'
    ssh.mkdir(parents=True)
    (ssh / 'id_ed25519').write_text('test-private-placeholder')
    public = 'ssh-ed25519 AAAAtest owner'
    (ssh / 'id_ed25519.pub').write_text(public + '\n')
    owner_ssh = tmp_path / 'owner-ssh'
    owner_ssh.mkdir(mode=0o700)
    authorized = owner_ssh / 'authorized_keys'
    authorized.write_text('ssh-ed25519 AAAAexisting existing\n')
    host_chown = Mock()
    monkeypatch.setattr(os, 'chown', host_chown, raising=False)
    def docker(*args, stdin=None, **kwargs):
        assert args[:3] == ('exec', '--user', '1000')
        if '-c' in args:
            script = args[args.index('-c') + 1]
            assert 'chown' not in script
            monkeypatch.setattr(sys, 'stdin', io.StringIO(stdin))
            exec(script.replace("'/home/dify/.ssh'", repr(str(owner_ssh))))
            return SimpleNamespace(returncode=0, stdout='')
        assert args[-2:] == ('cat', '/home/dify/.ssh/ssh_host_ed25519_key.pub')
        return SimpleNamespace(returncode=0, stdout='ssh-ed25519 AAAAhost\n')
    host.docker = Mock(side_effect=docker)
    Hosts._ssh(host, folder, 'sandbox-workspace')
    Hosts._ssh(host, folder, 'sandbox-workspace')
    assert authorized.read_text().splitlines() == ['ssh-ed25519 AAAAexisting existing', public]
    assert '[sandbox-workspace]:2222 ssh-ed25519 AAAAhost' in (ssh / 'known_hosts').read_text()
    assert 'Port 2222' in (ssh / 'config').read_text()
    assert host_chown.call_count > 0
    assert all(str(call.args[0]).startswith(str(folder)) for call in host_chown.call_args_list)
