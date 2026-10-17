"""Deployment-owned global skills shared read-only by Host and Sandbox."""
import os
from pathlib import PurePosixPath

TARGET = '/opt/workbench-global/skills'


def source_path():
    value = os.environ.get('GXZS_GLOBAL_SKILL_HOST_DIR', '')
    if not value:
        return None
    path = PurePosixPath(value)
    if (not path.is_absolute() or str(path) == '/' or '..' in path.parts
            or str(path) != value or any(char in value for char in ',:\r\n\0')):
        raise ValueError('Global skill directory must be a normalized absolute Docker-host path')
    configured = os.environ.get('GXZS_GLOBAL_SKILL_DIR', TARGET)
    if configured != TARGET:
        raise ValueError('Mounted global skill directory must match the native skill root')
    return value


def mount_arguments():
    source = source_path()
    # --mount fails if the source is missing; -v would silently create an empty tree.
    return ['--mount', f'type=bind,source={source},destination={TARGET},readonly'] if source else []


def matches_mount(container):
    source = source_path()
    mounts = [m for m in container.get('Mounts', []) if m.get('Destination') == TARGET]
    if source is None:
        return not mounts
    return (len(mounts) == 1 and mounts[0].get('Type') == 'bind'
            and mounts[0].get('Source') == source and mounts[0].get('RW') is False)


def native_root():
    return TARGET if source_path() else os.environ.get('GXZS_GLOBAL_SKILL_DIR')
