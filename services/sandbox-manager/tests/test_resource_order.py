"""Real owner filesystem order, migration and compare-and-swap regression tests."""
import json
import os

import pytest

from test_resource_layout import layout_modules

pytestmark = pytest.mark.skipif(os.name != 'posix', reason='Requires POSIX directory locks')


@pytest.fixture(params=['skills', 'mcp'])
def catalog(layout_modules, tmp_path, request):
    resources, mcp = layout_modules
    kind = request.param
    root = tmp_path / kind
    root.mkdir()
    for name in ('a', 'b', 'c'):
        path = root / name
        path.mkdir()
        if kind == 'skills':
            (path / 'SKILL.md').write_text('# Skill')
        else:
            (path / 'mcp.json').write_text(json.dumps({'name': name, 'command': 'echo'}))
    call = resources.personal if kind == 'skills' else mcp.personal_mcp
    def listing():
        return call({'operation': 'list' if kind == 'skills' else 'mcp_list'}, str(tmp_path))
    def reorder(names, revision=None):
        return call({'operation': 'skill_reorder' if kind == 'skills' else 'mcp_reorder', 'order': names, 'order_version': revision}, str(tmp_path))
    return kind, root, listing, reorder


def test_order_persists_and_stale_writer_cannot_overwrite(catalog):
    kind, root, listing, reorder = catalog
    assert listing()['order_version'] is None
    saved = reorder(['c', 'a', 'b'])
    assert [item['id'] for item in listing()[kind]] == ['c', 'a', 'b']
    assert listing()['order_version'] == saved['order_version']
    assert reorder(['b', 'a', 'c']) == {'conflict': True}
    assert json.loads((root / '.order.json').read_text()) == {'c': 0, 'a': 1, 'b': 2}
    (root / 'new').mkdir()
    assert reorder(['b', 'c', 'a'], saved['order_version'])['order'] == ['b', 'c', 'a', 'new']


@pytest.mark.parametrize('names', [['a', 'a'], ['../other'], ['other-owner'], [42], None])
def test_invalid_order_never_writes(catalog, names):
    _, root, _, reorder = catalog
    with pytest.raises(ValueError):
        reorder(names)
    assert not (root / '.order.json').exists()


def test_migrates_pin_file_once_and_new_order_wins(catalog):
    kind, root, listing, reorder = catalog
    (root / '.pins.json').write_text('{"c":true,"removed":true}')
    first = listing()
    assert [item['id'] for item in first[kind]] == ['c', 'a', 'b']
    assert not (root / '.pins.json').exists()
    saved = reorder(['b', 'a', 'c'], first['order_version'])
    (root / '.pins.json').write_text('{"c":true}')
    assert listing()['order_version'] == saved['order_version']
    assert [item['id'] for item in listing()[kind]] == ['b', 'a', 'c']
    assert not (root / '.pins.json').exists()


@pytest.mark.parametrize('file,value', [('.order.json', '{'), ('.order.json', '{"a":true}'), ('.order.json', '{"a":0,"b":0}'), ('.pins.json', '{')])
def test_broken_preferences_do_not_hide_or_disable_resources(catalog, file, value):
    kind, root, listing, reorder = catalog
    (root / file).write_text(value)
    result = listing()
    assert len(result[kind]) == 3 and all(item['enabled'] for item in result[kind])
    assert result['warnings']
    with pytest.raises(ValueError):
        reorder(['b', 'a', 'c'])
    assert (root / file).read_text() == value


def test_order_symlink_does_not_read_or_modify_another_owner(catalog, tmp_path):
    kind, root, listing, reorder = catalog
    secret = tmp_path / 'another-owner.json'
    secret.write_text('{"other":0}')
    (root / '.order.json').symlink_to(secret)
    assert len(listing()[kind]) == 3
    with pytest.raises(OSError):
        reorder(['b', 'a', 'c'])
    assert secret.read_text() == '{"other":0}'


def test_delete_removes_order_and_reinstall_appends(catalog, layout_modules, tmp_path):
    kind, root, listing, reorder = catalog
    resources, mcp = layout_modules
    reorder(['c', 'b', 'a'])
    item = listing()[kind][0]
    call = resources.personal if kind == 'skills' else mcp.personal_mcp
    call({'operation': 'skill_uninstall' if kind == 'skills' else 'mcp_delete', 'name': 'c', 'version': item['version']}, str(tmp_path))
    assert 'c' not in json.loads((root / '.order.json').read_text())
    path = root / 'c'
    path.mkdir()
    (path / ('SKILL.md' if kind == 'skills' else 'mcp.json')).write_text('# Skill' if kind == 'skills' else '{"name":"c","command":"echo"}')
    assert [item['id'] for item in listing()[kind]] == ['b', 'a', 'c']


@pytest.mark.parametrize('committed', [False, True])
def test_failed_delete_keeps_resource_and_preferences(catalog, layout_modules, tmp_path, monkeypatch, committed):
    kind, root, listing, reorder = catalog
    resources, mcp = layout_modules
    module = resources if kind == 'skills' else mcp
    call = resources.personal if kind == 'skills' else mcp.personal_mcp
    reorder(['c', 'b', 'a'])
    (root / '.settings.json').write_text('{"c":false}')
    before = listing()
    item = before[kind][0]
    original = module.atomic_write
    failed = False
    def fail_order(fd, name, data):
        nonlocal failed
        if name == '.order.json' and not failed:
            failed = True
            if committed:
                original(fd, name, data)
            raise OSError('simulated order write failure')
        return original(fd, name, data)
    monkeypatch.setattr(module, 'atomic_write', fail_order)
    with pytest.raises(OSError, match='simulated order write failure'):
        call({'operation': 'skill_uninstall' if kind == 'skills' else 'mcp_delete',
              'name': 'c', 'version': item['version']}, str(tmp_path))
    assert [item['id'] for item in listing()[kind]] == ['c', 'b', 'a']
    assert listing()[kind][0]['enabled'] is False
    assert listing()['order_version'] == before['order_version']
