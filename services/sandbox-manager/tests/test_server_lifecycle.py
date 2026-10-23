import importlib.util
import json
import os
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest


@pytest.fixture
def server(tmp_path, monkeypatch):
    base = Path(__file__).parents[1]
    monkeypatch.syspath_prepend(str(base))
    monkeypatch.setenv('WORKBENCH_SANDBOX_MANAGER_TOKEN', 'x' * 64)
    monkeypatch.setenv('WORKBENCH_MANAGER_STATE', str(tmp_path))
    monkeypatch.setenv('WORKBENCH_SANDBOX_NETWORK', 'owner-sandbox')
    spec = importlib.util.spec_from_file_location('tested_server_lifecycle_' + uuid4().hex, base / 'server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    yield module
    module.HOSTS.close()
    module.ADMISSION.close()


@pytest.mark.parametrize('state,ready,expected', [
    ('provisioning', False, True), ('ready', False, True),
    ('ready', True, False), ('draining', False, False), ('fencing', False, False),
])
def test_ensure_host_probes_only_the_waiting_owner_after_provisioning(server, monkeypatch, state, ready, expected):
    key = str(uuid4())
    payload = {'owner_id': 'tenant:7'}
    result = {'state': state, 'ready': ready}
    folder = server.HOSTS.root / key
    folder.mkdir()
    (folder / 'host.json').write_text(json.dumps(result))
    ensure = Mock(return_value=result)
    maintain = Mock(return_value=[])
    monkeypatch.setattr(server.HOSTS, 'ensure', ensure)
    monkeypatch.setattr(server.HOSTS, 'maintain', maintain)
    assert server.operation(key, 'ensure-host', payload) == result
    ensure.assert_called_once_with(key, payload)
    if expected:
        maintain.assert_called_once_with(key)
    else:
        maintain.assert_not_called()


def test_ensure_returns_a_completed_readiness_probe_without_an_extra_client_retry(server, monkeypatch):
    from concurrent.futures import Future
    key = str(uuid4())
    pending = dict(owner_id='tenant:7', generation=1, instance_id='host-1', state='provisioning', ready=False)
    ready = dict(pending, state='ready', ready=True)
    folder = server.HOSTS.root / key
    folder.mkdir()
    (folder / 'host.json').write_text(json.dumps(ready))
    probe = Future()
    probe.set_result(None)
    monkeypatch.setattr(server.HOSTS, 'ensure', Mock(return_value=pending))
    monkeypatch.setattr(server.HOSTS, 'maintain', Mock(return_value=[probe]))
    assert server.operation(key, 'ensure-host', pending) == ready
    (folder / 'host.json').write_text(json.dumps(dict(ready, instance_id='replacement')))
    with pytest.raises(server.ResourceUnavailable):
        server.operation(key, 'ensure-host', pending)


def test_ensure_does_not_wait_for_a_slow_startup_probe(server, monkeypatch):
    from concurrent.futures import Future
    import time
    key = str(uuid4())
    pending = dict(owner_id='tenant:7', generation=1, instance_id='host-1', state='provisioning', ready=False)
    folder = server.HOSTS.root / key
    folder.mkdir()
    (folder / 'host.json').write_text(json.dumps(pending))
    probe = Future()
    monkeypatch.setattr(server.HOSTS, 'ensure', Mock(return_value=pending))
    monkeypatch.setattr(server.HOSTS, 'maintain', Mock(return_value=[probe]))
    start = time.monotonic()
    assert server.operation(key, 'ensure-host', pending) == pending
    assert time.monotonic()-start < 1
    assert not probe.cancelled()


@pytest.mark.parametrize('blocked_work', ['other-owner', 'post-probe', 'lifecycle-lock'])
def test_ensure_observes_its_own_ready_snapshot_with_bounded_wait(server, monkeypatch, blocked_work):
    import threading
    import time
    key, other = str(uuid4()), str(uuid4())
    pending = dict(owner_id='tenant:7', workspace_id=key, generation=1,
                   instance_id='host-1', state='provisioning', ready=False)
    for workspace in (key, other):
        folder = server.HOSTS.root / workspace
        folder.mkdir()
        (folder / 'host.json').write_text(json.dumps(dict(pending, workspace_id=workspace)))
    entered, release = threading.Event(), threading.Event()
    def maintain(record):
        if record.parent.name == other:
            entered.set()
            assert release.wait(3)
        elif blocked_work == 'lifecycle-lock':
            with server.HOSTS.lock(key):
                entered.set()
                assert release.wait(3)
        else:
            server.HOSTS._save(record, dict(pending, state='ready', ready=True))
            entered.set()
            if blocked_work == 'post-probe':
                assert release.wait(3)
    monkeypatch.setattr(server.HOSTS, '_maintain_one', maintain)
    monkeypatch.setattr(server.HOSTS, 'ensure', Mock(return_value=pending))
    waited = []
    original_wait = server.wait
    def wait(probes, **kwargs):
        waited.extend(probes)
        return original_wait(probes, **kwargs)
    monkeypatch.setattr(server, 'wait', wait)
    if blocked_work == 'other-owner':
        other_probe, = server.HOSTS.maintain(other)
        assert entered.wait(1)
    try:
        start = time.monotonic()
        result = server.operation(key, 'ensure-host', pending)
        assert time.monotonic() - start < 1
        assert entered.is_set()
        assert result['ready'] is (blocked_work != 'lifecycle-lock')
        assert len(waited) == 1
        if blocked_work == 'other-owner':
            assert other_probe not in waited
            assert not other_probe.done()
    finally:
        release.set()


@pytest.mark.parametrize('changed', ['owner_id', 'generation', 'instance_id', 'deleted'])
def test_ensure_revalidates_identity_even_when_probe_has_not_finished(server, monkeypatch, changed):
    from concurrent.futures import Future
    key = str(uuid4())
    pending = dict(owner_id='tenant:7', generation=1, instance_id='host-1', state='provisioning', ready=False)
    folder = server.HOSTS.root / key
    folder.mkdir()
    if changed != 'deleted':
        value = 2 if changed == 'generation' else 'replacement'
        (folder / 'host.json').write_text(json.dumps(dict(pending, **{changed: value})))
    probe = Future()
    monkeypatch.setattr(server.HOSTS, 'ensure', Mock(return_value=pending))
    monkeypatch.setattr(server.HOSTS, 'maintain', Mock(return_value=[probe]))
    with pytest.raises(server.ResourceUnavailable):
        server.operation(key, 'ensure-host', pending)
    assert not probe.cancelled()


def test_first_creation_keeps_host_home_isolated_from_personal_environment_initialization(server, monkeypatch):
    key = str(uuid4())
    folder = server.HOSTS.root / key
    folder.mkdir()
    (folder / 'host.json').write_text(json.dumps(dict(owner_id='tenant:7', workspace_id=key, home_volume='owner-host-home')))
    calls = []
    def docker(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=1 if args[0]=='inspect' else 0, stdout='')
    monkeypatch.setattr(server, 'docker', docker)
    monkeypatch.setattr(server, 'ensure_network', lambda _: 'owner-network')
    server.ensure(key)
    helpers = [args for args in calls if args[0]=='run']
    assert len(helpers) == 2
    attachment = next(args for args in helpers if 'owner-host-home:/srv/dsh' in args)
    environment = next(args for args in helpers if any('/opt/user-env' in value for value in args[:-1]))
    assert not any('/workspace' in value or '/opt/user-env' in value for value in attachment)
    assert not any('/srv/dsh' in value for value in environment)
    assert environment[-1].index('os.setuid(1000)') < environment[-1].index('workbench_office.pth')


def test_profile_upgrade_route_uses_the_registered_host_authority(server, monkeypatch):
    key = str(uuid4())
    expected = {'fenced': False, 'phase': 'draining'}
    callback = Mock(return_value=expected)
    monkeypatch.setattr(server.HOSTS, 'profile_upgrade', callback)
    payload = {'operation': 'begin', 'owner_id': 'tenant:7', 'generation': 2, 'instance_id': 'old-host'}
    assert server.operation(key, 'profile-upgrade', payload) == expected
    callback.assert_called_once_with(key, payload)


@pytest.mark.parametrize('state', ['draining', 'fencing'])
@pytest.mark.parametrize('allow_existing_image', [False, True])
def test_profile_upgrade_prevents_starting_a_stopped_or_missing_sandbox(server, monkeypatch, state, allow_existing_image):
    key = str(uuid4())
    folder = server.HOSTS.root / key
    folder.mkdir()
    record = dict(owner_id='tenant:7', workspace_id=key, generation=2, instance_id='old-host',
                  home_volume='existing-home', state=state, profile_upgrade={'phase': 'preparing'})
    (folder / 'host.json').write_text(json.dumps(record), encoding='utf-8')
    monkeypatch.setattr(server, 'ensure_network', Mock(return_value='existing-network'))
    docker = Mock(return_value=SimpleNamespace(returncode=1, stdout=''))
    monkeypatch.setattr(server, 'docker', docker)
    with pytest.raises(server.SandboxUpdatePending):
        server.ensure(key, allow_existing_image=allow_existing_image)
    assert not any(call.args[0] in {'start', 'create', 'volume', 'rename'} for call in docker.call_args_list)


def test_native_settings_check_is_owner_scoped_and_serialized_with_draining(server):
    from concurrent.futures import ThreadPoolExecutor
    from email.message import Message
    import threading
    from owner_auth import owner_token
    key = str(uuid4())
    folder = server.HOSTS.root / key
    folder.mkdir()
    record = dict(owner_id='tenant:7', workspace_id=key, generation=2, instance_id='host-2', state='ready')
    (folder / 'host.json').write_text(json.dumps(record), encoding='utf-8')
    headers = Message()
    headers['Authorization'] = 'Bearer ' + owner_token(server.TOKEN, 'tenant:7', key, 2, 'host-2')
    headers['X-GXZS-Owner'] = 'tenant:7'
    headers['X-GXZS-Host-Generation'] = '2'
    headers['X-GXZS-Host-Instance'] = 'host-2'
    entered = threading.Event()
    def check():
        server.REQUEST_CONTEXT.owner = (headers, key, 'host-settings')
        entered.set()
        try:
            return server.operation(key, 'host-settings', {'operation': 'check'})
        finally:
            server.REQUEST_CONTEXT.owner = None
    assert check() == {'writable': True}
    with pytest.raises(ValueError, match='Unsupported'):
        server.operation(key, 'host-settings', {'operation': 'mutate'})
    entered.clear()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with server.lock(key):
            record['state'] = 'draining'
            (folder / 'host.json').write_text(json.dumps(record), encoding='utf-8')
            future = pool.submit(check)
            assert entered.wait(timeout=1)
            assert not future.done()
        with pytest.raises(server.SandboxUpdatePending):
            future.result(timeout=1)
    record.update(state='ready', generation=3, instance_id='host-3')
    (folder / 'host.json').write_text(json.dumps(record), encoding='utf-8')
    with pytest.raises(PermissionError, match='identity mismatch'):
        check()


def test_owner_network_names_are_deterministic_and_separate(server, monkeypatch):
    created = {}

    # Keep the fake intentionally small while preserving label validation.
    def controlled(*args, **kwargs):
        if args[:2] == ('network', 'inspect'):
            value = created.get(args[2])
            return SimpleNamespace(returncode=0 if value else 1,
                                   stdout=json.dumps([value]) if value else '', stderr='No such network' if not value else '')
        if args[:2] == ('network', 'create'):
            name = args[-1]
            workspace = next(value.split('=', 1)[1] for value in args if value.startswith('gxzs.workspace='))
            created[name] = {'Driver': 'bridge', 'Scope': 'local',
                             'Labels': {'workbench': server.PREFIX, 'gxzs.workspace': workspace}}
            return SimpleNamespace(returncode=0, stdout=name)
        raise AssertionError(args)

    monkeypatch.setattr(server, 'docker', controlled)
    first, second = str(uuid4()), str(uuid4())
    first_name = server.ensure_network(first)
    assert server.ensure_network(first) == first_name
    assert server.ensure_network(second) != first_name
    assert len(created) == 2


@pytest.mark.parametrize('operation,maintenance,tracked', [
    ('mcp_list', True, False), ('mcp_list', False, False), ('mcp_test', True, False),
    ('mcp_test', False, True), ('mcp_read', False, True), ('mcp_call', False, True),
    ('mcp_save', False, True), ('mcp_delete', False, True), ('mcp_toggle', False, True), ('mcp_reorder', False, True),
])
def test_mcp_maintenance_does_not_refresh_user_activity(server, monkeypatch, operation, maintenance, tracked):
    import mcp_runtime
    ensured, touched = Mock(), Mock()
    monkeypatch.setattr(server, 'ensure', ensured)
    monkeypatch.setattr(server, 'touch', touched)
    monkeypatch.setattr(server, 'schedule_mcp_refresh', Mock())
    monkeypatch.setattr(server, 'docker', lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='{"mcp":[]}'))
    monkeypatch.setattr(mcp_runtime, 'module_source', lambda *args: '')
    monkeypatch.setattr(mcp_runtime, 'invoke', lambda *args, **kwargs: {'ok': True})
    monkeypatch.setattr(mcp_runtime, 'invalidate', Mock())
    key = str(uuid4())
    # A caller cannot opt writes or tool execution into the catalog exception.
    server.operation(key, 'personal-mcp', {'operation': operation, 'maintenance': maintenance,
                                         'name': 'example', 'allow_existing_image': True})
    ensured.assert_called_once_with(key, track_activity=tracked, allow_existing_image=operation == 'mcp_list')
    assert bool(touched.call_count) is tracked


def test_stopped_host_is_not_woken_by_a_maintenance_catalog_read(server, monkeypatch):
    key = str(uuid4())
    folder = server.HOSTS.root / key
    folder.mkdir()
    (folder / 'host.json').write_text(json.dumps({'state': 'stopped'}))
    ensured = Mock()
    monkeypatch.setattr(server, 'ensure', ensured)
    with pytest.raises(server.ResourceUnavailable) as error:
        server.operation(key, 'personal-mcp', {'operation': 'mcp_list', 'maintenance': True})
    assert error.value.code == 'HOST_IDLE'
    ensured.assert_not_called()


def test_background_mcp_refresh_is_marked_as_maintenance(server, monkeypatch):
    calls = []
    class InlineThread:
        def __init__(self, target, **kwargs): self.target = target
        def start(self): self.target()
    monkeypatch.setattr(server.threading, 'Thread', InlineThread)
    monkeypatch.setattr(server, 'operation', lambda *args: calls.append(args))
    server.schedule_mcp_refresh(str(uuid4()), [{'id': 'example', 'enabled': True, 'status': 'unverified', 'version': 1}])
    assert calls[0][2]['maintenance'] is True
    assert calls[0][2]['operation'] == 'mcp_test'


@pytest.mark.parametrize('native_attachments', [False, True])
@pytest.mark.parametrize('global_skills', [False, True])
def test_sandbox_uses_one_cpu_three_gigabytes_and_owner_network(server, monkeypatch, native_attachments, global_skills):
    if global_skills:
        monkeypatch.setenv('GXZS_GLOBAL_SKILL_HOST_DIR', '/srv/global-skills')
    containers, calls = {}, []
    monkeypatch.setattr(server, 'ensure_network', lambda key: 'owner-network-' + key[:8])

    def docker(*args, **kwargs):
        calls.append(args)
        if args[0] == 'inspect':
            value = containers.get(args[1])
            return SimpleNamespace(returncode=0 if value else 1,
                                   stdout=json.dumps([value]) if value else '')
        if args[0] == 'create':
            name = args[args.index('--name') + 1]
            network = args[args.index('--network') + 1]
            containers[name] = {'Id': 'a' * 64, 'Config': {'Image': server.IMAGE},
                                'State': {'Running': False},
                                'NetworkSettings': {'Networks': {network: {}}}}
        if args[0] == 'start':
            containers[args[1]]['State']['Running'] = True
        return SimpleNamespace(returncode=0, stdout='')

    monkeypatch.setattr(server, 'docker', docker)
    key = str(uuid4())
    if native_attachments:
        folder = server.HOSTS.root / key
        folder.mkdir(parents=True)
        (folder / 'host.json').write_text(json.dumps({'workspace_id': key, 'owner_id': 't:1', 'home_volume': 'owner-home'}))
    assert server.ensure(key)['endpoint'].endswith(':5004')
    create = next(call for call in calls if call[0] == 'create')
    assert create[create.index('--cpus') + 1] == '1'
    assert create[create.index('--memory') + 1] == '3g'
    assert create[create.index('--memory-swap') + 1] == '3g'
    assert create[create.index('--pids-limit') + 1] == '1024'
    assert create[create.index('--network') + 1] == 'owner-network-' + key[:8]
    assert ('type=bind,source=/srv/global-skills,destination=/opt/workbench-global/skills,readonly' in create) == global_skills
    if native_attachments:
        assert create[create.index('--mount') + 1] == 'type=volume,source=owner-home,destination=/srv/dsh/attachments,volume-subpath=attachments,readonly'
        assert 'gxzs.attachment-home=owner-home' in create
        assert 'owner-home:/srv/dsh' not in create
        assert any(call[0] == 'run' and 'owner-home:/srv/dsh' in call for call in calls)


@pytest.mark.parametrize('changed', ['network', 'attachments', 'cgroup', 'global_skills'])
@pytest.mark.parametrize('allow_existing_image', [False, True])
def test_running_sandbox_on_old_network_returns_predictable_retry(server, monkeypatch, changed, allow_existing_image):
    key = str(uuid4())
    name, _ = server.identity(key)
    existing = {'Id': 'b' * 64, 'Config': {'Image': 'previous-image' if allow_existing_image else server.IMAGE}, 'State': {'Running': True},
                'NetworkSettings': {'Networks': {('shared-network' if changed == 'network' else 'owner-network'): {}}}}
    if changed == 'attachments':
        folder = server.HOSTS.root / key
        folder.mkdir(parents=True)
        (folder / 'host.json').write_text(json.dumps({'workspace_id': key, 'owner_id': 't:1', 'home_volume': 'owner-home'}))
    if changed == 'cgroup':
        existing['HostConfig'] = {'CgroupParent': 'other-owner'}
    if changed == 'global_skills':
        monkeypatch.setenv('GXZS_GLOBAL_SKILL_HOST_DIR', '/srv/global-skills')
    monkeypatch.setattr(server, 'ensure_network', lambda _: 'owner-network')
    monkeypatch.setattr(server, 'docker', lambda *args, **kwargs: SimpleNamespace(
        returncode=0, stdout=json.dumps([existing]) if args[:2] == ('inspect', name) else ''))
    with pytest.raises(server.SandboxUpdatePending):
        server.ensure(key, allow_existing_image=allow_existing_image)


@pytest.mark.parametrize('allow_existing_image', [False, True])
def test_running_previous_image_is_reused_only_for_catalog_reads(server, monkeypatch, allow_existing_image):
    key = str(uuid4())
    name, _ = server.identity(key)
    folder = server.HOSTS.root / key
    folder.mkdir()
    (folder / 'host.json').write_text(json.dumps({
        'workspace_id': key, 'owner_id': 't:1', 'home_volume': 'owner-home', 'state': 'ready',
    }))
    existing = {'Id': 'b' * 64, 'Config': {'Image': 'previous-image', 'Labels': {'gxzs.attachment-home': 'owner-home'}},
                'State': {'Running': True}, 'HostConfig': {'PidsLimit': 1024},
                'NetworkSettings': {'Networks': {'owner-network': {}}}}
    monkeypatch.setattr(server, 'ensure_network', lambda _: 'owner-network')
    docker = Mock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps([existing])))
    monkeypatch.setattr(server, 'docker', docker)
    touched = Mock()
    monkeypatch.setattr(server, 'touch', touched)
    if allow_existing_image:
        assert server.ensure(key, track_activity=False, allow_existing_image=True)['endpoint'].endswith(':5004')
    else:
        with pytest.raises(server.SandboxUpdatePending):
            server.ensure(key, track_activity=False)
    docker.assert_called_once_with('inspect', name, check=False)
    touched.assert_not_called()


def test_catalog_exception_does_not_restart_a_stopped_previous_image(server, monkeypatch):
    key = str(uuid4())
    name, _ = server.identity(key)
    existing = {'Id': 'b' * 64, 'Config': {'Image': 'previous-image'}, 'State': {'Running': False},
                'HostConfig': {'PidsLimit': 1024}, 'NetworkSettings': {'Networks': {'owner-network': {}}}}
    monkeypatch.setattr(server, 'ensure_network', lambda _: 'owner-network')
    class ReplacementReached(Exception):
        pass
    def docker(*args, **kwargs):
        if args[0] == 'rename':
            assert args == ('rename', name, name + '-previous-' + existing['Id'][:12])
            raise ReplacementReached()
        assert args == ('inspect', name)
        return SimpleNamespace(returncode=0, stdout=json.dumps([existing]))
    monkeypatch.setattr(server, 'docker', docker)
    with pytest.raises(ReplacementReached):
        server.ensure(key, track_activity=False, allow_existing_image=True)


def test_mcp_catalog_reads_previous_image_as_the_owner_user(server, monkeypatch):
    import mcp_runtime
    key = str(uuid4())
    name, _ = server.identity(key)
    existing = {'Id': 'b' * 64, 'Config': {'Image': 'previous-image'}, 'State': {'Running': True},
                'HostConfig': {'PidsLimit': 1024}, 'NetworkSettings': {'Networks': {'owner-network': {}}}}
    catalog = {'mcp': [{'id': 'example', 'name': 'Example', 'tools': []}]}
    calls = []
    def docker(*args, **kwargs):
        calls.append(args)
        if args == ('inspect', name):
            return SimpleNamespace(returncode=0, stdout=json.dumps([existing]))
        assert args[:5] == ('exec', '--user', '1000', '-i', name)
        assert json.loads(kwargs['stdin']) == {'operation': 'mcp_list', 'maintenance': True}
        return SimpleNamespace(returncode=0, stdout=json.dumps(catalog))
    monkeypatch.setattr(server, 'docker', docker)
    monkeypatch.setattr(server, 'ensure_network', lambda _: 'owner-network')
    monkeypatch.setattr(server, 'schedule_mcp_refresh', Mock())
    monkeypatch.setattr(mcp_runtime, 'module_source', lambda *args: '')
    assert server.operation(key, 'personal-mcp', {'operation': 'mcp_list', 'maintenance': True}) == catalog
    assert len(calls) == 2


@pytest.mark.parametrize('running,previous,desired,blocked', [
    (True, 256, 1024, False), (False, 1024, 512, False),
    (True, 1024, 512, True), (True, 0, 1024, True),
])
@pytest.mark.parametrize('allow_existing_image', [False, True])
def test_reconciles_thread_limit_without_restarting_running_tasks(server, monkeypatch, running, previous, desired, blocked, allow_existing_image):
    key = str(uuid4())
    name, _ = server.identity(key)
    existing = {'Id': 'b' * 64, 'Config': {'Image': 'previous-image' if allow_existing_image and running else server.IMAGE}, 'State': {'Running': running},
                'HostConfig': {'PidsLimit': previous}, 'NetworkSettings': {'Networks': {'owner-network': {}}}}
    calls = []
    monkeypatch.setenv('WORKBENCH_SANDBOX_PIDS_LIMIT', str(desired))
    monkeypatch.setattr(server, 'ensure_network', lambda _: 'owner-network')
    def docker(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout=json.dumps([existing]) if args[:2] == ('inspect', name) else '')
    monkeypatch.setattr(server, 'docker', docker)
    if blocked:
        with pytest.raises(server.SandboxUpdatePending):
            server.ensure(key, allow_existing_image=allow_existing_image)
        assert not any(call[0] == 'update' for call in calls)
    else:
        server.ensure(key, allow_existing_image=allow_existing_image)
        assert ('update', '--pids-limit', str(desired), name) in calls
        assert not any(call[0] in ('create', 'rename', 'stop', 'restart') for call in calls)


@pytest.mark.parametrize('value', ['0', '-1', 'not-a-number'])
def test_invalid_thread_limit_rejected_before_provisioning(server, monkeypatch, value):
    monkeypatch.setenv('WORKBENCH_SANDBOX_PIDS_LIMIT', value)
    docker = Mock()
    monkeypatch.setattr(server, 'docker', docker)
    with pytest.raises(ValueError):
        server.ensure(str(uuid4()))
    docker.assert_not_called()


def test_healthy_sandbox_ensure_does_not_spawn_initialization_helpers(server, monkeypatch):
    key = str(uuid4())
    name, _ = server.identity(key)
    info = {'Id':'a' * 64,'Config':{'Image':server.IMAGE},'State':{'Running':True},
            'HostConfig':{'PidsLimit':1024},'NetworkSettings':{'Networks':{'owner-network':{}}}}
    calls = []
    monkeypatch.setattr(server,'ensure_network',lambda _: 'owner-network')
    def docker(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0,stdout=json.dumps([info]))
    monkeypatch.setattr(server,'docker',docker)
    server.ensure(key)
    assert calls == [('inspect',name)]


def test_temporary_initializers_share_the_owner_resource_cap(server, monkeypatch):
    key = str(uuid4())
    monkeypatch.setenv('GXZS_OWNER_CGROUP_PREFIX','gxzs-workbench')
    monkeypatch.setattr(server,'ensure_network',lambda _: 'owner-network')
    calls = []
    def docker(*args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=1 if args[0] == 'inspect' else 0,stdout='')
    monkeypatch.setattr(server,'docker',docker)
    server.ensure(key)
    for call in calls:
        if call[0] in ('create','run'):
            assert call[call.index('--cgroup-parent') + 1] == server.owner_cgroup(key)
            assert '--memory' in call and '--cpus' in call and '--pids-limit' in call


@pytest.mark.parametrize('volume', ['/srv/private', '../other-home', 'home,volume-subpath=../', '', None])
def test_attachment_volume_rejects_paths_and_mount_options(server, monkeypatch, volume):
    key = str(uuid4())
    folder = server.HOSTS.root / key
    folder.mkdir(parents=True)
    (folder / 'host.json').write_text(json.dumps({'workspace_id': key, 'owner_id': 't:1', 'home_volume': volume}))
    monkeypatch.setattr(server, 'ensure_network', lambda _: 'owner-network')
    docker = Mock()
    monkeypatch.setattr(server, 'docker', docker)
    with pytest.raises(ValueError, match='Invalid owner attachment volume'):
        server.ensure(key)
    docker.assert_not_called()


def test_health_checks_workers_database_and_docker(server, monkeypatch):
    monkeypatch.setattr(server, 'docker', lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='27.5.1'))
    server.tick('reaper')
    server.tick('hosts')

    def request():
        handler = object.__new__(server.Handler)
        handler.path = '/healthz'
        handler.wfile = BytesIO()
        handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
        handler.do_GET()
        return handler

    assert request().send_response.call_args.args[0] == 200
    server.HEALTH['hosts'] = 0
    assert request().send_response.call_args.args[0] == 503


def test_legacy_unknown_installer_receipt_is_retained_for_reconciliation(server, monkeypatch):
    record = server.STATE / ('op-' + 'a' * 64)
    server.save_operation(record, {'status': 'installing', 'deadline': 1})
    calls = []
    monkeypatch.setattr(server, 'docker', lambda *args, **kwargs: (calls.append(args), SimpleNamespace(returncode=0, stdout=''))[1])
    server.reap_operations(now=2)
    assert calls == []
    assert json.loads(record.read_text())['status'] == 'unknown'
    os.utime(record, (1, 1))
    monkeypatch.setattr(server, 'OPERATION_RETENTION', 1)
    server.reap_operations(now=3)
    assert record.exists()


def test_environment_install_releases_owner_lock_but_keeps_a_durable_single_installer_gate(server, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    key = str(uuid4())
    monkeypatch.setattr(server, 'ensure', lambda key: None)
    def docker(*args, **kwargs):
        if args[0] == 'run':
            def control():
                with server.lock(key):
                    return True
            with ThreadPoolExecutor(max_workers=1) as pool:
                assert pool.submit(control).result(timeout=1)
                with pytest.raises(server.ResourceUnavailable) as error:
                    pool.submit(server.operation, key, 'environment', {'request_id': 'second'}).result(timeout=1)
                assert error.value.code == 'ENVIRONMENT_UPDATE_PENDING'
            return SimpleNamespace(returncode=0, stdout='{"status":"ready","version":"v1"}')
        raise AssertionError(args)
    monkeypatch.setattr(server, 'docker', docker)
    assert server.operation(key, 'environment', {'request_id': 'first'})['status'] == 'ready'
    assert server.operation(key, 'environment', {'request_id': 'first'})['status'] == 'ready'


@pytest.mark.parametrize('applied', [True, False])
def test_expired_installer_checks_the_committed_environment_after_confirmed_stop(server, monkeypatch, applied):
    key = str(uuid4())
    record, installer = server.operation_file(key, 'request-1')
    server.save_operation(record, {'status': 'installing', 'deadline': 1, 'workspace_id': key, 'request_id': 'request-1'})
    running = True
    def docker(*args, **kwargs):
        nonlocal running
        if args[0] == 'inspect':
            return SimpleNamespace(returncode=0, stdout=json.dumps([{'State': {'Running': running}}]))
        if args[0] == 'stop':
            assert args[-1] == installer
            running = False
            return SimpleNamespace(returncode=0, stdout='')
        if args[0] == 'exec':
            assert not running
            return SimpleNamespace(returncode=0, stdout=json.dumps({'request_id': 'request-1' if applied else 'previous'}))
        raise AssertionError(args)
    monkeypatch.setattr(server, 'docker', docker)
    output = server.environment_status(key, 'request-1', now=2)
    assert output['status'] == ('ready' if applied else 'failed')
    assert '保留' not in output['message']


@pytest.mark.parametrize('failure', ['inspect', 'stop', 'current'])
def test_environment_unknown_outcomes_keep_the_gate_and_receipt(server, monkeypatch, failure):
    import subprocess
    key = str(uuid4())
    record, _ = server.operation_file(key, 'request-1')
    server.save_operation(record, {'status': 'installing', 'deadline': 1, 'workspace_id': key, 'request_id': 'request-1'})
    calls = []
    def docker(*args, **kwargs):
        calls.append(args[0])
        if args[0] == 'inspect':
            if failure == 'inspect':
                return SimpleNamespace(returncode=1, stdout='', stderr='daemon disconnected')
            return SimpleNamespace(returncode=0, stdout=json.dumps([{'State': {'Running': failure == 'stop'}}]))
        if args[0] == 'stop':
            raise subprocess.TimeoutExpired('docker stop', 15)
        return SimpleNamespace(returncode=1, stdout='')
    monkeypatch.setattr(server, 'docker', docker)
    assert server.environment_status(key, 'request-1', now=2)['status'] == 'unknown'
    server.reap_operations(now=server.OPERATION_RETENTION + 10)
    assert record.exists() and json.loads(record.read_text())['status'] == 'unknown'
    if failure != 'current':
        assert 'exec' not in calls


@pytest.mark.parametrize('visibility', ['absent', 'created'])
def test_late_installer_start_cannot_be_mistaken_for_a_failed_completed_request(server, monkeypatch, visibility):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    key = str(uuid4())
    arrived, release = Event(), Event()
    monkeypatch.setattr(server, 'ensure', lambda key: None)
    launched = []
    def docker(*args, **kwargs):
        if args[0] == 'run':
            launched.append(json.loads(kwargs['stdin'])['request_id'])
            arrived.set()
            assert release.wait(5)
            return SimpleNamespace(returncode=0, stdout='{"status":"ready","version":"v1"}')
        if args[0] == 'inspect':
            return (SimpleNamespace(returncode=1, stdout='', stderr='No such container') if visibility == 'absent'
                    else SimpleNamespace(returncode=0, stdout='[{"State":{"Running":false,"Status":"created"}}]'))
        if args[0] == 'exec':
            return SimpleNamespace(returncode=0, stdout='{}')
        raise AssertionError(args)
    monkeypatch.setattr(server, 'docker', docker)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(server.operation, key, 'environment', {'request_id': 'late'})
        try:
            assert arrived.wait(2)
            record, _ = server.operation_file(key, 'late')
            deadline = json.loads(record.read_text())['deadline']
            assert server.environment_status(key, 'late', now=deadline + 1)['status'] == 'unknown'
            with pytest.raises(server.ResourceUnavailable) as error:
                server.operation(key, 'environment', {'request_id': 'next'})
            assert error.value.code == 'ENVIRONMENT_UPDATE_PENDING'
        finally:
            release.set()
            assert first.result(timeout=2)['status'] == 'ready'
    assert launched == ['late']


@pytest.mark.parametrize('reason', ['capacity', 'thread', 'process'])
def test_http_resource_failure_returns_correlated_json_without_leaking_capacity(server, monkeypatch, reason):
    instance = object.__new__(server.BoundedHTTPServer)
    instance.capacity = server.threading.BoundedSemaphore(1)
    instance.shutdown_request = Mock()
    request = Mock()
    if reason == 'capacity':
        instance.capacity.acquire()
    else:
        failure = RuntimeError('cannot start thread') if reason == 'thread' else OSError(11, 'Resource temporarily unavailable')
        monkeypatch.setattr(server.ThreadingHTTPServer, 'process_request', Mock(side_effect=failure))
    instance.process_request(request, ('127.0.0.1', 1))
    packet = request.sendall.call_args.args[0]
    headers, body = packet.split(b'\r\n\r\n', 1)
    value = json.loads(body)
    assert headers.startswith(b'HTTP/1.1 503')
    assert value['code'] == ('MANAGER_BUSY' if reason == 'capacity' else 'RESOURCE_BUSY')
    assert value['retry_after'] == 1 and len(value['request_id']) == 12
    assert not instance.capacity.acquire(blocking=False) if reason == 'capacity' else instance.capacity.acquire(blocking=False)
    instance.shutdown_request.assert_called_once_with(request)


def post_handler(server, body, declared_size, **headers):
    handler = object.__new__(server.Handler)
    handler.path = '/sandboxes/' + str(uuid4()) + '/schedule'
    handler.headers = {'Authorization': 'Bearer ' + server.TOKEN,
                       'Content-Length': str(declared_size), **headers}
    handler.rfile, handler.wfile = BytesIO(body), BytesIO()
    handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
    return handler


@pytest.mark.parametrize('body', [b'', b'{"action":"acq'])
def test_truncated_body_cannot_start_a_manager_operation(server, monkeypatch, body):
    operation = Mock(return_value={'ok': True})
    monkeypatch.setattr(server, 'operation', operation)
    handler = post_handler(server, body, len(body) + 5)
    handler.do_POST()
    operation.assert_not_called()
    assert handler.send_response.call_args.args[0] == 400
    value = json.loads(handler.wfile.getvalue())
    assert 'Incomplete request body' in value['error']
    assert len(value['request_id']) == 12
    assert server.REQUEST_CONTEXT.owner is None


def test_chunked_body_is_rejected_before_manager_admission(server, monkeypatch):
    operation = Mock(return_value={'ok': True})
    monkeypatch.setattr(server, 'operation', operation)
    handler = post_handler(server, b'2\r\n{}\r\n0\r\n\r\n', 0, **{'Transfer-Encoding': 'chunked'})
    handler.do_POST()
    operation.assert_not_called()
    assert handler.send_response.call_args.args[0] == 400


@pytest.mark.parametrize('content_type', [
    'Application/Octet-Stream', 'application/octet-stream; charset=binary',
    'APPLICATION/OCTET-STREAM ; name=upload.bin',
])
def test_binary_upload_accepts_media_type_case_and_parameters(server, monkeypatch, content_type):
    body = b'{}\nx'
    received = []
    def upload(key, action, staged):
        staged.seek(0)
        received.append((action, staged.read()))
        return {'ok': True}
    monkeypatch.setattr(server, 'upload_operation', upload)
    handler = post_handler(server, body, len(body), **{'Content-Type': content_type})
    handler.path = handler.path.rsplit('/', 1)[0] + '/files'
    handler.do_POST()
    assert handler.send_response.call_args.args[0] == 200
    assert received == [('files', body)]


def test_complete_body_is_dispatched_once_and_unknown_operation_errors_still_log(server, monkeypatch, caplog):
    body = b'{"action":"acquire"}'
    operation = Mock(return_value={'ok': True})
    monkeypatch.setattr(server, 'operation', operation)
    handler = post_handler(server, body, len(body))
    handler.do_POST()
    assert operation.call_count == 1 and operation.call_args.args[2] == {'action': 'acquire'}
    assert handler.send_response.call_args.args[0] == 200
    operation.side_effect = RuntimeError('operation failed')
    failed = post_handler(server, body, len(body))
    failed.do_POST()
    assert failed.send_response.call_args.args[0] == 503
    assert any(record.levelname == 'ERROR' and 'Sandbox request failed' in record.message for record in caplog.records)


@pytest.mark.parametrize('failure', [BrokenPipeError('closed'), ConnectionResetError('closed')])
def test_downstream_socket_cancellation_preserves_status_without_error_stacks(server, monkeypatch, caplog, failure):
    operation = Mock(return_value={'ok': True})
    monkeypatch.setattr(server, 'operation', operation)
    body = b'{}'
    handler = post_handler(server, body, len(body))
    handler.wfile = Mock(write=Mock(side_effect=failure))
    handler.do_POST()
    assert operation.call_count == 1
    assert handler.send_response.call_args.args[0] == 200
    assert not any(record.levelname == 'ERROR' for record in caplog.records)


def test_unclassified_socket_write_failure_remains_visible(server):
    handler = object.__new__(server.Handler)
    handler.wfile = Mock(write=Mock(side_effect=OSError('unexpected socket failure')))
    handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
    with pytest.raises(OSError, match='unexpected socket failure'):
        handler.write_json(200, b'{}')


@pytest.mark.parametrize('framing', ['complete', 'truncated', 'chunked'])
def test_http_body_framing_is_enforced_before_dispatch_on_a_real_socket(server, monkeypatch, framing):
    import http.client
    import socket
    import threading

    operation = Mock(return_value={'ok': True})
    monkeypatch.setattr(server, 'operation', operation)
    listener = server.BoundedHTTPServer(('127.0.0.1', 0), server.Handler)
    worker = threading.Thread(target=listener.serve_forever, daemon=True)
    worker.start()
    body = b'{"action":"acquire"}'
    length = len(body) + (5 if framing == 'truncated' else 0)
    fields = 'Transfer-Encoding: chunked\r\n' if framing == 'chunked' else f'Content-Length: {length}\r\n'
    if framing == 'chunked':
        body = b'2\r\n{}\r\n0\r\n\r\n'
    packet = (f'POST /sandboxes/{uuid4()}/schedule HTTP/1.1\r\n'
              f'Host: localhost\r\nAuthorization: Bearer {server.TOKEN}\r\n'
              'Content-Type: application/json\r\nConnection: close\r\n' + fields + '\r\n').encode() + body
    try:
        with socket.create_connection(listener.server_address, timeout=3) as client:
            client.sendall(packet)
            client.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(client)
            response.begin()
            value = json.loads(response.read())
            assert response.status == (200 if framing == 'complete' else 400)
            assert value['ok'] is True if framing == 'complete' else len(value['request_id']) == 12
        assert operation.call_count == (1 if framing == 'complete' else 0)
    finally:
        listener.shutdown()
        listener.server_close()
        worker.join(timeout=3)


@pytest.mark.parametrize('failed', [False, True])
def test_json_response_explicitly_closes_http11_keepalive_connection(server, monkeypatch, failed):
    import http.client
    import socket
    import threading

    operation = Mock(side_effect=RuntimeError('operation failed')) if failed else Mock(return_value={'ok': True})
    monkeypatch.setattr(server, 'operation', operation)
    listener = server.BoundedHTTPServer(('127.0.0.1', 0), server.Handler)
    worker = threading.Thread(target=listener.serve_forever, daemon=True)
    worker.start()
    packet = (f'POST /sandboxes/{uuid4()}/schedule HTTP/1.1\r\n'
              f'Host: localhost\r\nAuthorization: Bearer {server.TOKEN}\r\n'
              'Content-Type: application/json\r\nConnection: keep-alive\r\n'
              'Content-Length: 2\r\n\r\n{}').encode()
    try:
        with socket.create_connection(listener.server_address, timeout=3) as client:
            client.sendall(packet)
            response = http.client.HTTPResponse(client)
            response.begin()
            value = json.loads(response.read())
            assert response.status == (503 if failed else 200)
            assert len(value['request_id']) == 12 if failed else value['ok'] is True
            # Java's HTTP client may pool HTTP/1.0 responses without this header.
            # A complete response must never invite replay onto a closed socket.
            assert response.getheader('Connection') == 'close'
            assert client.recv(1) == b''
        assert operation.call_count == 1
    finally:
        listener.shutdown()
        listener.server_close()
        worker.join(timeout=3)


def test_short_control_request_burst_drains_without_exceeding_worker_limit(server, monkeypatch):
    import concurrent.futures
    import http.client
    import threading
    import time
    from http.server import BaseHTTPRequestHandler

    monkeypatch.setenv('WORKBENCH_MANAGER_MAX_REQUESTS', '4')
    guard = threading.Lock()
    active = maximum = 0

    class ShortRequest(BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal active, maximum
            with guard:
                active += 1
                maximum = max(maximum, active)
            try:
                time.sleep(.02)
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'{}')
            finally:
                with guard:
                    active -= 1

        def log_message(self, *_):
            pass

    listener = server.BoundedHTTPServer(('127.0.0.1', 0), ShortRequest)
    worker = threading.Thread(target=listener.serve_forever, daemon=True)
    worker.start()
    barrier = threading.Barrier(48)

    def submit(_):
        connection = http.client.HTTPConnection(*listener.server_address, timeout=5)
        try:
            barrier.wait(timeout=5)
            connection.request('GET', '/')
            response = connection.getresponse()
            response.read()
            return response.status
        finally:
            connection.close()

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=48) as pool:
            assert list(pool.map(submit, range(48))) == [200] * 48
        assert 1 < maximum <= 4
        assert active == 0
        # Every completed worker returns its permit, including after the burst.
        for _ in range(4):
            assert listener.capacity.acquire(timeout=1)
        assert not listener.capacity.acquire(blocking=False)
    finally:
        listener.shutdown()
        listener.server_close()
        worker.join(timeout=3)


@pytest.mark.parametrize('body', [b'', b'{}', b'{"action":"acquire"}'])
def test_empty_or_partial_schedule_identity_never_enters_host_admission(server, monkeypatch, body):
    schedule = Mock(return_value={'ok': True})
    monkeypatch.setattr(server.HOSTS, 'schedule', schedule)
    handler = post_handler(server, body, len(body))
    handler.do_POST()
    schedule.assert_not_called()
    assert handler.send_response.call_args.args[0] == 400
    value = json.loads(handler.wfile.getvalue())
    assert 'missing host or task identity' in value['error']
    assert len(value['request_id']) == 12


def test_complete_schedule_identity_reaches_the_existing_host_validator(server, monkeypatch):
    schedule = Mock(return_value={'ok': True})
    monkeypatch.setattr(server.HOSTS, 'schedule', schedule)
    payload = {'owner_id': 'tenant:7', 'generation': 1, 'instance_id': 'host-1',
               'run_id': str(uuid4()), 'chat_id': str(uuid4()), 'action': 'acquire'}
    body = json.dumps(payload).encode()
    handler = post_handler(server, body, len(body))
    handler.do_POST()
    schedule.assert_called_once_with(handler.path.split('/')[2], payload)
    assert handler.send_response.call_args.args[0] == 200


def test_migrated_plan_uses_and_cleans_the_original_scratch_volume(server, monkeypatch):
    from contextlib import nullcontext
    import planning
    key, binding, execution = (str(uuid4()) for _ in range(3))
    folder = server.HOSTS.root / key
    folder.mkdir()
    stable = server.PREFIX + '-' + key
    (folder / 'host.json').write_text(json.dumps({'sandbox_name':'gxzs-sandbox-admin', 'sandbox_volume_prefix':stable}))
    ensure = Mock()
    monkeypatch.setattr(server, 'ensure', ensure)
    monkeypatch.setattr(server, 'stop_binding', Mock())
    docker = Mock(return_value=SimpleNamespace(returncode=0, stdout='{}'))
    monkeypatch.setattr(server, 'docker', docker)
    monkeypatch.setattr(planning, 'copy_global_resources', Mock())
    admission = SimpleNamespace(guard=lambda *_:nullcontext(), lock=lambda *_:nullcontext())
    def operate(*args, **kwargs):
        return SimpleNamespace(returncode=0, stdout='0' if args[0]=='wait' else '{}')
    docker.side_effect = operate
    planning.inspect_plan(key, {'binding_id':binding,'execution_id':execution,'script':'true','request_key':'test'},
        docker=docker,ensure=ensure,identity=server.identity,storage_identity=server.storage_identity,
        image='test',prefix=server.PREFIX,manager_python=['python'],admission=admission)
    scratch=stable+'-plan-'+binding
    assert any(call.args[:2]==('volume','create') and call.args[-1]==scratch for call in docker.call_args_list)
    assert any('--volumes-from' in call.args and 'gxzs-sandbox-admin:ro' in call.args for call in docker.call_args_list)
    server.operation(key,'clean-binding',{'binding_id':binding})
    assert any(call.args==('volume','rm',scratch) for call in docker.call_args_list)
