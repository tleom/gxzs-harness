import json
from email.message import Message
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from owner_auth import OWNER_ACTIONS, authorize, owner_token, assertion_key


@pytest.fixture
def registered(tmp_path):
    directory = tmp_path / 'workspace'
    directory.mkdir()
    record = dict(owner_id='tenant:7', workspace_id='workspace', generation=2, instance_id='host-2', state='ready')
    (directory / 'host.json').write_text(json.dumps(record))
    headers = Message()
    headers['authorization'] = 'Bearer ' + owner_token('root-test-key', 'tenant:7', 'workspace', 2, 'host-2')
    headers['x-gxzs-owner'] = 'tenant:7'
    headers['x-gxzs-host-generation'] = '2'
    headers['x-gxzs-host-instance'] = 'host-2'
    return tmp_path, headers, record


def test_scope_and_root_access_matrix(registered):
    root, headers, _ = registered
    for action in OWNER_ACTIONS:
        assert authorize(headers, 'root-test-key', root, 'workspace', action) == 'owner'
    for action in ('ensure', 'ensure-host', 'replace-host', 'profile-upgrade', 'schedule', 'environment', 'global-resources', 'stop-binding', 'diagnostics'):
        with pytest.raises(PermissionError):
            authorize(headers, 'root-test-key', root, 'workspace', action)
        assert authorize({'Authorization': 'Bearer root-test-key'}, 'root-test-key', root, 'workspace', action) == 'root'
    with pytest.raises(PermissionError):
        authorize(headers, 'root-test-key', root, 'other-workspace', 'files')


@pytest.mark.parametrize('field,value', [('owner_id', 'tenant:8'), ('generation', 3), ('instance_id', 'host-3'), ('state', 'fencing'), ('state', 'stopped')])
def test_old_or_other_identity_is_revoked(registered, field, value):
    root, headers, record = registered
    record[field] = value
    (root / 'workspace' / 'host.json').write_text(json.dumps(record))
    with pytest.raises(PermissionError):
        authorize(headers, 'root-test-key', root, 'workspace', 'files')


def test_domains_and_generations_produce_distinct_credentials():
    root = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    manager = owner_token(root, 'tenant:7', 'workspace', 1, 'host-1')
    assert manager != owner_token(root, 'tenant:7', 'other', 1, 'host-1')
    assert manager != owner_token(root, 'tenant:7', 'workspace', 2, 'host-1')
    assert manager != root
    assert assertion_key(root, 'tenant:7', 1, 'host-1') != root
    assert assertion_key(root, 'tenant:7', 1, 'host-1') != assertion_key(root, 'tenant:8', 1, 'host-1')


def test_degraded_current_identity_keeps_owner_operations_without_coordinator_access(registered):
    root, headers, record = registered
    record['state'] = 'degraded'
    record['ready'] = False
    (root / 'workspace' / 'host.json').write_text(json.dumps(record))
    for action in OWNER_ACTIONS:
        assert authorize(headers, 'root-test-key', root, 'workspace', action) == 'owner'
    for action in ('ensure-host', 'replace-host', 'schedule', 'stop-binding'):
        with pytest.raises(PermissionError):
            authorize(headers, 'root-test-key', root, 'workspace', action)
    headers.replace_header('x-gxzs-host-generation', '1')
    with pytest.raises(PermissionError):
        authorize(headers, 'root-test-key', root, 'workspace', 'files')


def test_fixed_credential_contract_fixture():
    fixture = json.loads((Path(__file__).parent / 'fixtures' / 'owner-credentials-v1.json').read_text(encoding='utf-8'))
    identity = fixture['owner_id'], fixture['workspace_id'], fixture['generation'], fixture['instance_id']
    assert owner_token(fixture['root_manager_token'], *identity) == fixture['manager_token']
    assert assertion_key(fixture['root_assertion_key'], identity[0], identity[2], identity[3]) == fixture['assertion_key']
