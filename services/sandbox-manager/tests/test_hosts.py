import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hosts import Hosts
from resource_limits import ResourceUnavailable


@pytest.fixture(autouse=True)
def close_maintenance_workers(monkeypatch):
    instances = []
    initialize = Hosts.__init__
    def track(instance, *args, **kwargs):
        initialize(instance, *args, **kwargs)
        instances.append(instance)
    monkeypatch.setattr(Hosts, '__init__', track)
    yield
    for instance in instances:
        instance.close()


def maintain(host):
    for future in host.maintain():
        future.result(timeout=5)


def test_missing_host_port_has_a_stable_startup_error(tmp_path, monkeypatch):
    host, control, _, payload, created = setup(tmp_path, monkeypatch)
    created.update(State={'Running':False,'ExitCode':1},NetworkSettings={'Ports':{}})
    with pytest.raises(ResourceUnavailable) as error:
        host._container_identity(payload, '10.16.9.237')
    assert error.value.code == 'HOST_START_PENDING'


def setup(tmp_path, monkeypatch):
    for key, value in {
        'GXZS_HOST_IMAGE': 'host:test', 'GXZS_HOST_NETWORK': 'control',
        'WORKBENCH_MANAGER_HOST_STATE': '/srv/manager', 'GXZS_HOST_PLATFORM_URL': 'http://backend/internal/workbench',
        'GXZS_HOST_MANAGER_URL': 'http://manager:5010', 'WORKBENCH_SANDBOX_MANAGER_TOKEN': 'secret',
        'GXZS_SANDBOX_HELPER_HASH': 'a' * 64,
        'GXZS_HOST_ADVERTISE_IP': '10.16.9.237', 'GXZS_HOST_BIND_IP': '10.16.9.237',
    }.items(): monkeypatch.setenv(key, value)
    created = {}
    def docker(*args, **kwargs):
        if args[:2] == ('image', 'inspect'):
            return SimpleNamespace(returncode=0, stdout=json.dumps([{'Id': 'sha256:test'}]))
        if args[0] == 'inspect':
            return SimpleNamespace(returncode=0 if created else 1, stdout=json.dumps([created]) if created else '')
        if args[0] == 'create':
            created.update(Id='c' * 64, Image='sha256:test', Config={'Image': 'host:test', 'Labels': {'gxzs.owner': 't:1', 'gxzs.workspace': 'workspace', 'gxzs.generation': '1', 'gxzs.credentials': 'owner-v1'}}, State={'Running': True}, NetworkSettings={'Ports': {'3081/tcp': [{'HostPort': '32001'}]}, 'Networks': {'owner-network': {}}})
        return SimpleNamespace(returncode=0, stdout='')
    control = Mock(side_effect=docker)
    ensure = Mock()
    locks = {}
    admission = Mock()
    admission.active.return_value = 0
    admission.busy.return_value = 0
    host = Hosts(tmp_path, control, ensure, lambda key: ('sandbox-' + key, 'token'), lambda key: locks.setdefault(key, threading.RLock()), admission, lambda key: 'owner-network')
    host.heartbeat = Mock()
    host._ssh = Mock()
    host.healthy = Mock(return_value=True)
    host.native_activity = Mock(return_value=dict(runningAgents=0, pendingMessages=0, runningJobs=0, activeSchedules=0, activeSidebarResources=0, activeSettingsWrites=0))
    host.dependency_degraded = Mock(return_value=False)
    host.failed_transport_activity = Mock(return_value=None)
    payload = dict(owner_id='t:1', generation=1, instance_id='host-1', platform_token='derived', assertion_key='a2V5', assertion_issuer='gxzs')
    return host, control, ensure, payload, created


def test_first_use_creates_once_and_reuses_workspace(tmp_path, monkeypatch):
    host, docker, sandbox, payload, _ = setup(tmp_path, monkeypatch)
    first = host.ensure('workspace', payload)
    second = host.ensure('workspace', payload)
    assert first == second
    assert first['ready'] is False
    assert first['state'] == 'provisioning'
    assert first['initial_creation'] is True
    assert len([call for call in docker.call_args_list if call.args[0] == 'create']) == 1
    assert sandbox.call_count == 2
    assert 'platform_token' not in first
    create = next(call.args for call in docker.call_args_list if call.args[0] == 'create')
    assert create[create.index('--cpus') + 1] == '1'
    assert create[create.index('--memory') + 1] == '1g'
    assert create[create.index('--memory-swap') + 1] == '1g'
    assert create[create.index('--network') + 1] == 'owner-network'
    assert 'sandbox-workspace-files:/workspace:ro' in create
    assert not any(value.endswith(':/workspace') for value in create)


def test_account_named_host_keeps_the_logical_instance_and_owner_volumes(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    first = host.ensure('workspace', dict(payload, account_name='00066943'))
    assert first['container_name'] == 'gxzs-host-t.00066943'
    assert first['instance_id'] == 'host-1'
    assert first['initial_creation'] is True
    create = next(call.args for call in docker.call_args_list if call.args[0] == 'create')
    assert create[create.index('--name') + 1] == first['container_name']
    assert 'GXZS_HOST_INSTANCE_ID=host-1' in (host.root / 'workspace' / 'host.env').read_text()
    assert 'sandbox-workspace-files:/workspace:ro' in create
    assert first['sandbox_volume_prefix'] == 'sandbox-workspace'
    assert first['home_volume'] == 'gxzs-dsh-workspace-home'
    assert not any(value.startswith('gxzs-host-t.00066943-home:') or value.startswith('gxzs-sandbox-t.00066943-') for value in create)
    assert 'gxzs.instance=host-1' in create
    assert '/srv/manager/hosts/workspace/ssh:/home/gxzs/.ssh:ro' in create
    host._ssh.assert_called_once_with(host.root / 'workspace', 'gxzs-sandbox-t.00066943')
    with pytest.raises(ValueError, match='account binding'):
        host.ensure('workspace', dict(payload, account_name='other'))


def test_legacy_generation_is_not_renamed_by_an_ordinary_ensure(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    docker.reset_mock()
    result = host.ensure('workspace', dict(payload, account_name='admin'))
    assert 'container_name' not in result
    assert not any(call.args[0] in {'rename', 'create', 'stop'} for call in docker.call_args_list)


def test_existing_sandbox_without_host_is_not_first_creation(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    original = docker.side_effect
    def operate(*args, **kwargs):
        if args[:2] == ('ps', '-a'):
            return SimpleNamespace(returncode=0, stdout='sandbox-workspace\n')
        return original(*args, **kwargs)
    docker.side_effect = operate
    assert host.ensure('workspace', payload)['initial_creation'] is False


def test_first_creation_finishes_once_and_recovery_does_not_reuse_the_hint(tmp_path, monkeypatch):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    assert host.ensure('workspace', payload)['initial_creation'] is True
    maintain(host)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    assert item['ready'] is True and item['initial_creation'] is False
    assert host.ensure('workspace', payload)['initial_creation'] is False


def test_unknown_container_inventory_does_not_claim_first_creation(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    original = docker.side_effect
    def operate(*args, **kwargs):
        if args[:2] == ('ps', '-a'):
            return SimpleNamespace(returncode=1, stdout='')
        return original(*args, **kwargs)
    docker.side_effect = operate
    assert host.ensure('workspace', payload)['initial_creation'] is False


@pytest.mark.parametrize('state', ['ready', 'stopped'])
def test_existing_generation_restart_does_not_claim_initial_creation(tmp_path, monkeypatch, state):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state=state, ready=True)
    host._save(record, item)
    assert host.ensure('workspace', payload)['initial_creation'] is False


def upgrade_setup(tmp_path, monkeypatch):
    host, docker, ensure, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    image = 'sha256:' + 'b' * 64
    created['Image'] = image
    containers = {'host-1': created, 'sandbox-workspace': {'State': {'Running': True}}}
    original = docker.side_effect
    def operate(*args, **kwargs):
        if args[:2] == ('image', 'inspect') and args[2].startswith('sha256:'):
            return SimpleNamespace(returncode=0, stdout=json.dumps([{'Id': args[2]}]))
        if args[0] == 'inspect':
            item = containers.get(args[1])
            return SimpleNamespace(returncode=0 if item else 1, stdout=json.dumps([item]) if item else '',
                                   stderr='' if item else 'Error: No such object: ' + args[1])
        if args[0] == 'stop':
            containers[args[-1]]['State']['Running'] = False
            return SimpleNamespace(returncode=0, stdout='')
        return original(*args, **kwargs)
    docker.side_effect = operate
    record = host.root / 'workspace' / 'host.json'
    data = json.loads(record.read_text())
    data.update(image_digest=image, state='ready', ready=True)
    host._save(record, data)
    docker.reset_mock()
    begin = dict(operation='begin', owner_id='t:1', generation=1, instance_id='host-1')
    return host, docker, payload, containers, record, begin


def test_profile_upgrade_fences_durably_and_only_replace_can_resume(tmp_path, monkeypatch):
    host, docker, payload, containers, record, begin = upgrade_setup(tmp_path, monkeypatch)
    proof = host.profile_upgrade('workspace', begin)
    assert proof['fenced'] and proof['phase'] == 'preparing'
    assert proof['home_volume'] == json.loads(record.read_text())['home_volume']
    assert proof['image_digest'] == containers['host-1']['Image']
    assert proof['token'] not in record.read_text()
    assert all(not item['State']['Running'] for item in containers.values())
    host.admission.fence.assert_called_once_with('t:1', 'host-1')
    docker.reset_mock()
    assert host.ensure('workspace', payload)['ready'] is False
    maintain(host)
    assert not docker.called
    again = Hosts(tmp_path, docker, host.ensure_sandbox, host.identity, host.lock, host.admission, host.ensure_network)
    assert again.profile_upgrade('workspace', begin) == proof
    assert again.profile_upgrade('workspace', dict(operation='check', token=proof['token'])) == proof
    replacement = dict(payload, expected_generation=1, expected_instance_id='host-1', generation=2, instance_id='host-2')
    assert host.replace('workspace', replacement)['code'] == 'PROFILE_UPGRADE_PREPARING'
    completed = again.profile_upgrade('workspace', dict(operation='complete', token=proof['token']))
    assert completed['phase'] == 'prepared' and completed['token'] == proof['token']
    assert json.loads(record.read_text())['state'] == 'fencing'
    again.ensure = Mock(return_value={'new_generation': True})
    assert again.replace('workspace', replacement) == {'new_generation': True}
    after = json.loads(record.read_text())
    assert after['generation'] == 2 and 'profile_upgrade' not in after
    assert not any(call.args[0] in {'start', 'create'} for call in docker.call_args_list)


@pytest.mark.parametrize('activity', [None, *[
    dict(runningAgents=0, pendingMessages=0, runningJobs=0, activeSettingsWrites=0) | {field: 1}
    for field in ('runningAgents', 'pendingMessages', 'runningJobs', 'activeSettingsWrites')]])
def test_profile_upgrade_unknown_or_busy_native_work_stays_draining(tmp_path, monkeypatch, activity):
    host, docker, payload, _, record, begin = upgrade_setup(tmp_path, monkeypatch)
    host.native_activity.return_value = activity
    result = host.profile_upgrade('workspace', begin)
    assert result['fenced'] is False and 'token' not in result
    assert json.loads(record.read_text())['state'] == 'draining'
    assert host.ensure('workspace', payload)['ready'] is False
    maintain(host)
    assert not any(call.args[0] in {'start', 'create', 'stop'} for call in docker.call_args_list)


def test_profile_upgrade_blocks_new_admission_during_drain(tmp_path, monkeypatch):
    host, docker, _, _, record, begin = upgrade_setup(tmp_path, monkeypatch)
    host.admission.busy.return_value = 1
    assert host.profile_upgrade('workspace', begin)['fenced'] is False
    assert json.loads(record.read_text())['state'] == 'draining'
    host.admission.pending.return_value = False
    with pytest.raises(ValueError, match='paused new task admission'):
        host.schedule('workspace', dict(owner_id='t:1', generation=1, instance_id='host-1', run_id='r', chat_id='c', action='acquire'))
    host.admission.request.assert_not_called()
    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)


def test_profile_upgrade_drains_real_existing_tickets_without_admitting_new_work(tmp_path, monkeypatch):
    from admission import Admission
    host, _, _, _, _, begin = upgrade_setup(tmp_path, monkeypatch)
    queue = Admission(str(tmp_path / 'upgrade-admission.db'))
    host.admission = queue
    def schedule(run, action='acquire'):
        return host.schedule('workspace', dict(owner_id='t:1', generation=1, instance_id='host-1',
                                              run_id=run, chat_id='same-chat', action=action))
    try:
        assert queue.request('t:1', 1, 'host-1', 'first', 'same-chat', 'acquire')['state'] == 'running'
        assert queue.request('t:1', 1, 'host-1', 'pending', 'same-chat', 'acquire')['state'] == 'waiting'
        assert queue.busy('t:1') == 2
        assert host.profile_upgrade('workspace', begin)['fenced'] is False
        with pytest.raises(ValueError, match='paused new task admission'):
            schedule('new-task')
        assert schedule('pending')['state'] == 'waiting'
        schedule('first', 'release')
        assert schedule('pending')['state'] == 'running'
        schedule('pending', 'release')
        assert queue.busy('t:1') == 0
        assert host.profile_upgrade('workspace', begin)['fenced']
        with pytest.raises(ValueError, match='paused new task admission'):
            schedule('pending')
    finally:
        queue.close()


@pytest.mark.parametrize('stopped', ['stopped', 'absent'])
def test_profile_upgrade_accepts_registered_stopped_or_absent_host(tmp_path, monkeypatch, stopped):
    host, _, _, containers, _, begin = upgrade_setup(tmp_path, monkeypatch)
    if stopped == 'stopped':
        containers['host-1']['State']['Running'] = False
    else:
        containers.pop('host-1')
    host.native_activity.return_value = None
    proof = host.profile_upgrade('workspace', begin)
    assert proof['fenced'] and proof['image_digest'] == 'sha256:' + 'b' * 64


def test_profile_upgrade_tokens_identity_and_stopped_containers_are_revalidated(tmp_path, monkeypatch):
    host, _, _, containers, record, begin = upgrade_setup(tmp_path, monkeypatch)
    proof = host.profile_upgrade('workspace', begin)
    with pytest.raises(PermissionError):
        host.profile_upgrade('workspace', dict(operation='complete', token='wrong'))
    containers['host-1']['State']['Running'] = True
    with pytest.raises(ValueError, match='remain stopped'):
        host.profile_upgrade('workspace', dict(operation='check', token=proof['token']))
    containers['host-1']['State']['Running'] = False
    data = json.loads(record.read_text())
    data['home_volume'] += '-other'
    host._save(record, data)
    with pytest.raises(ValueError, match='original binding changed'):
        host.profile_upgrade('workspace', dict(operation='complete', token=proof['token']))


def test_profile_upgrade_probes_native_work_without_holding_workspace_lock(tmp_path, monkeypatch):
    host, _, _, _, _, begin = upgrade_setup(tmp_path, monkeypatch)
    acquired = []
    def activity(_):
        def inspect():
            obtained = host.lock('workspace').acquire(timeout=1)
            acquired.append(obtained)
            if obtained:
                host.lock('workspace').release()
        thread = threading.Thread(target=inspect)
        thread.start()
        thread.join(timeout=2)
        return dict(runningAgents=0, pendingMessages=0, runningJobs=0, activeSettingsWrites=0)
    host.native_activity.side_effect = activity
    assert host.profile_upgrade('workspace', begin)['fenced']
    assert acquired == [True]


def test_profile_upgrade_resumes_an_interrupted_stop_without_unfencing(tmp_path, monkeypatch):
    host, docker, payload, containers, record, begin = upgrade_setup(tmp_path, monkeypatch)
    original = docker.side_effect
    failed = []
    def operate(*args, **kwargs):
        if args[0] == 'stop' and args[-1] == 'sandbox-workspace' and not failed:
            failed.append(True)
            raise RuntimeError('stop failed')
        return original(*args, **kwargs)
    docker.side_effect = operate
    with pytest.raises(RuntimeError, match='stop failed'):
        host.profile_upgrade('workspace', begin)
    assert json.loads(record.read_text())['state'] == 'fencing'
    assert containers['sandbox-workspace']['State']['Running']
    assert host.ensure('workspace', payload)['ready'] is False
    host.admission.fence.assert_not_called()
    proof = host.profile_upgrade('workspace', begin)
    assert proof['phase'] == 'preparing' and proof['fenced']
    host.admission.fence.assert_called_once()
    assert not any(call.args[0] in {'start', 'create'} for call in docker.call_args_list)


def test_profile_upgrade_keeps_future_schedules_and_sidebar_leases_out_of_running_work(tmp_path, monkeypatch):
    host, _, _, _, _, begin = upgrade_setup(tmp_path, monkeypatch)
    host.native_activity.return_value = dict(runningAgents=0, pendingMessages=0, runningJobs=0,
                                            activeSettingsWrites=0, activeSchedules=3, activeSidebarResources=2)
    assert host.profile_upgrade('workspace', begin)['fenced']


def test_profile_upgrade_does_not_treat_inspection_failure_as_absence(tmp_path, monkeypatch):
    host, docker, _, _, record, begin = upgrade_setup(tmp_path, monkeypatch)
    proof = host.profile_upgrade('workspace', begin)
    original = docker.side_effect
    def unavailable(*args, **kwargs):
        if args[0] == 'inspect':
            return SimpleNamespace(returncode=1, stdout='', stderr='Cannot connect to the Docker daemon')
        return original(*args, **kwargs)
    docker.side_effect = unavailable
    with pytest.raises(ValueError, match='could not be verified'):
        host.profile_upgrade('workspace', dict(operation='complete', token=proof['token']))
    data = json.loads(record.read_text())
    assert data['state'] == 'fencing' and data['profile_upgrade']['phase'] == 'preparing'


def test_host_fonts_are_mounted_read_only(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    monkeypatch.setenv('GXZS_HOST_FONTS_DIR', '/srv/workbench-fonts')
    host.ensure('workspace', payload)
    create = next(call.args for call in docker.call_args_list if call.args[0] == 'create')
    assert '/srv/workbench-fonts:/usr/local/share/fonts/workbench:ro' in create


def test_host_fonts_reject_relative_mount_path(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    monkeypatch.setenv('GXZS_HOST_FONTS_DIR', '../fonts')
    with pytest.raises(ValueError, match='font directory'):
        host.ensure('workspace', payload)
    assert not any(call.args[0] == 'create' for call in docker.call_args_list)


def test_does_not_adopt_another_owners_container(tmp_path, monkeypatch):
    host, _, _, payload, created = setup(tmp_path, monkeypatch)
    created.update(Config={'Image': 'host:test', 'Labels': {'gxzs.owner': 'other:2'}})
    with pytest.raises(ValueError, match='not managed'):
        host.ensure('workspace', payload)


def test_explicit_global_skill_roots_reach_native_host_config(tmp_path, monkeypatch):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    monkeypatch.setenv('GXZS_GLOBAL_SKILL_DIR', '/srv/dsh/published-skills')
    host.ensure('workspace', payload)
    assert 'GXZS_GLOBAL_SKILL_DIR=/srv/dsh/published-skills\n' in (host.root / 'workspace' / 'host.env').read_text()


def test_global_skill_mount_survives_reuse_and_requires_drained_change(tmp_path, monkeypatch):
    host, docker, _, payload, created = setup(tmp_path, monkeypatch)
    monkeypatch.setenv('GXZS_GLOBAL_SKILL_HOST_DIR', '/srv/global-skills')
    host.ensure('workspace', payload)
    create = next(call.args for call in docker.call_args_list if call.args[0] == 'create')
    assert 'type=bind,source=/srv/global-skills,destination=/opt/workbench-global/skills,readonly' in create
    assert 'GXZS_GLOBAL_SKILL_DIR=/opt/workbench-global/skills\n' in (host.root / 'workspace' / 'host.env').read_text()
    created['Mounts'] = [{'Type': 'bind', 'Source': '/srv/global-skills', 'Destination': '/opt/workbench-global/skills', 'RW': False}]
    host.ensure('workspace', payload)
    created['Mounts'][0]['RW'] = True
    with pytest.raises(ValueError, match='global skill mount changed'):
        host.ensure('workspace', payload)
    assert not any(call.args[0] in {'stop', 'rm', 'rename'} for call in docker.call_args_list)


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


def test_missing_host_advertise_ip_fails_before_creating_network(tmp_path, monkeypatch):
    host, docker, sandbox, payload, _ = setup(tmp_path, monkeypatch)
    monkeypatch.delenv('GXZS_HOST_ADVERTISE_IP')
    with pytest.raises(ValueError, match='advertised and bind IPs are required'):
        host.ensure('workspace', payload)
    assert not any(call.args[0] == 'create' for call in docker.call_args_list)


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
    maintain(host)
    stops = [call.args[-1] for call in docker.call_args_list if call.args[0] == 'stop']
    assert stops == ['host-1', 'sandbox-workspace']
    host.admission.fence.assert_called_once_with('t:1', 'host-1')
    assert host.heartbeat.call_args.args[1] == 'stopped'


def test_idle_stopped_pair_is_not_recovered_by_maintenance(tmp_path, monkeypatch):
    import os
    host, docker, _, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    activity = tmp_path / 'workspace'
    activity.touch()
    os.utime(activity, (1, 1))
    maintain(host)
    record = host.root / 'workspace' / 'host.json'
    assert json.loads(record.read_text())['state'] == 'stopped'
    created['State']['Running'] = False
    host.failures['host-1'] = 0
    host.heartbeat.reset_mock()
    docker.reset_mock()

    maintain(host)

    assert not any(call.args[0] in {'stop', 'start', 'create', 'rename'} for call in docker.call_args_list)
    host.heartbeat.assert_not_called()
    assert json.loads(record.read_text())['state'] == 'stopped'


def test_stopped_record_reconciles_stale_running_pair_after_admission_is_idle(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    item = host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    record.write_text(json.dumps({**item, 'state': 'stopped', 'ready': False}))
    host.heartbeat.reset_mock()
    docker.reset_mock()

    maintain(host)

    stops = [call.args[-1] for call in docker.call_args_list if call.args[0] == 'stop']
    assert stops == ['host-1', 'sandbox-workspace']
    host.admission.fence.assert_called_once_with('t:1', 'host-1')
    host.heartbeat.assert_called_once()
    assert host.heartbeat.call_args.args[1] == 'stopped'
    assert not any(call.args[0] in {'start', 'create', 'rename'} for call in docker.call_args_list)


def test_stopped_record_with_busy_admission_does_not_stop_stale_pair(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    item = host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    record.write_text(json.dumps({**item, 'state': 'stopped', 'ready': False}))
    host.admission.busy.return_value = 1
    docker.reset_mock()

    maintain(host)

    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)
    host.admission.fence.assert_not_called()


def test_active_task_prevents_idle_shutdown(tmp_path, monkeypatch):
    import os
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    (tmp_path / 'workspace').touch()
    os.utime(tmp_path / 'workspace', (1, 1))
    host.admission.busy.return_value = 1
    maintain(host)
    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)
    assert host.heartbeat.call_args.args[1] == 'ready'


def test_native_activity_prevents_idle_shutdown_without_platform_admission(tmp_path, monkeypatch):
    import os
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    (tmp_path / 'workspace').touch()
    os.utime(tmp_path / 'workspace', (1, 1))
    host.native_activity.return_value = None
    maintain(host)
    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)
    host.admission.fence.assert_not_called()
    assert host.heartbeat.call_args.args[1] == 'ready'


@pytest.mark.parametrize('activity', [None, {'protocol': 1, 'status': 'unknown'},
    {'protocol': 1, 'status': 'ready'}])
def test_incomplete_native_activity_does_not_authorize_shutdown(tmp_path, monkeypatch, activity):
    host, _, _, _, _ = setup(tmp_path, monkeypatch)
    host.opener = MagicMock()
    response = host.opener.open.return_value.__enter__.return_value
    response.status = 200
    response.read.return_value = json.dumps({'ready': True, 'activity': activity}).encode()
    assert Hosts.native_activity(host, 'http://host') is None


@pytest.mark.parametrize('key,value', [('runningAgents', 1), ('pendingMessages', 1), ('runningJobs', 1),
                                      ('activeSchedules', 1), ('activeSidebarResources', 1), ('activeSettingsWrites', 1), ('runningJobs', False), ('runningAgents', -1)])
def test_native_work_keeps_host_resident(tmp_path, monkeypatch, key, value):
    host, _, _, _, _ = setup(tmp_path, monkeypatch)
    activity = dict(protocol=1, status='ready', runningAgents=0, pendingMessages=0, runningJobs=0, activeSchedules=0, activeSidebarResources=0, activeSettingsWrites=0)
    host.opener = MagicMock()
    response = host.opener.open.return_value.__enter__.return_value
    response.status = 200
    response.read.return_value = json.dumps({'ready': True, 'activity': activity}).encode()
    assert Hosts.native_activity(host, 'http://host') == {key: value for key, value in activity.items() if key not in {'protocol', 'status'}}
    activity[key] = value
    response.read.return_value = json.dumps({'ready': True, 'activity': activity}).encode()
    projected = Hosts.native_activity(host, 'http://host')
    if type(value) is not int or value < 0:
        assert projected is None
    else:
        assert projected[key] == value


@pytest.mark.parametrize('key', ['runningAgents', 'pendingMessages', 'runningJobs', 'activeSidebarResources'])
def test_real_native_work_refreshes_idle_clock_and_keeps_recently_closed_work_alive(tmp_path, monkeypatch, key):
    import os
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    activity = tmp_path / 'workspace'
    activity.touch()
    os.utime(activity, (1, 1))
    host.native_activity.return_value[key] = 1
    maintain(host)
    assert activity.stat().st_mtime > time.time() - 5
    host.native_activity.return_value = {field: 0 for field in host.native_activity.return_value}
    maintain(host)
    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)
    assert json.loads((host.root / 'workspace' / 'host.json').read_text())['state'] == 'ready'


def test_empty_and_unknown_probes_do_not_extend_idle_clock_or_erase_known_activity(tmp_path, monkeypatch):
    import os
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    activity = tmp_path / 'workspace'
    activity.touch()
    maintain(host)
    host.native_activity.return_value = None
    os.utime(activity, (1, 1))
    maintain(host)
    assert activity.stat().st_mtime == 1
    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)
    host.native_activity.return_value = dict(runningAgents=0, pendingMessages=0, runningJobs=0, activeSchedules=0, activeSidebarResources=0, activeSettingsWrites=0)
    maintain(host)
    assert any(call.args[0] == 'stop' for call in docker.call_args_list)
    assert activity.stat().st_mtime == 1


@pytest.mark.parametrize('state', ['ready', 'provisioning', 'draining'])
def test_live_unready_host_accumulates_failure_without_state_regression(tmp_path, monkeypatch, state):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state=state, ready=state == 'ready')
    record.write_text(json.dumps(item))
    host.healthy.return_value = False
    host.alive = Mock(return_value=True)
    host.native_activity.return_value = None
    host.failures['host-1'] = time.time()
    host.admission.busy.return_value = 1
    host.heartbeat.reset_mock()
    maintain(host)
    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)
    host.admission.fence.assert_not_called()
    assert 'host-1' in host.failures
    if state == 'ready':
        host.heartbeat.assert_not_called()
        assert json.loads(record.read_text())['state'] == 'ready'
    else:
        assert host.heartbeat.call_args.args[1] == state


@pytest.mark.parametrize('recovery', ['ready', 'failed'])
def test_external_catalog_degradation_pauses_admission_without_restarting_pair(tmp_path, monkeypatch, recovery):
    from io import BytesIO
    from urllib.error import HTTPError
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    host.healthy.return_value = False
    host.alive = Mock(return_value=True)
    host.native_activity.return_value = None
    health = {'live': True, 'ready': False, 'recovery': recovery,
              'resources': 'unavailable', 'recovery_dependency': 'mcp_catalog'}
    host.opener.open = Mock(side_effect=lambda *_args, **_kwargs: (_ for _ in ()).throw(HTTPError(
        'http://host/health', 503, 'degraded', {}, BytesIO(json.dumps(health).encode()))))
    del host.dependency_degraded
    host.failures['host-1'] = 0
    host.recoveries['host-1'] = {'attempts': 3, 'next_retry_at': 0}
    host.heartbeat.reset_mock()

    maintain(host)

    assert not any(call.args[0] == 'stop' for call in docker.call_args_list)
    host.admission.fence.assert_not_called()
    host.heartbeat.assert_not_called()
    assert json.loads(record.read_text()) == {**item, 'ready': False}
    assert 'host-1' not in host.failures
    assert 'host-1' not in host.recoveries


def test_current_pid_pressure_pauses_admission_and_recovers_without_restart(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    host.alive = Mock(return_value=True)
    host.failures['host-1'] = 0
    monkeypatch.setattr('hosts.pid_pressure', lambda info: True)
    docker.reset_mock()
    maintain(host)
    assert not any(call.args[0] in ('stop','rename','create') for call in docker.call_args_list)
    assert json.loads(record.read_text())['ready'] is False
    monkeypatch.setattr('hosts.pid_pressure', lambda info: False)
    maintain(host)
    assert json.loads(record.read_text())['ready'] is True


def test_dead_host_pair_is_fenced_and_restarted_after_liveness_grace(tmp_path, monkeypatch):
    host, docker, sandbox, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    created['State']['Running'] = False
    host.healthy.return_value = False
    host.alive = Mock(return_value=False)
    host.failures['host-1'] = 0
    host.admission.busy.return_value = 1
    host.heartbeat.reset_mock()
    sandbox.reset_mock()
    host._ssh.reset_mock()
    maintain(host)
    assert [call.args[-1] for call in docker.call_args_list if call.args[0] == 'stop'] == ['host-1', 'sandbox-workspace']
    host.admission.fence.assert_called_once_with('t:1', 'host-1', preserve_pending=True)
    sandbox.assert_called_once_with('workspace')
    host._ssh.assert_called_once()
    assert any(call.args[:2] == ('rename', 'host-1') for call in docker.call_args_list)
    assert any(call.args == ('start', 'host-1') for call in docker.call_args_list)
    assert json.loads(record.read_text()) == {**item, 'ready': False}
    host.heartbeat.assert_not_called()


def test_healthy_recovery_removes_only_verified_stopped_predecessor(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    host.healthy.return_value = False
    host.alive = Mock(return_value=False)
    host.failures['host-1'] = 0
    maintain(host)

    original = docker.side_effect
    old_name = 'host-1-previous-' + 'c' * 12
    def with_predecessors(*args, **kwargs):
        if args[0] == 'ps':
            return SimpleNamespace(returncode=0, stdout=old_name + '\n' + 'host-1-previous-' + 'a' * 12 + '\n')
        if args[:2] == ('inspect', old_name):
            return SimpleNamespace(returncode=0, stdout=json.dumps([{
                'Id': 'c' * 64, 'State': {'Running': False},
                'Config': {'Labels': {'gxzs.owner': 't:1', 'gxzs.workspace': 'workspace', 'gxzs.generation': '1'}},
            }]))
        return original(*args, **kwargs)
    docker.side_effect = with_predecessors
    host.healthy.return_value = True
    maintain(host)
    assert [call.args for call in docker.call_args_list if call.args[0] == 'rm'] == [('rm', 'c' * 64)]


def test_slow_predecessor_cleanup_does_not_hold_admission_lock(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    entered, release = threading.Event(), threading.Event()
    def slow_cleanup(_item):
        entered.set()
        assert release.wait(5)
    host._cleanup_superseded = Mock(side_effect=slow_cleanup)
    host.admission.request.return_value = {'state': 'running'}
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(maintain, host)
        try:
            assert entered.wait(2)
            request = {**payload, 'run_id': 'r', 'chat_id': 'c', 'action': 'acquire'}
            assert pool.submit(host.schedule, 'workspace', request).result(timeout=1) == {'state': 'running'}
        finally:
            release.set()
            pending.result(timeout=5)


def test_predecessor_cleanup_skips_changed_host_identity(tmp_path, monkeypatch):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    def changed_identity(_item, _state):
        current = json.loads(record.read_text())
        current.update(generation=2, instance_id='host-2')
        record.write_text(json.dumps(current))
    host.heartbeat = Mock(side_effect=changed_identity)
    host._cleanup_superseded = Mock()
    maintain(host)
    host._cleanup_superseded.assert_not_called()


def test_missing_host_container_is_recreated_from_durable_owner_state(tmp_path, monkeypatch):
    host, docker, sandbox, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    created.clear()
    host.failures['host-1'] = 0
    host.healthy.return_value = False
    host.alive = Mock(return_value=False)
    sandbox.reset_mock()
    host._ssh.reset_mock()

    maintain(host)

    creates = [call.args for call in docker.call_args_list if call.args[0] == 'create']
    assert len(creates) == 2
    assert sandbox.call_args.args == ('workspace',)
    host._ssh.assert_called_once()
    assert json.loads(record.read_text())['endpoint'] == 'http://10.16.9.237:32001'
    assert any(call.args == ('start', 'host-1') for call in docker.call_args_list)


def test_missing_host_uses_short_debounce_before_recovery(tmp_path, monkeypatch):
    host, docker, _, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    created.clear()
    host.healthy.return_value = False
    host.alive = Mock(return_value=False)
    host.failures['host-1'] = time.time() - 4
    creates = len([call for call in docker.call_args_list if call.args[0] == 'create'])
    maintain(host)
    assert len([call for call in docker.call_args_list if call.args[0] == 'create']) == creates
    host.failures['host-1'] = time.time() - 6
    maintain(host)
    assert len([call for call in docker.call_args_list if call.args[0] == 'create']) == creates + 1


def test_unhealthy_sandbox_restarts_pair_even_when_host_health_endpoint_is_ready(tmp_path, monkeypatch):
    host, docker, sandbox, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    original = docker.side_effect
    def inspect_sandbox(*args, **kwargs):
        if args == ('inspect', 'sandbox-workspace'):
            value = json.loads(json.dumps(created))
            value['State']['Health'] = {'Status': 'unhealthy'}
            return SimpleNamespace(returncode=0, stdout=json.dumps([value]))
        return original(*args, **kwargs)
    docker.side_effect = inspect_sandbox
    host.alive = Mock(return_value=True)
    host.failures['host-1'] = 0
    sandbox.reset_mock()
    maintain(host)
    assert [call.args[-1] for call in docker.call_args_list if call.args[0] == 'stop'] == ['host-1', 'sandbox-workspace']
    sandbox.assert_called_once_with('workspace')
    assert host.recoveries['host-1']['attempts'] == 1


def test_recovering_ready_host_rejects_new_acquire_without_regressive_ensure(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    current = host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    current.update(state='ready', ready=False)
    record.write_text(json.dumps(current))
    host.heartbeat.reset_mock()
    assert host.ensure('workspace', payload) == current
    host.heartbeat.assert_not_called()
    request = {**payload, 'run_id': 'r', 'chat_id': 'c'}
    with pytest.raises(ResourceUnavailable) as error:
        host.schedule('workspace', {**request, 'action': 'acquire'})
    assert error.value.code == 'HOST_NOT_READY'
    assert error.value.retry_after == 2
    host.schedule('workspace', {**request, 'action': 'renew'})
    assert host.admission.request.call_args.args[5] == 'renew'
    current['ready'] = True
    record.write_text(json.dumps(current))
    host.admission.request.return_value = {'state': 'running'}
    assert host.schedule('workspace', {**request, 'action': 'acquire'}) == {'state': 'running'}


@pytest.mark.parametrize('alive,busy', [(True, 1), (False, 1), (True, 0), (False, 0)])
def test_probe_outage_cannot_kill_running_pair_after_recovery_grace(tmp_path, monkeypatch, alive, busy):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    host.healthy.return_value = False
    host.alive = Mock(return_value=alive)
    host.native_activity.return_value = None
    host.admission.busy.return_value = busy
    host.failures['host-1'] = 0
    docker.reset_mock()
    for _ in range(3):
        maintain(host)
    assert not any(call.args[0] in ('stop', 'rename', 'create') for call in docker.call_args_list)
    host.admission.fence.assert_not_called()
    assert json.loads(record.read_text()) == {**item, 'ready': False}
    host.healthy.return_value = True
    maintain(host)
    assert json.loads(record.read_text()) == item


def test_later_complete_activity_response_recovers_readiness_without_restart(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    host.healthy.return_value = False
    host.alive = Mock(return_value=True)
    host.failures['host-1'] = 0
    host.native_activity.return_value['runningAgents'] = 1
    docker.reset_mock()
    maintain(host)
    assert not any(call.args[0] in ('stop', 'rename', 'create') for call in docker.call_args_list)
    assert json.loads((host.root / 'workspace' / 'host.json').read_text())['ready'] is True


def failed_ssh_setup(tmp_path, monkeypatch):
    host, docker, sandbox, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    host._save(record, item)
    host.healthy.return_value = False
    host.alive = Mock(return_value=True)
    host.native_activity.return_value = None
    host.failed_transport_activity.return_value = dict(runningAgents=0, pendingMessages=6,
        runningJobs=0, activeSchedules=1, activeSidebarResources=2, activeSettingsWrites=0)
    host.failures['host-1'] = 0
    host.admission.busy.return_value = 2
    docker.reset_mock()
    return host, docker, sandbox, payload, created, record, item


@pytest.mark.parametrize('busy', ['runningAgents', 'runningJobs', 'activeSettingsWrites', 'admission'])
def test_failed_ssh_preserves_actual_execution(tmp_path, monkeypatch, busy):
    host, docker, _, _, _, record, item = failed_ssh_setup(tmp_path, monkeypatch)
    if busy == 'admission':
        host.admission.active.return_value = 1
    else:
        host.failed_transport_activity.return_value[busy] = 1
    maintain(host)
    assert not any(call.args[0] in ('stop', 'rename', 'create') for call in docker.call_args_list)
    host.admission.fence.assert_not_called()
    assert json.loads(record.read_text()) == {**item, 'ready': False}


def test_failed_ssh_recovers_idle_pair_and_preserves_queued_tickets(tmp_path, monkeypatch):
    host, docker, sandbox, _, _, record, item = failed_ssh_setup(tmp_path, monkeypatch)
    # An unavailable catalog or PID pressure does not heal a dead transport.
    host.dependency_degraded.return_value = True
    monkeypatch.setattr('hosts.pid_pressure', lambda _info: True)
    maintain(host)
    stops = [call for call in docker.call_args_list if call.args[0] == 'stop']
    assert [call.args[-1] for call in stops] == ['host-1', 'sandbox-workspace']
    assert all(call.kwargs['check'] is True for call in stops)
    host.admission.fence.assert_called_once_with('t:1', 'host-1', preserve_pending=True)
    assert any(call.args == ('start', 'host-1') for call in docker.call_args_list)
    assert json.loads(record.read_text()) == {**item, 'ready': False}
    # A new successful readiness probe is required before admitting more work.
    host.failed_transport_activity.return_value = None
    host.healthy.return_value = True
    monkeypatch.setattr('hosts.pid_pressure', lambda _info: False)
    host.admission.restore_pending.reset_mock()
    maintain(host)
    host.admission.restore_pending.assert_called_once_with('t:1', 1, 'host-1')
    assert json.loads(record.read_text()) == item
    maintain(host)
    host.admission.restore_pending.assert_called_once()


def test_failed_ssh_stop_failure_does_not_fence_or_start_replacement(tmp_path, monkeypatch):
    host, docker, _, _, _, _, _ = failed_ssh_setup(tmp_path, monkeypatch)
    original = docker.side_effect
    def cannot_stop(*args, **kwargs):
        if args[0] == 'stop':
            raise OSError('Docker stop failed')
        return original(*args, **kwargs)
    docker.side_effect = cannot_stop
    maintain(host)
    host.admission.fence.assert_not_called()
    assert not any(call.args[0] in ('rename', 'create', 'start') for call in docker.call_args_list)


@pytest.mark.parametrize('change', [None, 'missing_code', 'wrong_code', 'ready', 'dead', 'unknown_activity', 'negative', 'boolean', 'missing_count', 'malformed', 'timeout', 'wrong_status'])
def test_failed_transport_activity_requires_explicit_failure_and_complete_counts(tmp_path, monkeypatch, change):
    from io import BytesIO
    from urllib.error import HTTPError
    host, _, _, _, _ = setup(tmp_path, monkeypatch)
    counts = dict(runningAgents=0, pendingMessages=2, runningJobs=0, activeSchedules=1, activeSidebarResources=2, activeSettingsWrites=0)
    payload = dict(live=True, ready=False, runtime_error='SSH_UNAVAILABLE', recovery='ready', resources='unavailable',
                   activity=dict(protocol=1, status='ready', **counts))
    if change == 'missing_code': payload.pop('runtime_error')
    if change == 'wrong_code': payload['runtime_error'] = 'UPSTREAM_TIMEOUT'
    if change == 'ready': payload['ready'] = True
    if change == 'dead': payload['live'] = False
    if change == 'unknown_activity': payload['activity'] = {'protocol': 1, 'status': 'unknown'}
    if change == 'negative': payload['activity']['runningJobs'] = -1
    if change == 'boolean': payload['activity']['runningAgents'] = False
    if change == 'missing_count': payload['activity'].pop('activeSettingsWrites')
    body = b'{' if change == 'malformed' else json.dumps(payload).encode()
    def reply(*_args, **_kwargs):
        if change == 'timeout': raise TimeoutError()
        raise HTTPError('http://host/health', 502 if change == 'wrong_status' else 503, 'unready', {}, BytesIO(body))
    host.opener.open = Mock(side_effect=reply)
    assert Hosts.failed_transport_activity(host, 'http://host') == (counts if change is None else None)
    if change is None:
        assert Hosts.dependency_degraded(host, 'http://host') is False


def test_unhealthy_sandbox_does_not_interrupt_admitted_work(tmp_path, monkeypatch):
    host, docker, _, payload, created = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    host.admission.busy.return_value = 1
    created['State']['Health'] = {'Status': 'unhealthy'}
    host.alive = Mock(return_value=True)
    host.failures['host-1'] = 0
    docker.reset_mock()
    maintain(host)
    assert not any(call.args[0] in ('stop', 'rename', 'create') for call in docker.call_args_list)
    host.admission.fence.assert_not_called()


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
            pending = pool.submit(maintain, host)
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
    assert result['endpoint'] == 'http://10.16.9.237:32001'
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
    maintain(host)
    result = json.loads((host.root / 'workspace' / 'host.json').read_text())
    assert result['ready']
    assert host.heartbeat.call_args.args[1] == 'ready'


def test_platform_heartbeat_does_not_block_task_admission(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    entered, release = threading.Event(), threading.Event()
    def stalled_heartbeat(_item, _state):
        entered.set()
        assert release.wait(5)
    host.heartbeat = stalled_heartbeat
    host.admission.request.return_value = {'state': 'running'}
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(maintain, host)
        try:
            assert entered.wait(2)
            request = {**payload, 'run_id': 'r', 'chat_id': 'c', 'action': 'acquire'}
            assert pool.submit(host.schedule, 'workspace', request).result(timeout=1) == {'state': 'running'}
        finally:
            release.set()
            pending.result(timeout=5)


def test_draining_keeps_heartbeat_and_existing_admission(tmp_path, monkeypatch):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    first = host.ensure('workspace', payload)
    host.admission.busy.return_value = 1
    request = {**payload, 'generation': 2, 'instance_id': 'host-2', 'expected_generation': 1, 'expected_instance_id': 'host-1'}
    result = host.replace('workspace', request)
    assert result['state'] == 'draining' and result['generation'] == 1
    maintain(host)
    assert host.heartbeat.call_args.args[1] == 'draining'
    schedule = {**payload, 'run_id': 'r', 'chat_id': 'c'}
    with pytest.raises(ValueError, match='draining'):
        host.schedule('workspace', {**schedule, 'action': 'acquire'})
    host.schedule('workspace', {**schedule, 'action': 'renew'})
    assert host.admission.request.call_args.args[5] == 'renew'
    host.admission.fence.assert_not_called()


def test_draining_finishes_previously_queued_tickets_without_admitting_new_work(tmp_path, monkeypatch):
    from admission import Admission
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    host.admission = Admission(str(tmp_path / 'drain.sqlite3'))
    try:
        assert host.admission.request('t:1', 1, 'host-1', 'running', 'chat', 'acquire')['state'] == 'running'
        assert host.admission.request('t:1', 1, 'host-1', 'queued', 'chat', 'acquire')['state'] == 'waiting'
        result = host.replace('workspace', {**payload, 'generation': 2, 'instance_id': 'host-2',
                                           'expected_generation': 1, 'expected_instance_id': 'host-1'})
        assert result['state'] == 'draining'
        schedule = {**payload, 'chat_id': 'chat'}
        host.schedule('workspace', {**schedule, 'run_id': 'running', 'action': 'release'})
        assert host.schedule('workspace', {**schedule, 'run_id': 'queued', 'action': 'acquire'})['state'] == 'running'
        with pytest.raises(ValueError, match='draining'):
            host.schedule('workspace', {**schedule, 'run_id': 'new', 'action': 'acquire'})
        with pytest.raises(ValueError, match='draining'):
            host.schedule('workspace', {**schedule, 'run_id': 'queued', 'chat_id': 'other-chat', 'action': 'acquire'})
        host.schedule('workspace', {**schedule, 'run_id': 'queued', 'action': 'release'})
        assert host.admission.busy('t:1') == 0
    finally:
        host.admission.db.close()


@pytest.mark.parametrize('resident', ['activeSchedules', 'activeSidebarResources'])
def test_replace_stops_then_fences_and_keeps_home_across_restart(tmp_path, monkeypatch, resident):
    host, control, _, payload, created = setup(tmp_path, monkeypatch)
    initial = host.ensure('workspace', payload)
    host.native_activity.return_value[resident] = 1
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


@pytest.mark.parametrize('native_work', ['runningAgents', 'pendingMessages', 'runningJobs', 'activeSettingsWrites', 'unavailable'])
def test_replace_preserves_native_work_after_model_admission_is_released(tmp_path, monkeypatch, native_work):
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    if native_work == 'unavailable':
        host.native_activity.return_value = None
    else:
        host.native_activity.return_value[native_work] = 1
    host.docker.reset_mock()
    request = {**payload, 'generation': 2, 'instance_id': 'host-2', 'expected_generation': 1, 'expected_instance_id': 'host-1'}
    result = host.replace('workspace', request)
    assert result['state'] == 'draining' and result['generation'] == 1
    assert not any(call.args[0] == 'stop' for call in host.docker.call_args_list)
    host.admission.fence.assert_not_called()


def test_replace_native_probe_does_not_hold_lock_or_apply_a_stale_result(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    host, _, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    baseline = host.native_activity.return_value
    def activity(_):
        def change_record():
            with host.lock('workspace'):
                record = host.root / 'workspace' / 'host.json'
                current = json.loads(record.read_text())
                current['probe_change'] = True
                host._save(record, current)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(change_record).result(timeout=1)
        return baseline
    host.native_activity.side_effect = activity
    host.docker.reset_mock()
    result = host.replace('workspace', {**payload, 'generation': 2, 'instance_id': 'host-2', 'expected_generation': 1, 'expected_instance_id': 'host-1'})
    assert result['probe_change'] and result['state'] == 'draining'
    assert not any(call.args[0] == 'stop' for call in host.docker.call_args_list)


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


@pytest.mark.parametrize('payload,expected', [
    ({'live': True, 'recovery': 'ready', 'resources': 'unavailable'}, True),
    ({'live': True, 'recovery': 'failed', 'recovery_dependency': 'mcp_catalog', 'resources': 'unavailable'}, True),
    ({'live': True, 'recovery': 'failed', 'resources': 'unavailable'}, False),
    ({'live': True, 'recovery': 'failed', 'recovery_dependency': 'mcp_catalog', 'resources': 'ready'}, False),
    ({'live': False, 'recovery': 'failed', 'recovery_dependency': 'mcp_catalog', 'resources': 'unavailable'}, False),
    ({'live': True, 'recovery': 'recovering', 'resources': 'unavailable'}, False),
])
def test_dependency_degradation_requires_live_host_with_verified_catalog_blockage(tmp_path, monkeypatch, payload, expected):
    from io import BytesIO
    from urllib.error import HTTPError
    host, _, _, _, _ = setup(tmp_path, monkeypatch)
    host.opener.open = Mock(side_effect=HTTPError(
        'http://host/health', 503, 'degraded', {},
        BytesIO(json.dumps(payload).encode())))
    # Exercise the implementation rather than setup's default mock.
    del host.dependency_degraded
    assert Hosts.dependency_degraded(host, 'http://host') is expected


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
            exec(script.replace("'/home/gxzs/.ssh'", repr(str(owner_ssh))))
            return SimpleNamespace(returncode=0, stdout='')
        assert args[-2:] == ('cat', '/home/gxzs/.ssh/ssh_host_ed25519_key.pub')
        return SimpleNamespace(returncode=0, stdout='ssh-ed25519 AAAAhost\n')
    host.docker = Mock(side_effect=docker)
    Hosts._ssh(host, folder, 'sandbox-workspace')
    Hosts._ssh(host, folder, 'sandbox-workspace')
    assert authorized.read_text().splitlines() == ['ssh-ed25519 AAAAexisting existing', public]
    assert '[sandbox-workspace]:2222 ssh-ed25519 AAAAhost' in (ssh / 'known_hosts').read_text()
    assert 'Port 2222' in (ssh / 'config').read_text()
    assert host_chown.call_count > 0
    assert all(str(call.args[0]).startswith(str(folder)) for call in host_chown.call_args_list)


@pytest.mark.parametrize('legacy,send_account', [(False, True), (False, False), (True, True)])
def test_readable_name_is_reused_only_after_old_generation_is_fenced(tmp_path, monkeypatch, send_account, legacy):
    host, docker, payload, containers, record, _ = upgrade_setup(tmp_path, monkeypatch)
    name = 'gxzs-host-t.admin'
    containers[name] = containers.pop('host-1')
    containers['sandbox-workspace']['Config'] = {'Labels': {'gxzs.workspace': 'workspace'}}
    containers['sandbox-workspace']['Id'] = 'd' * 64
    data = json.loads(record.read_text())
    data.update(container_name=name, sandbox_name='sandbox-workspace', account_name='admin')
    if legacy:
        containers['host-1'] = containers.pop(name)
        for key in ('container_name', 'sandbox_name', 'account_name'):
            data.pop(key)
    host._save(record, data)
    previous_volume = data['home_volume']
    original = docker.side_effect
    def operate(*args, **kwargs):
        if args[0] == 'rename':
            containers[args[2]] = containers.pop(args[1])
            assert not containers[args[2]]['State']['Running']
            return SimpleNamespace(returncode=0, stdout='')
        return original(*args, **kwargs)
    docker.side_effect = operate
    replacement = dict(payload, expected_generation=1, expected_instance_id='host-1', generation=2, instance_id='host-2')
    if send_account:
        replacement['account_name'] = 'admin'
    host.ensure = Mock(return_value={'new_generation': True})
    host.admission.busy.return_value = 1
    assert host.replace('workspace', replacement)['state'] == 'draining'
    assert containers['host-1' if legacy else name]['State']['Running']
    host.admission.busy.return_value = 0
    assert host.replace('workspace', replacement) == {'new_generation': True}
    after = json.loads(record.read_text())
    assert after['container_name'] == name and after['instance_id'] == 'host-2'
    assert after['generation'] == 2 and after['home_volume'] == previous_volume
    assert after['sandbox_volume_prefix'] == 'sandbox-workspace'
    assert name not in containers
    assert name + '-previous-' + 'c' * 12 in containers
    assert host.replace('workspace', replacement) == {'new_generation': True}
    assert sum(call.args[0] == 'rename' for call in docker.call_args_list) == (2 if legacy else 1)
    if legacy:
        assert 'gxzs-sandbox-t.admin-previous-' + 'd' * 12 in containers
    host.admission.fence.assert_called_once_with('t:1', 'host-1')


def test_name_collision_does_not_stop_or_adopt_another_container(tmp_path, monkeypatch):
    host, docker, payload, containers, record, _ = upgrade_setup(tmp_path, monkeypatch)
    containers['gxzs-host-t.admin'] = {'Id': 'foreign', 'State': {'Running': True}}
    before = record.read_text()
    with pytest.raises(ValueError, match='already allocated'):
        host.replace('workspace', dict(payload, account_name='admin', expected_generation=1, expected_instance_id='host-1', generation=2, instance_id='host-2'))
    assert record.read_text() == before
    assert not any(call.args[0] in {'stop', 'rename', 'create'} for call in docker.call_args_list)


@pytest.mark.parametrize('foreign', ['host', 'sandbox'])
def test_named_replacement_never_stops_a_container_claimed_by_another_workspace(tmp_path, monkeypatch, foreign):
    host, docker, payload, containers, record, _ = upgrade_setup(tmp_path, monkeypatch)
    name = 'gxzs-host-t.admin'
    containers[name] = containers.pop('host-1')
    containers['sandbox-workspace']['Config'] = {'Labels': {'gxzs.workspace': 'workspace'}}
    data = json.loads(record.read_text())
    data.update(container_name=name, sandbox_name='sandbox-workspace', account_name='admin')
    host._save(record, data)
    containers[name if foreign == 'host' else 'sandbox-workspace']['Config']['Labels']['gxzs.workspace'] = 'foreign'
    with pytest.raises(ValueError, match='ownership changed'):
        host.replace('workspace', dict(payload, expected_generation=1, expected_instance_id='host-1', generation=2, instance_id='host-2'))
    assert not any(call.args[0] in {'stop', 'rename', 'create'} for call in docker.call_args_list)
    host.admission.fence.assert_not_called()


@pytest.mark.parametrize('generation,owner,running,removed', [
    ('1', 't:1', False, True), ('2', 't:1', False, True),
    ('3', 't:1', False, False), ('1', 't:2', False, False),
    ('1', 't:1', True, False), ('invalid', 't:1', False, False),
])
def test_named_generation_cleanup_preserves_foreign_or_live_containers(tmp_path, monkeypatch, generation, owner, running, removed):
    host, docker, _, _, _ = setup(tmp_path, monkeypatch)
    name = 'gxzs-host-admin-previous-' + 'c' * 12
    item = dict(container_name='gxzs-host-admin', instance_id='logical-g2', generation=2, owner_id='t:1', workspace_id='workspace')
    record = host.root / 'workspace' / 'host.json'
    record.parent.mkdir()
    record.write_text(json.dumps(dict(item, state='ready', ready=True)))
    def operate(*args, **kwargs):
        if args[0] == 'ps':
            return SimpleNamespace(returncode=0, stdout=name + '\n')
        if args[0] == 'inspect':
            return SimpleNamespace(returncode=0, stdout=json.dumps([{
                'Id': 'c' * 64, 'State': {'Running': running},
                'Config': {'Labels': {'gxzs.owner': owner, 'gxzs.workspace': 'workspace', 'gxzs.generation': generation}},
            }]))
        return SimpleNamespace(returncode=0, stdout='')
    docker.side_effect = operate
    host._cleanup_superseded(item)
    assert any(call.args == ('rm', 'c' * 64) for call in docker.call_args_list) is removed


@pytest.mark.parametrize('workspace,running,identity,removed', [
    ('workspace', False, 'd', True), ('foreign', False, 'd', False),
    ('workspace', True, 'd', False), ('workspace', False, 'e', False),
])
def test_named_sandbox_cleanup_checks_workspace_and_container_identity(tmp_path, monkeypatch, workspace, running, identity, removed):
    host, docker, _, _, _ = setup(tmp_path, monkeypatch)
    name = 'gxzs-sandbox-admin-previous-' + 'd' * 12
    item = dict(container_name='gxzs-host-admin', sandbox_name='gxzs-sandbox-admin', instance_id='logical-g2',
                generation=2, owner_id='t:1', workspace_id='workspace')
    record = host.root / 'workspace' / 'host.json'
    record.parent.mkdir()
    record.write_text(json.dumps(dict(item, state='ready', ready=True)))
    def operate(*args, **kwargs):
        if args[0] == 'ps':
            return SimpleNamespace(returncode=0, stdout=name + '\n')
        if args[0] == 'inspect':
            return SimpleNamespace(returncode=0, stdout=json.dumps([{
                'Id': identity * 64, 'State': {'Running': running},
                'Config': {'Labels': {'gxzs.workspace': workspace}},
            }]))
        return SimpleNamespace(returncode=0, stdout='')
    docker.side_effect = operate
    host._cleanup_superseded(item)
    assert any(call.args == ('rm', 'd' * 64) for call in docker.call_args_list) is removed


@pytest.mark.parametrize('transition', ['fencing', 'next_generation', 'profile_upgrade'])
def test_predecessor_cleanup_revalidates_after_docker_inspection(tmp_path, monkeypatch, transition):
    host, docker, _, _, _ = setup(tmp_path, monkeypatch)
    item = dict(container_name='gxzs-host-admin', instance_id='logical-g2', generation=2,
                owner_id='t:1', workspace_id='workspace', state='ready', ready=True)
    record = host.root / 'workspace' / 'host.json'
    record.parent.mkdir()
    record.write_text(json.dumps(item))
    name = 'gxzs-host-admin-previous-' + 'c' * 12
    def operate(*args, **kwargs):
        if args[0] == 'ps':
            return SimpleNamespace(returncode=0, stdout=name + '\n')
        if args[0] == 'inspect':
            current = dict(item)
            if transition == 'fencing': current.update(state='fencing', ready=False)
            elif transition == 'next_generation': current.update(generation=3, instance_id='logical-g3')
            else: current['profile_upgrade'] = {'phase':'draining'}
            record.write_text(json.dumps(current))
            return SimpleNamespace(returncode=0, stdout=json.dumps([{
                'Id':'c' * 64, 'State':{'Running':False},
                'Config':{'Labels':{'gxzs.owner':'t:1','gxzs.workspace':'workspace','gxzs.generation':'2'}},
            }]))
        raise AssertionError('Stale cleanup must not remove a rollback container')
    docker.side_effect = operate
    host._cleanup_superseded(item)
    assert not any(call.args[0] == 'rm' for call in docker.call_args_list)
