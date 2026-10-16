import http.client
import json
from pathlib import Path
import sys
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import docker_inspect


@pytest.fixture
def daemon(monkeypatch, tmp_path):
    for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    connection = Mock()
    response = connection.getresponse.return_value
    response.status = 200
    response.read.return_value = b'{"Id":"container","State":{"Running":true}}'
    monkeypatch.setattr(docker_inspect, 'UnixConnection', Mock(return_value=connection))
    return connection


def test_live_inspection_preserves_cli_shape_without_caching(daemon):
    first = docker_inspect.inspect_local(('inspect', 'owner-host'), 5)
    assert first.returncode == 0
    assert json.loads(first.stdout)[0]['State']['Running'] is True
    daemon.request.assert_called_with('GET', '/containers/owner-host/json')
    daemon.getresponse.return_value.read.return_value = b'{"Id":"container","State":{"Running":false}}'
    second = docker_inspect.inspect_local(('inspect', 'owner-host'), 5)
    assert json.loads(second.stdout)[0]['State']['Running'] is False
    assert daemon.request.call_count == 2
    assert daemon.close.call_count == 2


@pytest.mark.parametrize('args', [('exec', 'owner-host'), ('inspect', '--format', '{{.Id}}', 'host'),
                                  ('inspect', 'first', 'second'), ('image', 'inspect', 'image'), ('stop', 'host')])
def test_other_operations_keep_cli_semantics(daemon, args):
    assert docker_inspect.inspect_local(args, 5) is None
    daemon.request.assert_not_called()


@pytest.mark.parametrize('key,value', [('DOCKER_HOST', 'tcp://daemon:2376'), ('DOCKER_CONTEXT', 'remote'),
                                      ('DOCKER_CONFIG', '/custom-config')])
def test_explicit_endpoints_keep_cli_semantics(daemon, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    assert docker_inspect.inspect_local(('inspect', 'owner-host'), 5) is None
    daemon.request.assert_not_called()


def test_implicit_docker_context_configuration_keeps_cli_semantics(daemon):
    config = Path.home() / '.docker' / 'config.json'
    config.parent.mkdir()
    config.write_text('{"currentContext":"remote"}')
    assert docker_inspect.inspect_local(('inspect', 'owner-host'), 5) is None
    daemon.request.assert_not_called()


def test_missing_container_falls_back_to_generic_inspect(daemon):
    daemon.getresponse.return_value.status = 404
    assert docker_inspect.inspect_local(('inspect', 'image-name'), 5) is None
    daemon.close.assert_called_once()


@pytest.mark.parametrize('error', [TimeoutError('secret'), OSError('secret'), http.client.HTTPException('secret')])
def test_transport_failure_is_not_hidden_by_cli_retry_and_does_not_leak(daemon, error):
    daemon.getresponse.side_effect = error
    result = docker_inspect.inspect_local(('inspect', 'owner-host'), 5)
    assert result.returncode == 1 and result.stdout == ''
    assert 'secret' not in result.stderr
    daemon.close.assert_called_once()


@pytest.mark.parametrize('body', [b'{', b'[]', b'{"Id":null}', b'x' * (8 * 1024 * 1024 + 1)],
                         ids=['malformed', 'array', 'invalid-id', 'oversized'])
def test_invalid_or_oversized_state_never_becomes_success(daemon, body):
    daemon.getresponse.return_value.read.return_value = body
    result = docker_inspect.inspect_local(('inspect', 'owner-host'), 5)
    assert result.returncode == 1 and result.stdout == ''
    daemon.close.assert_called_once()


def test_non_success_status_and_path_encoding(daemon):
    daemon.getresponse.return_value.status = 500
    result = docker_inspect.inspect_local(('inspect', 'host/../../secret?x=y'), 5)
    assert result.returncode == 1
    daemon.request.assert_called_once_with('GET', '/containers/host%2F..%2F..%2Fsecret%3Fx%3Dy/json')
    daemon.getresponse.return_value.read.assert_not_called()
