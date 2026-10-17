import io
import json
from pathlib import Path
import sys
import urllib.request

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / 'stop_jobs.py'
BINDING = '00000000-0000-4000-8000-000000000001'


@pytest.mark.parametrize(('layout', 'job_home'), [
    ('legacy', '/home/dify'),
    ('current', '/home/gxzs'),
    ('current', '/home/dify'),
    ('alias', '/home/dify'),
])
def test_cleanup_covers_both_image_homes_without_touching_another_binding(
        tmp_path, monkeypatch, capsys, layout, job_home):
    import pathlib
    current, legacy = tmp_path / 'gxzs', tmp_path / 'dify'
    root = legacy if layout == 'legacy' else current
    jobs = root / '.local/share/shellctl/jobs'
    for name, binding in [('target', BINDING), ('other', '00000000-0000-4000-8000-000000000002')]:
        entry = jobs / name
        entry.mkdir(parents=True)
        (entry / '.job-env.json').write_text(json.dumps({'HOME': job_home + '/' + binding}))
    paths = {
        '/home/gxzs/.local/share/shellctl/jobs': current / '.local/share/shellctl/jobs',
        '/home/dify/.local/share/shellctl/jobs': (current if layout == 'alias' else legacy) / '.local/share/shellctl/jobs',
    }
    monkeypatch.setattr(pathlib, 'Path', lambda value: paths[value])
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'binding_id': BINDING})))
    monkeypatch.setenv('SHELLCTL_AUTH_TOKEN', 'fixture-token')
    requests = []

    def delete(request, timeout):
        requests.append((request.full_url, request.method))
        return io.BytesIO(b'{"deleted":true}')

    monkeypatch.setattr(urllib.request, 'urlopen', delete)
    exec(compile(SCRIPT.read_text(), str(SCRIPT), 'exec'), {'__name__': '__main__'})
    assert requests == [('http://127.0.0.1:5004/v1/jobs/target?force=true&grace_seconds=1', 'DELETE')]
    assert json.loads(capsys.readouterr().out) == {'stopped': 1}
