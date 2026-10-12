import concurrent.futures
import ipaddress
import json
import multiprocessing
from pathlib import Path
import sys
import subprocess
import time
from types import SimpleNamespace
from uuid import uuid4

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))

from owner_networks import OwnerNetworks
from resource_limits import ResourceUnavailable


class Docker:
    def __init__(self):
        self.networks, self.creates = {}, []
        self.failed_inspect = None
        self.race = False

    def __call__(self, *args, **kwargs):
        if args[:2] == ('network', 'ls'):
            return SimpleNamespace(returncode=0, stdout='\n'.join(self.networks), stderr='')
        if args[:2] == ('network', 'inspect'):
            if self.failed_inspect:
                return SimpleNamespace(returncode=1, stdout='', stderr=self.failed_inspect)
            found = [self.networks.get(name) for name in args[2:]]
            return SimpleNamespace(returncode=0 if all(found) else 1,
                                   stdout=json.dumps(found) if all(found) else '', stderr='network missing not found')
        if args[:2] == ('network', 'create'):
            self.creates.append(args)
            key = next(value.split('=', 1)[1] for value in args if value.startswith('gxzs.workspace='))
            subnet = args[args.index('--subnet') + 1] if '--subnet' in args else '172.28.0.0/16'
            if self.race:
                self.race = False
                self.networks['other-service'] = self.info('other', subnet)
                return SimpleNamespace(returncode=1, stdout='', stderr='Pool overlaps with other one on this address space')
            self.networks[args[-1]] = self.info(key, subnet)
            return SimpleNamespace(returncode=0, stdout=args[-1], stderr='')
        raise AssertionError(args)

    @staticmethod
    def info(key, subnet):
        return {'Driver': 'bridge', 'Scope': 'local', 'Labels': {'workbench': 'owner', 'gxzs.workspace': key},
                'IPAM': {'Config': [{'Subnet': subnet}]}}


def allocator(tmp_path, docker, pool='10.249.0.0/16', prefix=27):
    return OwnerNetworks(tmp_path, 'owner-net', 'owner', docker, pool, prefix)


def test_concurrent_owners_and_duplicate_requests_get_distinct_small_bridges(tmp_path):
    docker = Docker()
    network = allocator(tmp_path, docker)
    owners = [str(uuid4()) for _ in range(20)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        names = list(pool.map(network.ensure, owners + owners))
    assert names[:20] == names[20:]
    assert len(docker.creates) == 20
    subnets = [ipaddress.ip_network(item['IPAM']['Config'][0]['Subnet']) for item in docker.networks.values()]
    assert len(set(subnets)) == 20
    assert all(value.prefixlen == 27 and value.subnet_of(network.pool) for value in subnets)
    assert all(not a.overlaps(b) for i, a in enumerate(subnets) for b in subnets[i + 1:])


def test_restart_reuses_legacy_network_without_inspecting_or_reallocating_the_pool(tmp_path):
    docker = Docker()
    first = allocator(tmp_path, docker)
    key = str(uuid4())
    name = first.name(key)
    docker.networks[name] = docker.info(key, '192.168.64.0/20')
    second = allocator(tmp_path, docker, '10.248.0.0/16')
    assert first.ensure(key) == second.ensure(key) == name
    assert docker.creates == []
    assert docker.networks[name]['IPAM']['Config'][0]['Subnet'] == '192.168.64.0/20'


def test_pool_overlap_and_exhaustion_do_not_delete_other_networks(tmp_path):
    docker = Docker()
    docker.networks['another-system'] = docker.info('unrelated', '10.249.0.0/16')
    with pytest.raises(ResourceUnavailable) as failure:
        allocator(tmp_path, docker).ensure(str(uuid4()))
    assert failure.value.code == 'NETWORK_POOL_EXHAUSTED'
    assert failure.value.retry_after == 30
    assert docker.creates == []
    assert set(docker.networks) == {'another-system'}


def test_external_creator_collision_is_reconciled_with_a_fresh_snapshot(tmp_path):
    docker = Docker()
    docker.race = True
    network = allocator(tmp_path, docker, '10.249.0.0/26')
    result = network.ensure(str(uuid4()))
    assert len(docker.creates) == 2
    own = ipaddress.ip_network(docker.networks[result]['IPAM']['Config'][0]['Subnet'])
    other = ipaddress.ip_network(docker.networks['other-service']['IPAM']['Config'][0]['Subnet'])
    assert not own.overlaps(other)


def test_daemon_failure_is_not_treated_as_a_missing_network(tmp_path):
    docker = Docker()
    docker.failed_inspect = 'Cannot connect to the Docker daemon'
    with pytest.raises(ResourceUnavailable) as failure:
        allocator(tmp_path, docker).ensure(str(uuid4()))
    assert failure.value.code == 'NETWORK_BUSY'
    assert docker.creates == []


@pytest.mark.parametrize('pool,prefix', [('8.8.0.0/16', 27), ('10.0.0.0/8', 27), ('10.249.0.1/16', 27),
                                       ('fd00::/64', 27), ('10.249.0.0/16', 29), ('10.249.0.0/28', 27)])
def test_invalid_pool_configuration_fails_before_docker(tmp_path, pool, prefix):
    docker = Docker()
    with pytest.raises(ValueError):
        allocator(tmp_path, docker, pool, prefix)
    assert docker.creates == []


@pytest.mark.parametrize('field,value', [('Driver', 'overlay'), ('Scope', 'swarm'),
                                      ('Labels', {'workbench': 'someone-else', 'gxzs.workspace': 'other'})])
def test_existing_network_ownership_and_driver_are_checked(tmp_path, field, value):
    docker = Docker()
    network = allocator(tmp_path, docker)
    key = str(uuid4())
    name = network.name(key)
    docker.networks[name] = docker.info(key, '10.249.0.0/27')
    docker.networks[name][field] = value
    with pytest.raises(ValueError):
        network.ensure(key)
    assert docker.creates == []


def test_allocation_lock_refuses_a_symlink(tmp_path):
    target = tmp_path / 'other-file'
    target.write_text('preserved')
    (tmp_path / 'network-allocation.lock').symlink_to(target)
    with pytest.raises(OSError):
        allocator(tmp_path, Docker()).ensure(str(uuid4()))
    assert target.read_text() == 'preserved'


@pytest.mark.parametrize('created', [False, True])
def test_timed_out_create_reconciles_docker_before_retry(tmp_path, created):
    docker = Docker()
    def response(*args, **kwargs):
        if args[:2] == ('network', 'create'):
            if created:
                docker(*args, **kwargs)
            raise subprocess.TimeoutExpired('docker', 90)
        return docker(*args, **kwargs)
    network = allocator(tmp_path, response)
    key = str(uuid4())
    if created:
        assert network.ensure(key) == network.name(key)
        assert len(docker.creates) == 1
    else:
        with pytest.raises(ResourceUnavailable) as failure:
            network.ensure(key)
        assert failure.value.code == 'NETWORK_BUSY'
        assert docker.networks == {}


def hold_allocation_lock(folder, pipe):
    with allocator(folder, Docker())._allocation_lock():
        pipe.send('locked')
        time.sleep(.3)


def test_distinct_manager_processes_share_the_allocation_lock(tmp_path):
    context = multiprocessing.get_context('fork')
    reader, writer = context.Pipe(duplex=False)
    process = context.Process(target=hold_allocation_lock, args=(tmp_path, writer))
    process.start()
    try:
        assert reader.poll(3) and reader.recv() == 'locked'
        started = time.monotonic()
        with allocator(tmp_path, Docker())._allocation_lock():
            assert time.monotonic() - started >= .15
        process.join(3)
        assert process.exitcode == 0
    finally:
        if process.is_alive():
            process.terminate()
            process.join(3)
        reader.close()
        writer.close()


def test_legacy_unconfigured_pool_reports_default_docker_exhaustion(tmp_path):
    docker = Docker()
    def response(*args, **kwargs):
        if args[:2] == ('network', 'create'):
            return SimpleNamespace(returncode=1, stdout='', stderr='all predefined address pools have been fully subnetted')
        return docker(*args, **kwargs)
    with pytest.raises(ResourceUnavailable) as failure:
        allocator(tmp_path, response, pool=None).ensure(str(uuid4()))
    assert failure.value.code == 'NETWORK_POOL_EXHAUSTED'
