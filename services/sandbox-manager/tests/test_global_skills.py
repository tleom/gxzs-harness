import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from global_skills import TARGET, matches_mount, mount_arguments, native_root


@pytest.fixture(autouse=True)
def clean_config(monkeypatch):
    monkeypatch.delenv('GXZS_GLOBAL_SKILL_HOST_DIR', raising=False)
    monkeypatch.delenv('GXZS_GLOBAL_SKILL_DIR', raising=False)


@pytest.mark.parametrize('value', ['skills', '/', '/srv/../skills', '/srv/skills/',
                                  '/srv/skills,readonly=false', '/srv/skills:rw', '/srv/skills\n'])
def test_rejects_ambiguous_host_paths(monkeypatch, value):
    monkeypatch.setenv('GXZS_GLOBAL_SKILL_HOST_DIR', value)
    with pytest.raises(ValueError, match='absolute Docker-host path'):
        mount_arguments()


def test_mount_requires_existing_host_directory_and_native_root(monkeypatch):
    monkeypatch.setenv('GXZS_GLOBAL_SKILL_HOST_DIR', '/srv/global-skills')
    assert mount_arguments() == ['--mount', f'type=bind,source=/srv/global-skills,destination={TARGET},readonly']
    assert native_root() == TARGET
    monkeypatch.setenv('GXZS_GLOBAL_SKILL_DIR', '/wrong')
    with pytest.raises(ValueError, match='native skill root'):
        mount_arguments()


@pytest.mark.parametrize('changes', [{'RW': True}, {'Type': 'volume'}, {'Source': '/other'}, {'Destination': '/other'}])
def test_live_mount_must_preserve_the_readonly_authority(monkeypatch, changes):
    monkeypatch.setenv('GXZS_GLOBAL_SKILL_HOST_DIR', '/srv/global-skills')
    mount = {'Type': 'bind', 'Source': '/srv/global-skills', 'Destination': TARGET, 'RW': False}
    assert matches_mount({'Mounts': [mount]})
    assert not matches_mount({'Mounts': [{**mount, **changes}]})
    assert not matches_mount({'Mounts': []})
    assert not matches_mount({'Mounts': [mount, mount]})


def test_legacy_images_and_explicit_roots_remain_supported(monkeypatch):
    assert mount_arguments() == [] and matches_mount({})
    monkeypatch.setenv('GXZS_GLOBAL_SKILL_DIR', '/srv/dsh/published-skills')
    assert native_root() == '/srv/dsh/published-skills'
    assert not matches_mount({'Mounts': [{'Destination': TARGET}]})
