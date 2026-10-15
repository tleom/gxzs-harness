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
    create = next(call.args for call in docker.call_args_list if call.args[0] == 'create')
    assert create[create.index('--cpus') + 1] == '1'
    assert create[create.index('--memory') + 1] == '1g'
    assert create[create.index('--memory-swap') + 1] == '1g'
    assert create[create.index('--network') + 1] == 'owner-network'
    assert 'sandbox-workspace-files:/workspace:ro' in create
    assert not any(value.endswith(':/workspace') for value in create)


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


def test_external_catalog_degradation_pauses_admission_without_restarting_pair(tmp_path, monkeypatch):
    host, docker, _, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    host.healthy.return_value = False
    host.alive = Mock(return_value=True)
    host.dependency_degraded.return_value = True
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
    host, docker, sandbox, payload, _ = setup(tmp_path, monkeypatch)
    host.ensure('workspace', payload)
    record = host.root / 'workspace' / 'host.json'
    item = json.loads(record.read_text())
    item.update(state='ready', ready=True)
    record.write_text(json.dumps(item))
    host.healthy.return_value = False
    host.alive = Mock(return_value=False)
    host.failures['host-1'] = 0
    host.admission.busy.return_value = 1
    host.heartbeat.reset_mock()
    sandbox.reset_mock()
    host._ssh.reset_mock()
    maintain(host)
    assert [call.args[-1] for call in docker.call_args_list if call.args[0] == 'stop'] == ['host-1', 'sandbox-workspace']
    host.admission.fence.assert_called_once_with('t:1', 'host-1')
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
    assert [call.args for call in docker.call_args_list if call.args[0] == 'rm'] == [('rm', old_name)]


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
    with pytest.raises(ValueError, match='not ready'):
        host.schedule('workspace', {**request, 'action': 'acquire'})
    host.schedule('workspace', {**request, 'action': 'renew'})
    assert host.admission.request.call_args.args[5] == 'renew'


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


def test_dependency_degradation_requires_live_recovered_host_and_unavailable_resources(tmp_path, monkeypatch):
    from io import BytesIO
    from urllib.error import HTTPError
    host, _, _, _, _ = setup(tmp_path, monkeypatch)
    host.opener.open = Mock(side_effect=HTTPError(
        'http://host/health', 503, 'degraded', {},
        BytesIO(b'{"live":true,"ready":false,"recovery":"ready","resources":"unavailable"}')))
    # Exercise the implementation rather than setup's default mock.
    del host.dependency_degraded
    assert Hosts.dependency_degraded(host, 'http://host')


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
