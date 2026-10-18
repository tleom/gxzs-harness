import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resource_limits import cgroup_args, owner_cgroup, pid_pressure


def test_storage_watermark_protects_bytes_and_inodes_and_reports_unknown(tmp_path, monkeypatch):
    import resource_limits
    from types import SimpleNamespace
    monkeypatch.setenv('GXZS_STORAGE_MIN_FREE_BYTES', '256')
    monkeypatch.setenv('GXZS_STORAGE_MIN_FREE_INODES', '10')
    monkeypatch.setattr(resource_limits.shutil, 'disk_usage', lambda path: SimpleNamespace(free=300))
    monkeypatch.setattr(resource_limits.os, 'statvfs', lambda path: SimpleNamespace(f_files=100, f_favail=9), raising=False)
    with pytest.raises(resource_limits.ResourceUnavailable) as error:
        resource_limits.assert_storage_writable(tmp_path)
    assert error.value.code == 'STORAGE_PRESSURE'
    monkeypatch.setattr(resource_limits.os, 'statvfs', lambda path: SimpleNamespace(f_files=100, f_favail=20))
    resource_limits.assert_storage_writable(tmp_path)
    monkeypatch.setattr(resource_limits.shutil, 'disk_usage', lambda path: SimpleNamespace(free=255))
    assert resource_limits.storage_status(tmp_path)['blocked']
    def unavailable(path):
        raise OSError('unavailable')
    monkeypatch.setattr(resource_limits.shutil, 'disk_usage', unavailable)
    assert resource_limits.storage_status(tmp_path)['status'] == 'unknown'


def test_owner_slice_is_shared_and_validated(monkeypatch):
    monkeypatch.setenv('GXZS_OWNER_CGROUP_PREFIX', 'gxzs-workbench')
    workspace = 'c6a1f026-7b8d-415f-bdd8-c48caa6589b9'
    parent = 'gxzs-workbench-c6a1f0267b8d415fbdd8c48caa6589b9.slice'
    assert owner_cgroup(workspace) == parent
    assert cgroup_args(workspace) == ['--cgroup-parent', parent]
    with pytest.raises(ValueError):
        owner_cgroup('../other')
    monkeypatch.setenv('GXZS_OWNER_CGROUP_PREFIX', '../system')
    with pytest.raises(ValueError):
        owner_cgroup(workspace)


def test_optional_on_deployments_without_slices(monkeypatch):
    monkeypatch.delenv('GXZS_OWNER_CGROUP_PREFIX', raising=False)
    assert cgroup_args('workspace') == []


def test_pid_pressure_checks_current_container_and_ancestor_limits(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKBENCH_HOST_CGROUP_ROOT', str(tmp_path))
    owner = tmp_path / 'gxzs.slice/gxzs-workbench.slice/gxzs-workbench-owner.slice'
    scope = owner / ('docker-' + 'a' * 64 + '.scope')
    scope.mkdir(parents=True)
    info = {'Id':'a' * 64,'HostConfig':{'CgroupParent':'gxzs-workbench-owner.slice'}}
    (scope / 'pids.current').write_text('123')
    (scope / 'pids.max').write_text('1024')
    (scope / 'pids.events').write_text('max 9000')
    assert not pid_pressure(info)  # Historical events do not mean current pressure.
    (owner / 'pids.current').write_text('256')
    (owner / 'pids.max').write_text('256')
    assert pid_pressure(info)
    (owner / 'pids.current').write_text('3')
    assert not pid_pressure(info)
