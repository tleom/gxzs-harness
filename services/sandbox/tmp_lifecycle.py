"""Rotate the sandbox scratch directory; reclaim retired generations off the startup path."""
import errno
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import uuid

ROOT = '/var/lib/gxzs-tmp'
RETIRED = re.compile(r'retired-[0-9a-f]{32}\Z')


def rotate(root=ROOT):
    """Only rename/mkdir before services start, regardless of the old tree's size."""
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            current = os.stat('current', dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if current is not None:
            if not stat.S_ISDIR(current.st_mode):
                raise ValueError('Sandbox temporary root must be a directory')
            try:
                os.rename('current', 'retired-' + uuid.uuid4().hex, src_dir_fd=fd, dst_dir_fd=fd)
            except OSError as error:
                if error.errno != errno.EXDEV:
                    raise
                # OverlayFS cannot rename a directory from the image's lower
                # layer. The image seeds an empty current; rmdir is constant
                # work and refuses a nonempty directory. Later generations
                # are created in the writable layer and can be renamed.
                os.rmdir('current', dir_fd=fd)
        os.mkdir('current', mode=0o1777, dir_fd=fd)
        os.chmod('current', 0o1777, dir_fd=fd, follow_symlinks=False)
    finally:
        os.close(fd)


def cleanup(root=ROOT):
    # Startup never waits for this process. An interrupted cleanup is retried
    # on the next boot; the new current directory is never a deletion target.
    os.nice(19)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in os.listdir(fd):
            if not RETIRED.fullmatch(name):
                continue
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    shutil.rmtree(name, dir_fd=fd)
                else:
                    os.unlink(name, dir_fd=fd)
            except FileNotFoundError:
                pass
            except OSError:
                print('Sandbox temporary cleanup deferred', file=sys.stderr)
    finally:
        os.close(fd)


def start():
    rotate()
    try:
        subprocess.Popen([sys.executable, '-I', '-S', str(Path(__file__).resolve()), 'cleanup'],
                         stdin=subprocess.DEVNULL, close_fds=True, start_new_session=True)
    except OSError:
        # A full process table must not keep an otherwise ready sandbox offline.
        # Retired generations remain inaccessible and are retried on next boot.
        print('Sandbox temporary cleanup deferred', file=sys.stderr)


if __name__ == '__main__':
    if sys.argv[1:] == ['cleanup']:
        cleanup()
    else:
        start()
