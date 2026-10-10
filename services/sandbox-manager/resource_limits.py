"""Host and sandbox containers share a deployment-provisioned owner slice."""
import os
import re
from uuid import UUID


def owner_cgroup(workspace):
    prefix = os.environ.get('GXZS_OWNER_CGROUP_PREFIX', '')
    if not prefix:
        return ''
    if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9-]*', prefix):
        raise ValueError('Invalid owner cgroup slice prefix')
    return prefix + '-' + UUID(workspace).hex + '.slice'


def cgroup_args(workspace):
    parent = owner_cgroup(workspace)
    return ['--cgroup-parent', parent] if parent else []
