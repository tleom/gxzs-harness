"""Read live container state without spawning a Docker CLI for every lease check."""
import http.client
import json
import os
import socket
import subprocess
from pathlib import Path
from urllib.parse import quote


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def inspect_local(args, timeout):
    # Other commands and explicitly selected Docker endpoints keep CLI semantics.
    # An inspect miss also falls back: plain `docker inspect` can address images.
    if (len(args) != 2 or args[0] != 'inspect' or args[1].startswith('-')
            or os.environ.get('DOCKER_HOST', '') not in ('', 'unix:///var/run/docker.sock')
            or os.environ.get('DOCKER_CONTEXT', '') not in ('', 'default')
            or os.environ.get('DOCKER_CONFIG')
            or (Path.home() / '.docker' / 'config.json').exists()):
        return None
    connection = UnixConnection('localhost', timeout=timeout)
    try:
        connection.request('GET', '/containers/' + quote(args[1], safe='') + '/json')
        response = connection.getresponse()
        if response.status == 404:
            return None
        if response.status != 200:
            raise RuntimeError('Docker container inspection failed: HTTP ' + str(response.status))
        limit = 8 * 1024 * 1024
        body = response.read(limit + 1)
        if len(body) > limit:
            raise RuntimeError('Docker container inspection exceeded response limit')
        value = json.loads(body)
        if not isinstance(value, dict) or not isinstance(value.get('Id'), str):
            raise RuntimeError('Invalid Docker container inspection response')
        return subprocess.CompletedProcess(['docker', *args], 0, json.dumps([value]), '')
    except (OSError, http.client.HTTPException, ValueError, RuntimeError) as error:
        # Daemon bodies and transport messages may contain sensitive metadata.
        return subprocess.CompletedProcess(['docker', *args], 1, '',
                                           'Docker container inspection failed (' + type(error).__name__ + ')')
    finally:
        connection.close()
