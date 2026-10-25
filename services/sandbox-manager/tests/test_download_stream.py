"""Exercise the download copy loop on real files, including on Windows dev hosts."""
import os
import json
from pathlib import Path
import sys
import tracemalloc

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))
import file_download
import file_ops


@pytest.fixture
def source(tmp_path, monkeypatch):
    path = tmp_path / 'large.bin'
    native_open = os.open
    # Only adapt the POSIX directory descriptor at this test boundary. Production
    # traversal remains covered by the Linux symlink/traversal tests.
    for flag in ('O_NOFOLLOW', 'O_NONBLOCK'):
        if not hasattr(os, flag):
            monkeypatch.setattr(os, flag, 0, raising=False)
    def open_source(name, flags, *args, dir_fd=None, **kwargs):
        if dir_fd == -777:
            return native_open(path, os.O_RDONLY | getattr(os, 'O_BINARY', 0))
        return native_open(name, flags, *args, **kwargs) if dir_fd is None else native_open(name, flags, *args, dir_fd=dir_fd, **kwargs)
    monkeypatch.setattr(os, 'open', open_source)
    yield path
    path.unlink(missing_ok=True)


def test_download_larger_than_100_mib_uses_bounded_chunks_and_memory(source, record_property):
    size = 257 * 1024 * 1024 + 3
    with source.open('wb') as output:
        output.truncate(size)
    with source.open('rb') as input:
        expected = os.fstat(input.fileno())
    class Sink:
        total = 0
        largest = 0
        def write(self, chunk):
            self.total += len(chunk)
            self.largest = max(self.largest, len(chunk))
    sink = Sink()
    tracemalloc.start()
    try:
        file_download.copy_file(-777, source.name, sink, expected)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert sink.total == size
    assert sink.largest <= 64 * 1024
    assert peak < 2 * 1024 * 1024
    record_property('file_bytes', size)
    record_property('peak_python_bytes', peak)
    record_property('largest_write_bytes', sink.largest)


def test_cancelled_copy_closes_the_source_and_stops_reading(source, monkeypatch):
    source.write_bytes(b'x' * (256 * 1024))
    # Match the descriptor metadata used by copy_file; Windows path stat can
    # report a different ctime from fstat even for the same unchanged file.
    with source.open('rb') as stream:
        expected = os.fstat(stream.fileno())
    opened = []
    native_fdopen = os.fdopen
    def fdopen(*args, **kwargs):
        stream = native_fdopen(*args, **kwargs)
        opened.append(stream)
        return stream
    monkeypatch.setattr(os, 'fdopen', fdopen)
    class Cancelled:
        def write(self, _chunk):
            raise BrokenPipeError('download cancelled')
    with pytest.raises(BrokenPipeError):
        file_download.copy_file(-777, source.name, Cancelled(), expected)
    assert len(opened) == 1 and opened[0].closed


def test_large_file_metadata_allows_download_without_relaxing_in_memory_reads(source):
    with source.open('wb') as output:
        output.truncate(file_ops.MAX_BYTES + 1)
    for shallow in (False, True):
        metadata = file_ops.entry_metadata(-777, source.name, source.name, source.stat(), shallow=shallow)
        assert metadata['downloadable'] is True
    with pytest.raises(ValueError, match='100 MiB'):
        file_ops.read_file(-777, source.name)


@pytest.mark.parametrize('cancel', [False, True])
def test_large_download_snapshot_stream_and_temporary_cleanup(source, monkeypatch, cancel):
    with source.open('wb') as output:
        output.truncate(file_ops.MAX_BYTES + 1)
    native_stat, native_close = os.stat, os.close
    def stat_at(path, *args, dir_fd=None, **kwargs):
        if dir_fd == -777:
            with source.open('rb') as stream:
                return os.fstat(stream.fileno())
        return native_stat(path, *args, **kwargs) if dir_fd is None else native_stat(path, *args, dir_fd=dir_fd, **kwargs)
    monkeypatch.setattr(file_download, 'parent_fd', lambda *_args: (-777, source.name))
    monkeypatch.setattr(os, 'stat', stat_at)
    monkeypatch.setattr(os, 'close', lambda fd: None if fd == -777 else native_close(fd))
    class Sink:
        header = None
        total = 0
        def write(self, chunk):
            if self.header is None:
                self.header = json.loads(chunk)
            else:
                if cancel:
                    raise BrokenPipeError('download cancelled')
                assert len(chunk) <= 64 * 1024
                self.total += len(chunk)
        def flush(self):
            pass
    sink = Sink()
    tracemalloc.start()
    try:
        if cancel:
            with pytest.raises(BrokenPipeError):
                file_download.write_download({'path': source.name}, sink, str(source.parent))
        else:
            file_download.write_download({'path': source.name}, sink, str(source.parent))
            assert sink.total == sink.header['size'] == file_ops.MAX_BYTES + 1
        _, peak = tracemalloc.get_traced_memory()
        assert peak < 2 * 1024 * 1024
    finally:
        tracemalloc.stop()
    assert list(source.parent.iterdir()) == [source]
