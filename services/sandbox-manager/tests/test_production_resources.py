import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

script = Path(__file__).resolve().parents[3] / 'scripts/verify-production-resources.py'
spec = importlib.util.spec_from_file_location('production_resources', script)
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)


def published(tmp_path):
    skill = tmp_path / 'skills/legal'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text('# Legal', encoding='utf-8')
    (skill / 'reference.txt').write_text('supporting file', encoding='utf-8')
    manifest = {'skills': 1, 'files': {p.relative_to(tmp_path/'skills').as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in skill.iterdir()}}
    (tmp_path/'skills-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    return skill, manifest


@pytest.mark.parametrize('change', ['missing-resource', 'modified-resource', 'extra-resource', 'empty-tree', 'valid'])
def test_release_manifest_covers_all_skill_resources(tmp_path, change):
    skill, manifest = published(tmp_path)
    if change == 'missing-resource': (skill/'reference.txt').unlink()
    if change == 'modified-resource': (skill/'reference.txt').write_text('changed', encoding='utf-8')
    if change == 'extra-resource': (skill/'extra.txt').write_text('unexpected', encoding='utf-8')
    if change == 'empty-tree':
        for path in skill.iterdir(): path.unlink()
    if change == 'valid':
        assert resources.verify_skill_source(tmp_path)[1] == manifest
    else:
        with pytest.raises(ValueError, match='release manifest'):
            resources.verify_skill_source(tmp_path)


@pytest.mark.parametrize('runtime', [
    {'fonts': 0, 'font_generation': 'system'},
    {'fonts': 349, 'font_generation': 'release'},
    {'fonts': 350, 'font_generation': 'other-release'},
])
def test_rejects_ci_fonts_or_changed_production_font_release(runtime):
    with pytest.raises(ValueError, match='font assets'):
        resources.verify_font_runtime(runtime, {'uniqueFiles': 350, 'generation': 'release'})


def test_accepts_verified_production_font_release():
    resources.verify_font_runtime({'fonts': 350, 'font_generation': 'release'}, {'uniqueFiles': 350, 'generation': 'release'})


@pytest.mark.parametrize('change', ['valid', 'corrupt', 'missing', 'changed-generation'])
def test_persistent_font_archive_is_available_for_future_builds(tmp_path, change):
    fonts = tmp_path/'fonts'
    fonts.mkdir()
    digest = hashlib.sha256(b'font-fixture').hexdigest()
    name = digest + '.ttf'
    (fonts/name).write_bytes(b'font-fixture')
    manifest = {'uniqueFiles': 1, 'generation': hashlib.sha256(name.encode()).hexdigest(),
                'files': [{'asset': 'fonts/'+name, 'sha256': digest}]}
    if change == 'corrupt': (fonts/name).write_bytes(b'corrupt')
    if change == 'missing': (fonts/name).unlink()
    if change == 'changed-generation': manifest['generation'] = 'other'
    (fonts/'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    if change == 'valid':
        assert resources.verify_font_source(tmp_path) == manifest
    else:
        with pytest.raises((ValueError, FileNotFoundError)):
            resources.verify_font_source(tmp_path)
