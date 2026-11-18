import pytest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_names import account_names, host_name, volume_prefix


@pytest.mark.parametrize('owner_id', ['gxzs-7', 'gxzs-9223372036854775807'])
def test_account_is_readable_without_losing_leading_zeroes(owner_id):
    assert account_names(owner_id, '00066943') == {
        'account_name': '00066943', 'container_name': 'gxzs-host-00066943',
        'sandbox_name': 'gxzs-sandbox-00066943'}
    assert account_names('gxzs-1', 'admin')['container_name'] == 'gxzs-host-admin'


def test_removed_tenant_identity_is_rejected_and_fixture_names_are_isolated(monkeypatch):
    with pytest.raises(ValueError):
        account_names("000001:1", "admin")
    monkeypatch.setenv('GXZS_RUNTIME_PREFIX', 'gxzs-test')
    assert account_names('gxzs-1', 'admin')['container_name'] == 'gxzs-test-host-admin'


@pytest.mark.parametrize('account', ['../admin', 'a/b', 'a b', 'a\nadmin', '', 'a' * 31])
def test_rejects_invalid_names_before_any_docker_mutation(account):
    with pytest.raises(ValueError):
        account_names('gxzs-1', account)


def test_existing_bindings_and_volumes_keep_their_original_identity():
    assert account_names('gxzs-1', None) == {}
    assert host_name({'instance_id': 'legacy'}) == 'legacy'
    assert host_name({'instance_id': 'logical-g2', 'container_name': 'gxzs-host-admin'}) == 'gxzs-host-admin'
    assert volume_prefix({'sandbox_volume_prefix': 'legacy-volumes'}, 'gxzs-sandbox-admin') == 'legacy-volumes'


def test_dns_label_length_is_checked(monkeypatch):
    monkeypatch.setenv('GXZS_RUNTIME_PREFIX', 'x' * 20)
    assert len(account_names('gxzs-1', 'a' * 30)['container_name']) <= 63
