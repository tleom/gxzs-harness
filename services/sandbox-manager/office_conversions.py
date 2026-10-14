"""Bounded, deduplicated offline conversions; no owner lock is held while Writer runs."""
from collections import OrderedDict
from concurrent.futures import Future, TimeoutError
import hashlib
import re
import threading
import time
import uuid

from resource_limits import ResourceUnavailable


class Conversion:
    def __init__(self):
        self.result = Future()
        self.readers = set()
        self.cancelled = threading.Event()
        self.stop = None


class OfficeConversions:
    def __init__(self, workers=2, pending=8, cache_bytes=64 * 1024 * 1024):
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(workers)
        self.pending_limit = pending
        self.cache_limit = cache_bytes
        self.cache_size = 0
        self.cache = OrderedDict()
        self.jobs = {}
        self.requests = {}
        self.cancelled_requests = {}
        self.owners = set()

    @staticmethod
    def request_id(value):
        try:
            return str(uuid.UUID(value))
        except (ValueError, TypeError, AttributeError) as error:
            raise ValueError('预览请求标识无效') from error

    def cancel(self, owner, request_id):
        request_id = self.request_id(request_id)
        stop = None
        with self.lock:
            now = time.monotonic()
            self.cancelled_requests = {key: until for key, until in self.cancelled_requests.items() if until > now}
            if len(self.cancelled_requests) >= 1024:
                self.cancelled_requests.pop(next(iter(self.cancelled_requests)))
            key = owner, request_id
            self.cancelled_requests[key] = now + 90
            job = self.requests.pop(key, None)
            if job:
                job.readers.discard(key)
                if not job.readers:
                    job.cancelled.set()
                    stop = job.stop
        if stop:
            stop()
        return {'cancelled': True}

    def convert(self, owner, payload, generation, run):
        request_id = self.request_id(payload.get('request_id') or str(uuid.uuid4()))
        request_key = owner, request_id
        name, data = payload.get('name'), payload.get('data')
        source_digest = payload.get('source_digest')
        if (not isinstance(name, str) or (not isinstance(data, str) and not isinstance(source_digest, str))
                or (isinstance(data, str) and len(data) > 28 * 1024 * 1024)):
            raise ValueError('文档内容无效或超过预览范围')
        digest = source_digest if data is None else hashlib.sha256(data.encode('ascii')).hexdigest()
        if not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('文档版本无效')
        cache_key = owner, generation, name.rpartition('.')[2].lower(), digest
        with self.lock:
            if self.cancelled_requests.get(request_key, 0) > time.monotonic():
                raise ValueError('文档预览已取消')
            if request_key in self.requests:
                raise ValueError('预览请求标识正在使用')
            cached = self.cache.pop(cache_key, None)
            if cached and time.monotonic() - cached[0] < 900:
                self.cache[cache_key] = cached
                return cached[1]
            if cached:
                self.cache_size -= cached[2]
            job = self.jobs.get(cache_key)
            leader = job is None
            if leader:
                if len(self.jobs) >= self.pending_limit:
                    raise ResourceUnavailable('文档预览繁忙，请稍后重试', code='OFFICE_PREVIEW_BUSY')
                job = Conversion()
                self.jobs[cache_key] = job
            job.readers.add(request_key)
            self.requests[request_key] = job
        try:
            if leader:
                admitted = False
                deadline = time.monotonic() + 10
                try:
                    while not admitted:
                        if job.cancelled.is_set():
                            raise ValueError('文档预览已取消')
                        if time.monotonic() > deadline:
                            raise ResourceUnavailable('文档预览繁忙，请稍后重试', code='OFFICE_PREVIEW_BUSY')
                        with self.lock:
                            if owner not in self.owners and self.slots.acquire(blocking=False):
                                self.owners.add(owner)
                                admitted = True
                        if not admitted:
                            job.cancelled.wait(.1)
                    output = run(job)
                    if job.cancelled.is_set():
                        raise ValueError('文档预览已取消')
                    output = {**output, 'generation': generation}
                    size = len(output.get('data', ''))
                    with self.lock:
                        if size <= self.cache_limit:
                            while self.cache and self.cache_size + size > self.cache_limit:
                                self.cache_size -= self.cache.popitem(last=False)[1][2]
                            self.cache[cache_key] = time.monotonic(), output, size
                            self.cache_size += size
                    job.result.set_result(output)
                except BaseException as error:
                    job.result.set_exception(error)
                finally:
                    if admitted:
                        with self.lock:
                            self.owners.discard(owner)
                            self.slots.release()
                    with self.lock:
                        self.jobs.pop(cache_key, None)
            while True:
                with self.lock:
                    if request_key not in job.readers:
                        raise ValueError('文档预览已取消')
                try:
                    return job.result.result(timeout=.1)
                except TimeoutError:
                    continue
        finally:
            with self.lock:
                self.requests.pop(request_key, None)
                job.readers.discard(request_key)
