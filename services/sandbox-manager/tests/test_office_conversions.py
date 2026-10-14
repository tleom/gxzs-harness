import base64
from concurrent.futures import ThreadPoolExecutor
import sys
from pathlib import Path
import threading
import time
from uuid import uuid4

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
from office_conversions import OfficeConversions
from resource_limits import ResourceUnavailable


def request(data=b'doc'):
    return {'request_id': str(uuid4()), 'name': 'file.docx', 'data': base64.b64encode(data).decode()}


def test_dedup_cache_and_font_image_generation():
    queue = OfficeConversions()
    started, finish = threading.Event(), threading.Event()
    calls = []
    def run(job):
        calls.append(job)
        started.set()
        assert finish.wait(3)
        return {'data': 'cGRm', 'missing_fonts': ['missing']}
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(queue.convert, 'owner', request(), 'image-a', run)
        assert started.wait(1)
        second = pool.submit(queue.convert, 'owner', request(), 'image-a', run)
        deadline = time.monotonic() + 1
        while len(queue.requests) != 2 and time.monotonic() < deadline:
            time.sleep(.01)
        finish.set()
        assert first.result(2) == second.result(2)
    assert len(calls) == 1
    queue.convert('owner', request(), 'image-a', run)
    assert len(calls) == 1
    queue.convert('owner', request(), 'image-b', run)
    queue.convert('another', request(), 'image-b', run)
    assert len(calls) == 3


def test_cancel_one_reader_keeps_other_reader_and_last_cancel_stops():
    queue = OfficeConversions()
    first_payload, second_payload = request(), request()
    started, finish, stopped = threading.Event(), threading.Event(), threading.Event()
    def run(job):
        job.stop = stopped.set
        started.set()
        assert finish.wait(3)
        return {'data': 'cGRm'}
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(queue.convert, 'owner', first_payload, 'image', run)
        assert started.wait(1)
        second = pool.submit(queue.convert, 'owner', second_payload, 'image', run)
        deadline = time.monotonic() + 1
        while len(queue.requests) != 2 and time.monotonic() < deadline:
            time.sleep(.01)
        queue.cancel('owner', first_payload['request_id'])
        assert not stopped.is_set()
        queue.cancel('owner', second_payload['request_id'])
        assert stopped.is_set()
        finish.set()
        for result in (first, second):
            with pytest.raises(ValueError, match='取消'):
                result.result(2)
    assert queue.jobs == {} and queue.requests == {}


def test_cancel_before_registration_and_bounded_pending():
    queue = OfficeConversions(pending=1)
    payload = request()
    queue.cancel('owner', payload['request_id'])
    with pytest.raises(ValueError, match='取消'):
        queue.convert('owner', payload, 'image', lambda _: pytest.fail('cancelled request ran'))
    started, finish = threading.Event(), threading.Event()
    def run(job):
        started.set()
        assert finish.wait(3)
        return {'data': 'cGRm'}
    with ThreadPoolExecutor(1) as pool:
        first = pool.submit(queue.convert, 'owner', request(), 'image', run)
        assert started.wait(1)
        with pytest.raises(ResourceUnavailable):
            queue.convert('another', request(b'other'), 'image', run)
        finish.set()
        first.result(2)
