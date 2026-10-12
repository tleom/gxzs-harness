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
    assert create[create.index('--pids-limit') + 1] == '1024'
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


@pytest.mark.parametrize('running,previous,desired,blocked', [
    (True, 256, 1024, False), (False, 1024, 512, False),
    (True, 1024, 512, True), (True, 0, 1024, True),
])
def test_reconciles_thread_limit_without_restarting_running_tasks(server, monkeypatch, running, previous, desired, blocked):
    key = str(uuid4())
    name, _ = server.identity(key)
    existing = {'Id': 'b' * 64, 'Config': {'Image': server.IMAGE}, 'State': {'Running': running},
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
            server.ensure(key)
        assert not any(call[0] == 'update' for call in calls)
    else:
        server.ensure(key)
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
