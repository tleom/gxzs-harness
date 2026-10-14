import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
import os


@pytest.mark.skipif(os.name == 'nt', reason='Manager uses Linux fcntl; exercised in Linux sandbox verification')
def test_converter_does_not_hold_owner_lock_and_cancel_removes_only_disposable_container(tmp_path, monkeypatch):
    base = Path(__file__).parents[1]
    monkeypatch.syspath_prepend(str(base))
    monkeypatch.setenv('WORKBENCH_SANDBOX_MANAGER_TOKEN', 'test-only')
    monkeypatch.setenv('WORKBENCH_MANAGER_STATE', str(tmp_path))
    spec = importlib.util.spec_from_file_location('tested_office_manager', base / 'server.py')
    manager = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(manager)
    entered, stopped = threading.Event(), threading.Event()
    calls = []
    def docker(*args, **kwargs):
        calls.append(args)
        if args[0] == 'image': return SimpleNamespace(stdout='sha256:test-image', returncode=0)
        if args[0] == 'start':
            entered.set()
            assert stopped.wait(3)
            return SimpleNamespace(stdout='', returncode=1)
        if args[0] == 'rm': stopped.set()
        return SimpleNamespace(stdout='', returncode=0)
    monkeypatch.setattr(manager, 'docker', docker)
    monkeypatch.setattr(manager, 'cgroup_args', lambda _: [])
    key, request_id = str(uuid4()), str(uuid4())
    with ThreadPoolExecutor(1) as pool:
        operation = pool.submit(manager.operation, key, 'office-preview', {'name':'file.docx', 'data':'ZG9j', 'request_id':request_id})
        assert entered.wait(2)
        with manager.lock(key):
            # Reached while conversion is blocked: control and file operations remain available.
            assert not stopped.is_set()
        manager.operation(key, 'office-preview', {'operation':'cancel', 'request_id':request_id})
        with pytest.raises(ValueError, match='取消'):
            operation.result(2)
    names = [call[2] for call in calls if call[0] == 'rm']
    assert names and len(set(names)) == 1 and '-preview-' in names[0]
