"""Docker is the allocation authority; existing owner bridges are never renumbered."""
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from uuid import UUID

from resource_limits import ResourceUnavailable


class OwnerNetworks:
    def __init__(self, state, network, prefix, docker, pool=None, subnet_prefix=27):
        self.state, self.network, self.prefix, self.docker = Path(state), network, prefix, docker
        self.guard = threading.Lock()
        self.pool = ipaddress.ip_network(pool, strict=True) if pool else None
        self.subnet_prefix = int(subnet_prefix)
        private = [ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
        if self.pool and (self.pool.version != 4 or self.pool.prefixlen < 16
                          or not any(self.pool.subnet_of(value) for value in private)
                          or not self.pool.prefixlen <= self.subnet_prefix <= 28):
            raise ValueError('Owner network pool must be private IPv4 /16 or smaller, with subnets no smaller than /28')

    def name(self, key):
        return self.network + '-' + hashlib.sha256(str(UUID(key)).encode()).hexdigest()[:16]

    def _existing(self, key, name):
        result = self.docker('network', 'inspect', name, check=False)
        if result.returncode:
            # A daemon/transport failure is not evidence that the network is missing.
            message = result.stderr.lower()
            if 'no such network' not in message and not re.search(r'network [^\n]+ not found', message):
                raise ResourceUnavailable('暂时无法确认工作区网络，请稍后重试', code='NETWORK_BUSY')
            return None
        info = json.loads(result.stdout)[0]
        labels = info.get('Labels') or {}
        if (info.get('Driver') != 'bridge' or info.get('Scope') != 'local'
                or labels.get('workbench') != self.prefix or labels.get('gxzs.workspace') != key):
            raise ValueError('Owner network identity mismatch')
        return info

    @contextmanager
    def _allocation_lock(self):
        deadline = time.monotonic() + 5
        if not self.guard.acquire(timeout=5):
            raise ResourceUnavailable('工作区网络正在分配，请稍后重试', code='NETWORK_BUSY')
        try:
            descriptor = os.open(self.state / 'network-allocation.lock',
                                 os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                while True:
                    try:
                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise ResourceUnavailable('工作区网络正在分配，请稍后重试', code='NETWORK_BUSY')
                        time.sleep(.05)
                yield
            finally:
                os.close(descriptor)
        finally:
            self.guard.release()

    def _occupied(self):
        identifiers = self.docker('network', 'ls', '-q').stdout.split()
        occupied = []
        for index in range(0, len(identifiers), 128):
            networks = json.loads(self.docker('network', 'inspect', *identifiers[index:index + 128]).stdout)
            for network in networks:
                for item in (network.get('IPAM', {}).get('Config') or []):
                    if item.get('Subnet'):
                        subnet = ipaddress.ip_network(item['Subnet'])
                        if subnet.version == 4:
                            occupied.append(subnet)
        return occupied

    def _create(self, key, name, subnet=None):
        arguments = ['network', 'create', '--driver', 'bridge', '--label', 'workbench=' + self.prefix,
                     '--label', 'gxzs.workspace=' + key]
        if subnet:
            arguments += ['--subnet', str(subnet), '--label', 'gxzs.network-allocation=pool-v1']
        try:
            result = self.docker(*arguments, name, check=False)
        except subprocess.TimeoutExpired as error:
            # A timed-out CLI may already have committed the network in Docker.
            if self._existing(key, name):
                return True
            raise ResourceUnavailable('工作区网络创建结果尚未确认，请稍后重试', code='NETWORK_BUSY') from error
        # Reconcile a duplicate create or a lost success response before doing more work.
        if self._existing(key, name):
            return True
        if result.returncode == 0:
            raise ResourceUnavailable('工作区网络创建结果尚未确认，请稍后重试', code='NETWORK_BUSY')
        message = result.stderr.lower()
        if subnet and 'overlap' in message:
            return False
        if 'address pools' in message and ('exhaust' in message or 'fully subnetted' in message):
            raise self._exhausted()
        raise ResourceUnavailable('工作区网络创建失败，请稍后重试；数据已保留', code='NETWORK_BUSY')

    @staticmethod
    def _exhausted():
        return ResourceUnavailable('工作区网络地址池已满，请联系管理员调整网络配置；数据已保留',
                                   code='NETWORK_POOL_EXHAUSTED', retry_after=30)

    def ensure(self, key):
        key = str(UUID(key))
        name = self.name(key)
        if self._existing(key, name):
            return name
        with self._allocation_lock():
            if self._existing(key, name):
                return name
            if not self.pool:
                self._create(key, name)
                return name
            count = 1 << (self.subnet_prefix - self.pool.prefixlen)
            size = 1 << (32 - self.subnet_prefix)
            start = int(hashlib.sha256(key.encode()).hexdigest(), 16) % count
            occupied = self._occupied()
            collisions = 0
            for offset in range(count):
                subnet = ipaddress.ip_network((int(self.pool.network_address) + ((start + offset) % count) * size,
                                              self.subnet_prefix))
                if any(subnet.overlaps(value) for value in occupied):
                    continue
                if self._create(key, name, subnet):
                    return name
                collisions += 1
                if collisions >= 8:
                    raise ResourceUnavailable('工作区网络分配遇到并发冲突，请稍后重试', code='NETWORK_BUSY')
                occupied = self._occupied()
                occupied.append(subnet)
            raise self._exhausted()
