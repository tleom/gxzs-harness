"""Host and sandbox containers share a deployment-provisioned owner slice."""
import os
import re
import shutil
from uuid import UUID
from pathlib import Path


class ResourceUnavailable(RuntimeError):
    def __init__(self, message, code='RESOURCE_BUSY', retry_after=2):
        super().__init__(message)
        self.code, self.retry_after = code, retry_after


def storage_status(path):
    minimum = int(os.environ.get('GXZS_STORAGE_MIN_FREE_BYTES', '268435456'))
    minimum_inodes = int(os.environ.get('GXZS_STORAGE_MIN_FREE_INODES', '1024'))
    if minimum < 0 or minimum_inodes < 0:
        raise ValueError('Storage watermarks must be non-negative integers')
    result = {'min_free_bytes': minimum, 'min_free_inodes': minimum_inodes}
    try:
        result['free_bytes'] = shutil.disk_usage(path).free
        result['blocked'] = result['free_bytes'] < minimum
        if hasattr(os, 'statvfs'):
            info = os.statvfs(path)
            if info.f_files > 0:
                result['free_inodes'] = info.f_favail
                result['blocked'] = result['blocked'] or info.f_favail < minimum_inodes
    except OSError:
        result.update(blocked=True, status='unknown')
    return result


def assert_storage_writable(path):
    if storage_status(path)['blocked']:
        raise ResourceUnavailable('管理服务存储空间不足或暂不可用，请整理后重试', 'STORAGE_PRESSURE', 5)


def pid_pressure(info):
    """Read current cgroup v2 pressure; cumulative event counts are not proof."""
    root = Path(os.environ.get('WORKBENCH_HOST_CGROUP_ROOT', '/host-cgroup'))
    parent = info.get('HostConfig', {}).get('CgroupParent', '')
    container = info.get('Id', '')
    if not re.fullmatch(r'[a-zA-Z0-9-]+\.slice', parent) or not re.fullmatch('[a-f0-9]{64}', container):
        return False
    parts = parent[:-6].split('-')
    path = root.joinpath(*['-'.join(parts[:index]) + '.slice' for index in range(1, len(parts) + 1)],
                         'docker-' + container + '.scope')
    for location in (path, *path.parents):
        if location == root or root not in location.parents:
            break
        try:
            maximum = (location / 'pids.max').read_text().strip()
            current = int((location / 'pids.current').read_text())
            if maximum != 'max' and current >= int(maximum):
                return True
        except (OSError, ValueError):
            continue
    return False


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
