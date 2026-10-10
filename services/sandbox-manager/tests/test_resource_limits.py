import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resource_limits import cgroup_args, owner_cgroup


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
