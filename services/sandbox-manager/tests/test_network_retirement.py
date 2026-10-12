import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def retirement(monkeypatch):
    path = Path(__file__).parents[3] / 'scripts/retire-test-networks.py'
    spec = importlib.util.spec_from_file_location('network_retirement', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, 'protected', lambda _: (set(), set(), 'production'))
    return module


def network(name):
    return {'Name': name, 'Id': 'a' * 64, 'Driver': 'bridge', 'Scope': 'local', 'Containers': {}, 'Labels': {},
            'IPAM': {'Config': [{'Subnet': '172.30.0.0/16'}]}}


def configure(module, info, containers):
    def docker(*args, **kwargs):
        if args[:2] == ('network', 'inspect'):
            return SimpleNamespace(stdout=json.dumps([info]))
        if args[:2] == ('ps', '-aq'):
            return SimpleNamespace(stdout='container' if containers else '')
        if args[0] == 'inspect':
            return SimpleNamespace(stdout=json.dumps(containers))
        raise AssertionError(args)
    module.docker = docker


def test_a_stopped_container_reference_blocks_retirement(retirement):
    name = 'wb-integration-fault-qa-20260916'
    configure(retirement, network(name), [{'State': {'Running': False},
              'NetworkSettings': {'Networks': {name: {'NetworkID': 'a' * 64}}}}])
    with pytest.raises(ValueError, match='stopped'):
        retirement.candidate(name, 'manager')


def test_unreferenced_legacy_test_network_is_eligible(retirement):
    name = 'wb-recovery-fault-qa-20260915'
    configure(retirement, network(name), [])
    assert retirement.candidate(name, 'manager')['Name'] == name


def test_registered_owner_and_replaced_network_id_are_protected(retirement, monkeypatch):
    name = 'wb-postmerge-fault-final-20260916'
    info = network(name)
    configure(retirement, info, [])
    with pytest.raises(ValueError, match='identity changed'):
        retirement.candidate(name, 'manager', 'b' * 64)
    monkeypatch.setattr(retirement, 'protected', lambda _: (set(), {name}, 'production'))
    with pytest.raises(ValueError, match='registered'):
        retirement.candidate(name, 'manager')


def test_production_network_names_cannot_be_selected(retirement):
    with pytest.raises(ValueError, match='legacy'):
        retirement.candidate('gxzs-ai-sandboxes-user', 'manager')
