"""Exercise the destructive validation helper against disposable Linux fixtures."""
import os
from pathlib import Path
import subprocess
import sys

import pytest


pytestmark = pytest.mark.skipif(sys.platform != 'linux', reason='requires Linux realpath and symlinks')
SCRIPT = Path(__file__).resolve().parents[3] / 'scripts' / 'prepare-live-home.sh'
PACKAGES = ('workbench-adapter workbench-control-commands workbench-file-manager '
            'workbench-platform-client workbench-sandbox-skills workbench-sandbox-runtime '
            'workbench-mcp-tools tool-discovery').split()
MARKER = '.gxzs-disposable-validation-home'


@pytest.fixture
def preparation(tmp_path):
    source = tmp_path / 'source'
    for relative in ['profiles/workbench', 'scripts'] + ['packages/' + name for name in PACKAGES]:
        directory = source / relative
        directory.mkdir(parents=True)
        (directory / 'fixture').write_text('source', encoding='utf-8')
    (source / 'profiles/workbench/package-lock.json').write_text('{}', encoding='utf-8')
    tools = tmp_path / 'bin'
    tools.mkdir()
    npm = tools / 'npm'
    npm.write_text('#!/bin/sh\nprintf "%s\\n" "$*" > npm-invoked\n', encoding='utf-8')
    npm.chmod(0o755)
    root = tmp_path / 'validation'
    home = root / 'owner'
    env = {**os.environ, 'HARNESS': str(source), 'GXZS_VALIDATION_ROOT': str(root),
           'DSH_HOME': str(home), 'PATH': str(tools) + os.pathsep + os.environ['PATH']}

    def run(**overrides):
        return subprocess.run(['sh', str(SCRIPT)], env={**env, **overrides},
                              capture_output=True, text=True, timeout=15)

    return source, root, home, run


def mark(home):
    home.mkdir(parents=True, exist_ok=True)
    (home / MARKER).write_text('gxzs-disposable-validation-home-v1:' + str(home.resolve()) + '\n', encoding='utf-8')


def test_fresh_home_and_marked_repeat_preserve_unrelated_data(preparation):
    source, root, home, run = preparation
    result = run()
    assert result.returncode == 0, result.stderr
    assert (home / 'profiles/workbench/npm-invoked').read_text().strip() == 'ci --no-audit --no-fund'
    assert (home / 'node_modules').is_symlink()
    (home / 'history').write_text('keep', encoding='utf-8')
    (home / 'packages/workbench-adapter/stale').write_text('old', encoding='utf-8')
    result = run()
    assert result.returncode == 0, result.stderr
    assert (home / 'history').read_text() == 'keep'
    assert not (home / 'packages/workbench-adapter/stale').exists()


@pytest.mark.parametrize('case', ['outside', 'root', 'filesystem-root', 'source', 'source-parent',
                                  'unmarked', 'wrong-marker', 'symlink-marker', 'symlink-parent',
                                  'profiles', 'packages', 'scripts', 'missing-source'])
def test_unsafe_home_rejected_before_deleting_existing_data(preparation, tmp_path, case):
    source, root, home, run = preparation
    overrides = {}
    protected = tmp_path / 'protected'
    protected.mkdir()
    sentinel = protected / 'keep'
    sentinel.write_text('keep', encoding='utf-8')
    if case == 'outside':
        overrides['DSH_HOME'] = str(protected)
    elif case == 'root':
        overrides['DSH_HOME'] = str(root)
    elif case == 'filesystem-root':
        overrides['GXZS_VALIDATION_ROOT'] = '/'
    elif case == 'source':
        overrides.update(GXZS_VALIDATION_ROOT=str(tmp_path), DSH_HOME=str(source))
    elif case == 'source-parent':
        overrides.update(GXZS_VALIDATION_ROOT=str(tmp_path.parent), DSH_HOME=str(tmp_path))
    elif case == 'symlink-parent':
        root.mkdir()
        (root / 'alias').symlink_to(protected, target_is_directory=True)
        overrides['DSH_HOME'] = str(root / 'alias' / 'home')
    else:
        mark(home)
        if case == 'unmarked':
            (home / MARKER).unlink()
            (home / 'history').write_text('keep', encoding='utf-8')
        elif case == 'wrong-marker':
            (home / MARKER).write_text('gxzs-disposable-validation-home-v1:/wrong', encoding='utf-8')
        elif case == 'symlink-marker':
            (home / MARKER).unlink()
            (home / MARKER).symlink_to(sentinel)
        elif case == 'missing-source':
            (source / 'profiles/workbench/package-lock.json').unlink()
        else:
            (home / case).symlink_to(protected, target_is_directory=True)
    result = run(**overrides)
    assert result.returncode != 0
    assert sentinel.read_text() == 'keep'
    assert not (home / 'profiles/workbench/npm-invoked').exists()
