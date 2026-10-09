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
    module.ADMISSION.close()


def test_owner_network_names_are_deterministic_and_separate(server, monkeypatch):
    created = {}

    # Keep the fake intentionally small while preserving label validation.
    def controlled(*args, **kwargs):
        if args[:2] == ('network', 'inspect'):
            value = created.get(args[2])
            return SimpleNamespace(returncode=0 if value else 1,
                                   stdout=json.dumps([value]) if value else '')
        if args[:2] == ('network', 'create'):
            name = args[-1]
            workspace = next(value.split('=', 1)[1] for value in args if value.startswith('gxzs.workspace='))
            created[name] = {'Labels': {'workbench': server.PREFIX, 'gxzs.workspace': workspace}}
            return SimpleNamespace(returncode=0, stdout=name)
        raise AssertionError(args)

    monkeypatch.setattr(server, 'docker', controlled)
    first, second = str(uuid4()), str(uuid4())
    first_name = server.ensure_network(first)
    assert server.ensure_network(first) == first_name
    assert server.ensure_network(second) != first_name
    assert len(created) == 2


@pytest.mark.parametrize('native_attachments', [False, True])
def test_sandbox_uses_one_cpu_three_gigabytes_and_owner_network(server, monkeypatch, native_attachments):
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
    assert create[create.index('--network') + 1] == 'owner-network-' + key[:8]
    if native_attachments:
        assert create[create.index('--mount') + 1] == 'type=volume,source=owner-home,destination=/srv/dsh/attachments,volume-subpath=attachments,readonly'
        assert 'gxzs.attachment-home=owner-home' in create
        assert 'owner-home:/srv/dsh' not in create
        assert any(call[0] == 'run' and 'owner-home:/srv/dsh' in call for call in calls)


@pytest.mark.parametrize('changed', ['network', 'attachments'])
def test_running_sandbox_on_old_network_returns_predictable_retry(server, monkeypatch, changed):
    key = str(uuid4())
    name, _ = server.identity(key)
    existing = {'Id': 'b' * 64, 'Config': {'Image': server.IMAGE}, 'State': {'Running': True},
                'NetworkSettings': {'Networks': {('shared-network' if changed == 'network' else 'owner-network'): {}}}}
    if changed == 'attachments':
        folder = server.HOSTS.root / key
        folder.mkdir(parents=True)
        (folder / 'host.json').write_text(json.dumps({'workspace_id': key, 'owner_id': 't:1', 'home_volume': 'owner-home'}))
    monkeypatch.setattr(server, 'ensure_network', lambda _: 'owner-network')
    monkeypatch.setattr(server, 'docker', lambda *args, **kwargs: SimpleNamespace(
        returncode=0, stdout=json.dumps([existing]) if args[:2] == ('inspect', name) else ''))
    with pytest.raises(server.SandboxUpdatePending):
        server.ensure(key)


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


def test_expired_installer_is_killed_and_record_is_bounded(server, monkeypatch):
    record = server.STATE / ('op-' + 'a' * 64)
    server.save_operation(record, {'status': 'installing', 'deadline': 1})
    calls = []
    monkeypatch.setattr(server, 'docker', lambda *args, **kwargs: (calls.append(args), SimpleNamespace(returncode=0, stdout=''))[1])
    server.reap_operations(now=2)
    assert calls == [('rm', '-f', server.PREFIX + '-install-' + 'a' * 24)]
    assert json.loads(record.read_text())['status'] == 'failed'
    os.utime(record, (1, 1))
    monkeypatch.setattr(server, 'OPERATION_RETENTION', 1)
    server.reap_operations(now=3)
    assert not record.exists()
