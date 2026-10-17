"""Owner resource layout migration with real POSIX files and recovery data."""

import base64
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

import pytest

from test_mcp_worker import connected, modules  # Reuse the real stdio/HTTP/SSE transport fixture.

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Requires POSIX descriptor operations")


@pytest.fixture
def layout_modules():
    base = Path(__file__).parents[1]
    for name in ("file_ops", "resource_ops", "mcp_ops"):
        spec = importlib.util.spec_from_file_location(name, base / f"{name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules["resource_ops"], sys.modules["mcp_ops"]


def migrate(resources, root, kind):
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = resources.resource_directory(rootfd, kind)
        os.close(fd)
    finally:
        os.close(rootfd)


def test_skill_catalog_preserves_legacy_flags_versions_and_backups(layout_modules, tmp_path):
    resources, _ = layout_modules
    package = {"files": [{"path": "SKILL.md", "data": base64.b64encode(b"# Report").decode()}]}
    original = resources.personal({"operation": "skill_import", "name": "report", **package}, str(tmp_path))
    (tmp_path / ".skills-settings.json").write_text('{"report":false}')
    (tmp_path / ".skills-pins.json").write_text('{"report":true}')
    backups = tmp_path / ".skill-backups"
    backups.mkdir()
    # A backup that itself resembles a skill must never become installed.
    (backups / "SKILL.md").write_bytes(b"# Removed skill")
    (backups / "old-package").mkdir()
    (backups / "old-package/SKILL.md").write_bytes(b"# Recoverable")
    unrelated = tmp_path / "conversations"
    unrelated.mkdir()
    (unrelated / "work.txt").write_bytes(b"untouched")

    listed = resources.personal({"operation": "list"}, str(tmp_path))
    assert listed["warnings"] == []
    assert len(listed["skills"]) == 1
    assert listed["skills"][0]["id"] == "report"
    assert listed["skills"][0]["enabled"] is False
    assert listed["skills"][0]["version"] == original["version"]
    assert (tmp_path / "skills/.settings.json").read_bytes() == b'{"report":false}'
    assert json.loads((tmp_path / "skills/.order.json").read_bytes()) == {"report": 0}
    assert not (tmp_path / "skills/.pins.json").exists()
    assert (tmp_path / "skills/.backups/old-package/SKILL.md").read_bytes() == b"# Recoverable"
    assert not any((tmp_path / old).exists() for old in
                   (".skills-settings.json", ".skills-pins.json", ".skill-backups"))
    assert (unrelated / "work.txt").read_bytes() == b"untouched"


def test_mcp_catalog_preserves_legacy_cache_and_config_revision(layout_modules, tmp_path):
    _, mcp = layout_modules
    content = json.dumps({"name": "demo", "command": "echo", "args": []})
    original = mcp.personal_mcp({"operation": "mcp_save", "name": "demo", "content": content}, str(tmp_path))
    tools = [{"name": "lookup", "description": "Lookup", "inputSchema": {"type": "object"}}]
    mcp.personal_mcp({"operation": "mcp_cache", "name": "demo", "version": original["version"], "tools": tools}, str(tmp_path))
    cache = (tmp_path / "mcp/.cache/demo.json").read_bytes()
    (tmp_path / "mcp/.cache").rename(tmp_path / ".mcp-cache")
    (tmp_path / ".mcp-settings.json").write_bytes(b'{"demo":false}')
    (tmp_path / ".mcp-pins.json").write_bytes(b'{"demo":true}')
    (tmp_path / ".mcp-backups").mkdir()
    (tmp_path / ".mcp-backups/mcp.json").write_bytes(content.encode())

    listed = mcp.personal_mcp({"operation": "mcp_list"}, str(tmp_path))
    assert listed["warnings"] == []
    assert len(listed["mcp"]) == 1
    item = listed["mcp"][0]
    assert item["id"] == "demo" and item["enabled"] is False
    assert item["version"] == original["version"]
    assert item["status"] == "ready" and item["tools"] == tools
    assert (tmp_path / "mcp/demo/mcp.json").read_bytes() == content.encode()
    assert (tmp_path / "mcp/.cache/demo.json").read_bytes() == cache
    assert not any((tmp_path / old).exists() for old in
                   (".mcp-settings.json", ".mcp-pins.json", ".mcp-cache", ".mcp-backups"))


@pytest.mark.parametrize("kind,old,current", [
    ("mcp", ".mcp-settings.json", ".settings.json"),
    ("skills", ".skills-settings.json", ".settings.json"),
])
def test_both_locations_preserve_keys_active_values_and_original_bytes(layout_modules, tmp_path, kind, old, current):
    resources, _ = layout_modules
    target = tmp_path / kind
    target.mkdir()
    previous = b'{"shared":true,"old-only":false}'
    active = b'{"shared":false,"current-only":true}'
    (tmp_path / old).write_bytes(previous)
    (target / current).write_bytes(active)
    os.chmod(target / current, 0o600)

    migrate(resources, tmp_path, kind)
    assert json.loads((target / current).read_bytes()) == {
        "shared": False, "old-only": False, "current-only": True,
    }
    recovery = list((target / ".backups").iterdir())
    assert len(recovery) == 1 and recovery[0].read_bytes() == previous
    assert not (tmp_path / old).exists()
    assert stat.S_IMODE((target / current).stat().st_mode) == 0o600
    before = (target / current).read_bytes()
    migrate(resources, tmp_path, kind)
    assert (target / current).read_bytes() == before
    assert list((target / ".backups").iterdir()) == recovery


@pytest.mark.parametrize("kind,old,current", [
    ("mcp", ".mcp-cache", ".cache"),
    ("mcp", ".mcp-backups", ".backups"),
    ("skills", ".skill-backups", ".backups"),
])
def test_directory_collisions_keep_both_complete_entries(layout_modules, tmp_path, kind, old, current):
    resources, _ = layout_modules
    legacy = tmp_path / old
    destination = tmp_path / kind / current
    legacy.mkdir()
    destination.mkdir(parents=True)
    (legacy / "duplicate").mkdir()
    (legacy / "duplicate/data.txt").write_bytes(b"old backup")
    (destination / "duplicate").mkdir()
    (destination / "duplicate/data.txt").write_bytes(b"current backup")
    (legacy / "old-only.json").write_bytes(b"old cache")
    (destination / "current-only.json").write_bytes(b"current cache")
    migrate(resources, tmp_path, kind)
    assert not legacy.exists()
    assert (destination / "duplicate/data.txt").read_bytes() == b"current backup"
    assert next(destination.glob("duplicate.legacy-*/data.txt")).read_bytes() == b"old backup"
    assert (destination / "old-only.json").read_bytes() == b"old cache"
    assert (destination / "current-only.json").read_bytes() == b"current cache"
    before = sorted(item.name for item in destination.iterdir())
    migrate(resources, tmp_path, kind)
    assert sorted(item.name for item in destination.iterdir()) == before


@pytest.mark.parametrize("kind,old", [("mcp", ".mcp-settings.json"), ("skills", ".skills-settings.json")])
def test_resource_root_symlink_never_moves_or_reads_other_owner_files(layout_modules, tmp_path, kind, old):
    resources, _ = layout_modules
    outside = tmp_path / "other-owner"
    outside.mkdir()
    (outside / ".settings.json").write_bytes(b"private")
    (tmp_path / kind).symlink_to(outside, target_is_directory=True)
    (tmp_path / old).write_bytes(b'{"demo":false}')
    with pytest.raises(OSError):
        migrate(resources, tmp_path, kind)
    assert (outside / ".settings.json").read_bytes() == b"private"
    assert (tmp_path / old).read_bytes() == b'{"demo":false}'


def test_invalid_destination_directory_preserves_legacy_tree(layout_modules, tmp_path):
    resources, _ = layout_modules
    (tmp_path / "mcp").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "demo.json").write_bytes(b"private")
    (tmp_path / "mcp/.cache").symlink_to(outside, target_is_directory=True)
    (tmp_path / ".mcp-cache").mkdir()
    (tmp_path / ".mcp-cache/demo.json").write_bytes(b"old")
    with pytest.raises(ValueError):
        migrate(resources, tmp_path, "mcp")
    assert (outside / "demo.json").read_bytes() == b"private"
    assert (tmp_path / ".mcp-cache/demo.json").read_bytes() == b"old"


def test_failed_atomic_merge_keeps_both_original_files(layout_modules, tmp_path, monkeypatch):
    resources, _ = layout_modules
    (tmp_path / "skills").mkdir()
    (tmp_path / ".skills-settings.json").write_bytes(b'{"old":false}')
    (tmp_path / "skills/.settings.json").write_bytes(b'{"new":true}')
    def fail(*args):
        raise OSError("disk write failed")
    monkeypatch.setattr(resources, "atomic_write", fail)
    with pytest.raises(OSError, match="disk write"):
        migrate(resources, tmp_path, "skills")
    assert (tmp_path / ".skills-settings.json").read_bytes() == b'{"old":false}'
    assert (tmp_path / "skills/.settings.json").read_bytes() == b'{"new":true}'


@pytest.mark.parametrize("invalid", [b"{", b"[]", b'{"report":42}'])
def test_malformed_legacy_state_is_preserved_and_valid_destination_remains_active(layout_modules, tmp_path, invalid):
    resources, _ = layout_modules
    (tmp_path / "skills").mkdir()
    (tmp_path / ".skills-settings.json").write_bytes(invalid)
    (tmp_path / "skills/.settings.json").write_bytes(b'{"report":false}')
    migrate(resources, tmp_path, "skills")
    assert (tmp_path / "skills/.settings.json").read_bytes() == b'{"report":false}'
    assert next((tmp_path / "skills/.backups").iterdir()).read_bytes() == invalid


def test_skill_inspection_remains_read_only_with_legacy_layout(layout_modules, tmp_path):
    resources, _ = layout_modules
    (tmp_path / ".skills-settings.json").write_bytes(b'{"report":false}')
    result = resources.personal({"operation": "skill_inspect", "files": [
        {"path": "SKILL.md", "data": base64.b64encode(b"# Report").decode()},
    ]}, str(tmp_path))
    assert result["content"] == "# Report"
    assert not (tmp_path / "skills").exists()
    assert (tmp_path / ".skills-settings.json").read_bytes() == b'{"report":false}'


def test_live_mcp_connection_uses_relocated_state_and_keeps_working_directory(connected):
    connection, ops, root, transport = connected
    before = connection.call("add", {"value": 2})["result"]["structuredContent"]
    cache = (root / "mcp/.cache/demo.json").read_bytes()
    (root / "mcp/.cache").rename(root / ".mcp-cache")
    (root / ".mcp-settings.json").write_bytes(b'{"demo":true}')
    (root / ".mcp-pins.json").write_bytes(b'{"demo":true}')
    item = ops.personal_mcp({"operation": "mcp_list"}, str(root))["mcp"][0]
    assert item["status"] == "ready"
    after = connection.call("add", {"value": 4})["result"]["structuredContent"]
    assert after["pid"] == before["pid"]
    assert after["value"] == 5 and after["calls"] == before["calls"] + 1
    if transport == "stdio":
        assert after["cwd"] == before["cwd"] == str(root)
    assert (root / "mcp/.cache/demo.json").read_bytes() == cache
    assert not any((root / old).exists() for old in
                   (".mcp-cache", ".mcp-settings.json", ".mcp-pins.json"))
    ops.personal_mcp({"operation": "mcp_toggle", "name": "demo", "enabled": False}, str(root))
    assert "已停用" in connection.call("add", {"value": 1})["error"]
