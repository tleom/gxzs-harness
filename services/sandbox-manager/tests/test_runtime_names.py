import pytest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_names import account_names, host_name, volume_prefix


def test_account_is_readable_without_losing_leading_zeroes():
    assert account_names('000000:7', '00066943') == {
        'account_name': '00066943', 'container_name': 'gxzs-host-00066943',
        'sandbox_name': 'gxzs-sandbox-00066943'}
    assert account_names('000000:1', 'admin')['container_name'] == 'gxzs-host-admin'


def test_separate_tenants_and_fixture_namespaces_cannot_claim_the_same_name(monkeypatch):
    assert account_names('000001:1', 'admin')['container_name'] == 'gxzs-host-000001.admin'
    assert account_names('000001:1', 'admin')['container_name'] != account_names('000000:2', '000001-admin')['container_name']
    monkeypatch.setenv('GXZS_RUNTIME_PREFIX', 'gxzs-test')
    assert account_names('000000:1', 'admin')['container_name'] == 'gxzs-test-host-admin'


@pytest.mark.parametrize('account', ['../admin', 'a/b', 'a b', 'a\nadmin', '', 'a' * 31])
def test_rejects_invalid_names_before_any_docker_mutation(account):
    with pytest.raises(ValueError):
        account_names('000000:1', account)


def test_existing_bindings_and_volumes_keep_their_original_identity():
    assert account_names('000000:1', None) == {}
    assert host_name({'instance_id': 'legacy'}) == 'legacy'
    assert host_name({'instance_id': 'logical-g2', 'container_name': 'gxzs-host-admin'}) == 'gxzs-host-admin'
    assert volume_prefix({'sandbox_volume_prefix': 'legacy-volumes'}, 'gxzs-sandbox-admin') == 'legacy-volumes'


def test_dns_label_length_is_checked(monkeypatch):
    monkeypatch.setenv('GXZS_RUNTIME_PREFIX', 'x' * 20)
    with pytest.raises(ValueError, match='DNS'):
        account_names('t' * 20 + ':1', 'a' * 30)
