import io
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
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


@pytest.mark.parametrize('failure', [
    'bad-json', 'bad-encoding', 'array', 'invalid-home', 'unreadable',
    'http-error', 'unconfirmed', 'bad-response', 'array-response', 'network-error',
])
def test_cleanup_continues_after_bad_job_but_does_not_report_success(
        tmp_path, monkeypatch, capsys, failure):
    import pathlib
    jobs = tmp_path / 'jobs'
    for name in ['broken', 'target', 'other']:
        entry = jobs / name
        entry.mkdir(parents=True)
        binding = BINDING if name != 'other' else '00000000-0000-4000-8000-000000000002'
        (entry / '.job-env.json').write_text(json.dumps({'HOME': '/home/gxzs/' + binding}), encoding='utf-8')
    broken = jobs / 'broken' / '.job-env.json'
    invalid = {'bad-json': b'{secret-value', 'bad-encoding': b'\xff',
               'array': b'[]', 'invalid-home': b'{"HOME":[]}'}
    if failure in invalid:
        broken.write_bytes(invalid[failure])
    original_read = Path.read_text

    def read_text(path, *args, **kwargs):
        if failure == 'unreadable' and path == broken:
            raise PermissionError('secret-value')
        return original_read(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'read_text', read_text)
    # Deterministic traversal puts the failing entry before the valid target.
    monkeypatch.setattr(Path, 'glob', lambda self, pattern: iter(sorted(self.iterdir())))
    monkeypatch.setattr(pathlib, 'Path', lambda value: jobs)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps({'binding_id': BINDING})))
    monkeypatch.setenv('SHELLCTL_AUTH_TOKEN', 'fixture-token')
    requests = []

    def delete(request, timeout):
        requests.append(request.full_url)
        if '/broken?' in request.full_url:
            if failure == 'http-error':
                raise HTTPError(request.full_url, 503, 'secret-value', None, None)
            if failure == 'network-error':
                raise OSError('secret-value')
            responses = {'unconfirmed': b'{"deleted":false}', 'bad-response': b'{secret-value',
                         'array-response': b'[]'}
            return io.BytesIO(responses[failure])
        return io.BytesIO(b'{"deleted":true}')

    monkeypatch.setattr(urllib.request, 'urlopen', delete)
    with pytest.raises(RuntimeError, match='not confirmed for 1 job.*stopped 1') as error:
        exec(compile(SCRIPT.read_text(), str(SCRIPT), 'exec'), {'__name__': '__main__'})
    assert any('/target?' in url for url in requests)
    assert all('/other?' not in url for url in requests)
    assert 'secret-value' not in str(error.value)
    assert capsys.readouterr().out == ''
