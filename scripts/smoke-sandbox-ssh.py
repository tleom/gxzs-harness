#!/usr/bin/env python3
"""Verify current manager SSH setup against an existing isolated sandbox."""
import ast
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace


def docker(*args, stdin=None):
    return subprocess.run(['docker', *args], input=stdin, text=True,
                          capture_output=True, check=True, timeout=30)


AUTH_CHECK = r'''
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

fixture = json.load(sys.stdin)
assert os.getuid() == 1000, 'Sandbox is not running as its owner'
status = Path('/proc/self/status').read_text().splitlines()
assert int(next(line.split(':', 1)[1] for line in status if line.startswith('CapEff:')), 16) == 0
authorized = (Path.home() / '.ssh/authorized_keys').read_text().splitlines()
assert authorized.count(fixture['public'].strip()) == 1, 'Manager did not install exactly one owner key'
with tempfile.TemporaryDirectory(prefix='gxzs-ssh-smoke-') as directory:
    key = Path(directory) / 'id_ed25519'
    key.write_text(fixture['private'])
    key.chmod(0o600)
    known = Path(directory) / 'known_hosts'
    known.write_text(fixture['known_hosts'])
    command = ['ssh', '-p', '2222', '-i', str(key),
        '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
        '-o', 'UserKnownHostsFile=' + str(known), 'dify@127.0.0.1', 'id -u']
    assert subprocess.check_output(command, timeout=10).strip() == b'1000', 'SSH owner identity mismatch'
    wrong = Path(directory) / 'wrong_id'
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(wrong)], check=True)
    command[command.index(str(key))] = str(wrong)
    assert subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=10).returncode != 0, 'SSH accepted an unauthorized key'
'''


def verify(container):
    if not re.fullmatch(r'[0-9a-f]{64}', container):
        raise ValueError('Expected the full ID of the disposable smoke container')
    source = Path(__file__).resolve().parents[1] / 'services/sandbox-manager/hosts.py'
    tree = ast.parse(source.read_text(encoding='utf-8'))
    host_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Hosts')
    method = next(node for node in host_class.body if isinstance(node, ast.FunctionDef) and node.name == '_ssh')
    # Execute the unchanged production method without constructing the manager
    # or importing its environment. Docker remains on the CI host; no socket is
    # exposed to the sandbox under test.
    with tempfile.TemporaryDirectory(prefix='gxzs-manager-ssh-smoke-') as directory:
        folder = Path(directory).resolve()

        def host_chown(target, uid, gid):
            # CI runners need not have UID 1000 or permission to chown. Only
            # these host-side temporary files are exempted; container commands
            # and permissions are exercised exactly as production executes them.
            assert Path(target).resolve().is_relative_to(folder)
            assert (uid, gid) == (1000, 1000)

        def manager_docker(*args, **kwargs):
            assert args[0] == 'exec' and container in args
            return docker(*args, **kwargs)

        scope = {'Path': Path, 'subprocess': subprocess,
                 'os': SimpleNamespace(chown=host_chown, chmod=os.chmod,
                     environ={**os.environ, 'GXZS_SANDBOX_SSH_PORT': '2222'})}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])),
                     str(source), 'exec'), scope)
        manager = SimpleNamespace(docker=manager_docker)
        scope['_ssh'](manager, folder, container)
        scope['_ssh'](manager, folder, container)
        key = folder / 'ssh/id_ed25519'
        known = (folder / 'ssh/known_hosts').read_text()
        assert known.startswith(f'[{container}]:2222 ssh-ed25519 ')
        # The fixture's loopback connection uses the host key read by the real
        # manager. Only the address changes inside this network-isolated test.
        known = known.replace(f'[{container}]:2222 ', '[127.0.0.1]:2222 ', 1)
        docker('exec', '-i', container, '/usr/local/bin/python', '-I', '-S', '-c', AUTH_CHECK,
               stdin=json.dumps({'private': key.read_text(), 'public': key.with_suffix('.pub').read_text(),
                                 'known_hosts': known}))
    print('PASS sandbox SSH: actual manager key setup; owner accepted; wrong key rejected; UID=1000 CapEff=0')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: smoke-sandbox-ssh.py CONTAINER_ID')
        verify(sys.argv[1])
    except subprocess.CalledProcessError as error:
        # Inputs contain fresh fixture keys; never print command arguments or input.
        print(f'FAIL sandbox SSH (exit={error.returncode}):\n{error.stdout or ""}{error.stderr or ""}', file=sys.stderr)
        raise SystemExit(1)
