import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest


spec = importlib.util.spec_from_file_location('storage_inventory', Path(__file__).parents[3] / 'scripts/storage-inventory.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
pytestmark = pytest.mark.skipif(os.name != 'posix', reason='Linux fd-relative filesystem accounting')
WORKSPACE = '11111111-1111-4111-8111-111111111111'
SECOND = '22222222-2222-4222-8222-222222222222'


def fixture_state(tmp_path):
    state = tmp_path / 'state'
    host = state / 'hosts' / WORKSPACE
    host.mkdir(parents=True)
    record = dict(owner_id='000000:123', workspace_id=WORKSPACE, home_volume='old-host-home',
                  sandbox_name='friendly-container', sandbox_volume_prefix='immutable-workspace')
    (host / 'host.json').write_text(json.dumps(record))
    (state / 'shared.sqlite3').write_bytes(b'shared')
    volumes = {}
    for name in ('old-host-home', 'immutable-workspace-home', 'immutable-workspace-files', 'immutable-workspace-env'):
        path = tmp_path / name
        path.mkdir()
        (path / 'content').write_bytes(b'0123456789')
        volumes[name] = {'mountpoint': str(path), 'created_at': '2026-10-18T00:00:00Z'}
    calls = []

    def inspect(name, socket, timeout):
        calls.append((name, socket, timeout))
        return volumes[name]

    def collect(**kwargs):
        return module.inventory(str(state), 'dify-wb-dev', kwargs.pop('workspaces', [WORKSPACE]),
                                kwargs.pop('all_owners', False), kwargs.pop('max_owners', 100),
                                '/var/run/docker.sock', kwargs.pop('budget', module.Budget()), inspect=inspect)
    return state, volumes, calls, collect


def test_inventory_uses_persistent_storage_identity_and_counts_each_mount_once(tmp_path):
    state, volumes, calls, collect = fixture_state(tmp_path)
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in tmp_path.rglob('*') if p.is_file()}
    result = collect()
    assert result['status'] == 'complete'
    assert len(calls) == 4
    assert len(result['roots']) == 6
    assert result['owners'][0]['observed_counts']['apparent_bytes'] == 40 + len((state / 'hosts' / WORKSPACE / 'host.json').read_bytes())
    shared = next(r for r in result['roots'] if r['category'] == 'manager_shared_state')
    assert shared['counts']['apparent_bytes'] == 6
    assert shared['excluded_top_level'] == ['hosts']
    assert before == {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in tmp_path.rglob('*') if p.is_file()}
    assert not any('friendly-container' in name for name, _, _ in calls)


def test_metadata_scan_handles_sparse_hardlinks_symlinks_and_fifo_without_reading_contents(tmp_path):
    root = tmp_path / 'root'
    root.mkdir()
    with (root / 'sparse').open('wb') as f:
        f.truncate(16 * 1024 * 1024)
    os.link(root / 'sparse', root / 'linked')
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'private').write_bytes(b'outside')
    (root / 'escape').symlink_to(outside, target_is_directory=True)
    (root / 'loop').symlink_to(root, target_is_directory=True)
    os.mkfifo(root / 'fifo')
    result = module.scan(root, module.Budget())
    assert result['status'] == 'complete'
    assert result['counts']['apparent_bytes'] == 16 * 1024 * 1024
    assert result['counts']['allocated_bytes'] < result['counts']['apparent_bytes']
    assert result['counts']['files'] == 1
    assert result['counts']['hardlink_duplicates'] == 1
    assert result['counts']['symlinks'] == 2
    assert result['counts']['special'] == 1


@pytest.mark.parametrize('kind', ['root', 'ancestor'])
def test_symlink_roots_are_partial_without_following(tmp_path, kind):
    real = tmp_path / 'real'
    (real / 'child').mkdir(parents=True)
    (real / 'child/file').write_bytes(b'private')
    (tmp_path / 'alias').symlink_to(real, target_is_directory=True)
    result = module.scan(tmp_path / 'alias' / ('child' if kind == 'ancestor' else ''), module.Budget())
    assert result['status'] == 'partial'
    assert result['counts']['apparent_bytes'] == 0


@pytest.mark.parametrize('kind', ['entries', 'time', 'depth'])
def test_scan_budgets_are_explicit_and_never_complete(tmp_path, kind):
    (tmp_path / 'a/b/c').mkdir(parents=True)
    (tmp_path / 'a/b/c/file').write_bytes(b'content')
    budget = module.Budget(entries=1 if kind == 'entries' else 100, depth=1 if kind == 'depth' else 64)
    if kind == 'time':
        budget.started -= 60
    result = module.scan(tmp_path, budget)
    assert result['status'] == 'partial'
    assert {'entries': 'entry_budget', 'time': 'time_budget', 'depth': 'depth_budget'}[kind] in result['reasons']


def test_bad_record_does_not_hide_other_owners_and_shared_state(tmp_path):
    state, _, calls, collect = fixture_state(tmp_path)
    bad = state / 'hosts' / SECOND
    bad.mkdir()
    (bad / 'host.json').write_text('{broken')
    result = collect(workspaces=[], all_owners=True)
    assert result['status'] == 'partial'
    assert result['issues'][0]['workspace_id'] == SECOND
    assert len(calls) == 4
    assert next(r for r in result['roots'] if r['category'] == 'manager_shared_state')['status'] == 'complete'


def test_owner_budget_is_partial_and_never_silently_shrinks_scope(tmp_path):
    state, _, calls, collect = fixture_state(tmp_path)
    (state / 'hosts' / SECOND).mkdir()
    result = collect(workspaces=[], all_owners=True, max_owners=1)
    assert result['status'] == 'partial'
    assert {'reason': 'owner_budget'} in result['issues']
    assert len(result['scope']['workspaces']) == 1


def test_duplicate_owner_volume_binding_is_not_double_counted(tmp_path):
    state, _, calls, collect = fixture_state(tmp_path)
    other = state / 'hosts' / SECOND
    other.mkdir()
    record = json.loads((state / 'hosts' / WORKSPACE / 'host.json').read_text())
    record.update(owner_id='000000:456', workspace_id=SECOND)
    (other / 'host.json').write_text(json.dumps(record))
    result = collect(workspaces=[WORKSPACE, SECOND])
    assert result['status'] == 'partial'
    assert calls == []
    assert all(r['status'] == 'partial' and 'counts' not in r for r in result['roots'] if 'volume' in r)


def test_owner_label_conflict_and_binding_change_invalidate_accounting(tmp_path):
    state, volumes, _, collect = fixture_state(tmp_path)
    volumes['old-host-home']['owner_label'] = '000000:other'
    assert collect()['status'] == 'partial'
    del volumes['old-host-home']['owner_label']
    real = module.scan
    def changing(path, budget, exclude=()):
        result = real(path, budget, exclude)
        record = state / 'hosts' / WORKSPACE / 'host.json'
        value = json.loads(record.read_text())
        value['home_volume'] = 'replacement'
        record.write_text(json.dumps(value))
        return result
    from unittest.mock import patch
    with patch.object(module, 'scan', changing):
        result = collect()
    assert result['status'] == 'partial'
    assert any(i['reason'] == 'binding_not_confirmed_after_scan' for i in result['issues'])


def test_growth_requires_complete_same_identity_and_disjoint_time_windows(tmp_path):
    _, volumes, _, collect = fixture_state(tmp_path)
    before = collect()
    (Path(volumes['immutable-workspace-files']['mountpoint']) / 'new').write_bytes(b'new-output')
    after = collect()
    growth = module.compare(after, before)
    assert growth['status'] == 'available'
    workspace = next(r for r in growth['roots'] if r['category'] == 'workspace')
    assert workspace['delta']['apparent_bytes'] == 10
    assert workspace['per_day']['apparent_bytes'] > 0
    for change, reason in [('partial', 'partial_inventory'), ('scope', 'schema_or_scope_changed'),
                           ('identity', 'identity_or_time_changed'), ('time', 'identity_or_time_changed')]:
        invalid = copy.deepcopy(after)
        if change == 'partial': invalid['status'] = 'partial'
        if change == 'scope': invalid['scope']['workspaces'] = []
        if change == 'identity': invalid['roots'][0]['volume_created_at'] = 'replacement'
        if change == 'time': invalid['roots'][0]['observed_at'] = before['roots'][0]['observed_at']
        assert module.compare(invalid, before) == {'status': 'unavailable', 'reason': reason}


def test_inspect_pins_local_socket_and_refuses_nonlocal_storage(monkeypatch):
    calls = []
    value = dict(Name='owner-home', Driver='local', Mountpoint='/var/lib/docker/volumes/owner-home/_data', CreatedAt='date')
    def run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, json.dumps([value]))
    monkeypatch.setattr(module.subprocess, 'run', run)
    monkeypatch.setenv('DOCKER_HOST', 'ssh://remote')
    assert module.inspect_volume('owner-home', '/run/docker.sock', 2)['created_at'] == 'date'
    assert calls[0][0] == ['docker', '--host', 'unix:///run/docker.sock', 'volume', 'inspect', 'owner-home']
    assert calls[0][1]['timeout'] == 2
    value['Options'] = {'type': 'nfs'}
    with pytest.raises(ValueError, match='unsupported_volume'):
        module.inspect_volume('owner-home', '/run/docker.sock', 2)


def test_record_size_and_symlink_are_rejected(tmp_path):
    record = tmp_path / 'record'
    record.write_bytes(b' ' * 65537)
    with pytest.raises(ValueError, match='too_large'):
        module.read_json(record, 65536)
    (tmp_path / 'link').symlink_to(record)
    with pytest.raises(OSError):
        module.read_json(tmp_path / 'link', 65536)


@pytest.mark.parametrize('previous', [[], None, 'text', 42, float('nan'), float('inf'),
                                      {'schema': module.SCHEMA, 'scope': {}, 'roots': [None]}])
def test_malformed_previous_preserves_current_snapshot(tmp_path, monkeypatch, capsys, previous):
    _, _, _, collect = fixture_state(tmp_path)
    current = collect()
    if isinstance(previous, dict):
        previous.update(scope=current['scope'], status='complete')
    path = tmp_path / 'previous.json'
    path.write_text(json.dumps(previous))
    monkeypatch.setattr(module, 'inventory', lambda *args: current)
    monkeypatch.setattr(sys, 'argv', ['storage-inventory.py', '--state', str(tmp_path),
                                    '--sandbox-prefix', 'dify-wb-dev', '--workspace', WORKSPACE,
                                    '--previous', str(path)])
    assert module.main() == 0
    output = json.loads(capsys.readouterr().out)
    assert output['status'] == 'complete'
    assert output['roots'] == current['roots']
    assert output['growth']['status'] == 'unavailable'


@pytest.mark.parametrize('value', [float('nan'), float('inf'), True, '12', -1, 10 ** 1000])
def test_invalid_previous_counters_do_not_poison_json_output(tmp_path, value):
    _, _, _, collect = fixture_state(tmp_path)
    before = collect()
    before['roots'][0]['counts']['apparent_bytes'] = value
    after = collect()
    after['growth'] = module.compare(after, before)
    assert after['growth'] == {'status': 'unavailable', 'reason': 'invalid_previous_snapshot'}
    assert json.dumps(after, allow_nan=False)
