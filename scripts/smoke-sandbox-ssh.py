#!/usr/bin/env python3
"""Verify current manager SSH setup against an existing isolated sandbox."""
import ast
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tarfile
from types import SimpleNamespace


def docker(*args, stdin=None):
    return subprocess.run(['docker', *args], input=stdin, text=True,
                          capture_output=True, check=True, timeout=30)


def bridge_processes(container):
    """Count only disposable per-stream bridges, not the long-lived helper."""
    output = docker('top', container, '-eo', 'pid,args').stdout
    return sum("const net=require('node:net')" in line and '/tmp/dsh-ssh-' in line
               for line in output.splitlines())


AUTH_CHECK = r'''
import json
import os
from pathlib import Path
import shlex
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
        '-o', 'UserKnownHostsFile=' + str(known), 'gxzs@127.0.0.1', 'id -u']
    assert subprocess.check_output(command, timeout=10).strip() == b'1000', 'SSH owner identity mismatch'
    # Test the authenticated execution path, not only docker exec's image ENV.
    dependencies = "import sys,defusedxml,reportlab,pypdf,pptx,docx,openpyxl; assert sys.executable == '/opt/office/python/bin/python3'; print('ssh-office-python-ok')"
    command[-1] = 'python3 -c ' + shlex.quote(dependencies)
    assert subprocess.check_output(command, timeout=10).strip() == b'ssh-office-python-ok'
    command[-1] = 'node -e ' + shlex.quote("require('pptxgenjs'); require('sharp'); console.log('ssh-office-node-ok')")
    assert subprocess.check_output(command, timeout=10).strip() == b'ssh-office-node-ok'
    command[-1] = 'id -u'
    wrong = Path(directory) / 'wrong_id'
    subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(wrong)], check=True)
    command[command.index(str(key))] = str(wrong)
    assert subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=10).returncode != 0, 'SSH accepted an unauthorized key'
'''


def verify(container, host_image=None):
    long_seconds = int(os.environ.get('GXZS_SMOKE_LONG_SECONDS', '70'))
    if not 10 <= long_seconds <= 7200 or long_seconds % 10:
        raise ValueError('Invalid sustained probe duration')
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
        if host_image:
            # The host shares the disposable sandbox's network namespace and
            # fixture SSH keys; attachment checks also mount its dedicated home.
            ssh_folder = folder / 'ssh'
            (ssh_folder / 'known_hosts').write_text(known)
            (ssh_folder / 'config').write_text('Host fixture-sandbox\n  HostName 127.0.0.1\n'
                '  User gxzs\n  Port 2222\n  IdentityFile /home/gxzs/.ssh/id_ed25519\n'
                '  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n'
                '  UserKnownHostsFile /home/gxzs/.ssh/known_hosts\n')
            helper_hash = docker('exec', container, 'sha256sum',
                '/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js').stdout.split()[0]
            scripts = Path(__file__).resolve().parent
            attachment_args = []
            if os.environ.get('GXZS_SMOKE_NATIVE_ATTACHMENTS') == '1':
                info = json.loads(docker('inspect', container).stdout)[0]
                mount = next(item for item in info['Mounts'] if item['Destination'] == '/srv/dsh/attachments')
                assert mount['Type'] == 'volume' and mount['RW'] is False
                attachment_args = ['--mount', 'type=volume,source=' + mount['Name'] + ',destination=/srv/dsh',
                                   '-e', 'GXZS_SMOKE_DSH_HOME=/srv/dsh']
            legacy_args = []
            if os.environ.get('GXZS_SMOKE_LEGACY_PROFILE') == '1' and os.environ.get('GXZS_SMOKE_LEGACY_BASELINE'):
                baseline = Path(os.environ['GXZS_SMOKE_LEGACY_BASELINE'])
                assert baseline.is_absolute() and baseline.is_file() and not baseline.is_symlink()
                digest = hashlib.sha256(baseline.read_bytes()).hexdigest()
                assert digest == os.environ.get('GXZS_SMOKE_LEGACY_BASELINE_SHA256')
                image_id = os.environ.get('GXZS_SMOKE_LEGACY_IMAGE_ID', '')
                assert re.fullmatch(r'sha256:[a-f0-9]{64}', image_id)
                legacy_args = ['--mount', 'type=bind,source=' + str(baseline) + ',destination=/legacy-platform-baseline.patch.yml,readonly',
                               '-e', 'GXZS_SMOKE_LEGACY_BASELINE=/legacy-platform-baseline.patch.yml',
                               '-e', 'GXZS_SMOKE_LEGACY_BASELINE_SHA256=' + digest,
                               '-e', 'GXZS_SMOKE_LEGACY_IMAGE_ID=' + image_id]
            host = docker('create', '--network', 'container:' + container,
                    '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                    '--memory', '1g', '--cpus', '2', '--pids-limit', '256',
                    '-v', str(scripts) + ':/smoke:ro', '-e', 'GXZS_SANDBOX_SSH_HOST=fixture-sandbox',
                    '-e', 'GXZS_SANDBOX_HELPER_HASH=' + helper_hash,
                    '-e', 'GXZS_SMOKE_LONG_SECONDS=' + str(long_seconds),
                    *attachment_args, *legacy_args,
                    '--entrypoint', 'sleep', host_image, str(max(300, long_seconds + 240))).stdout.strip()
            try:
                # Preserve UID 1000 through the Docker archive API even when
                # the CI runner has another uid; never grant CHOWN to runtime.
                archive = io.BytesIO()
                with tarfile.open(fileobj=archive, mode='w') as tar:
                    entry = tarfile.TarInfo('.ssh')
                    entry.type, entry.mode, entry.uid, entry.gid = tarfile.DIRTYPE, 0o700, 1000, 1000
                    tar.addfile(entry)
                    for name in ('id_ed25519', 'config', 'known_hosts'):
                        data = (ssh_folder / name).read_bytes()
                        entry = tarfile.TarInfo('.ssh/' + name)
                        entry.size, entry.mode, entry.uid, entry.gid = len(data), 0o600, 1000, 1000
                        tar.addfile(entry, io.BytesIO(data))
                subprocess.run(['docker', 'cp', '-a', '-', host + ':/home/gxzs'],
                               input=archive.getvalue(), capture_output=True, check=True, timeout=20)
                docker('start', host)
                selected_scripts = ('smoke-host-bootstrap.mjs',) if os.environ.get('GXZS_SMOKE_BOOTSTRAP') == '1' else ('smoke-native-ssh.mjs', 'smoke-native-sandbox-tools.mjs')
                for script in selected_scripts:
                    before = bridge_processes(container)
                    extra = ['--changes-check', '--long-check'] if script == 'smoke-native-sandbox-tools.mjs' and os.environ.get('GXZS_SMOKE_EXTENDED') == '1' else []
                    if script == 'smoke-host-bootstrap.mjs':
                        extra = ['--real-ssh']
                        if os.environ.get('GXZS_SMOKE_FRESH_BOOTSTRAP') != '1':
                            extra.append('--session-create')
                        if os.environ.get('GXZS_SMOKE_LEGACY_PROFILE') == '1':
                            extra.append('--legacy-profile')
                        if os.environ.get('GXZS_SMOKE_CRASH') == '1':
                            extra.append('--crash-restart')
                        if os.environ.get('GXZS_SMOKE_RUNNING') == '1':
                            extra.append('--running-restart')
                        if attachment_args:
                            extra.append('--native-attachments')
                    result = subprocess.run(['docker', 'exec', host, 'node', '/smoke/' + script, *extra],
                                            text=True, capture_output=True, timeout=max(150, long_seconds + 90) if extra else 65)
                    print(result.stdout, end='')
                    if result.returncode:
                        # Inline modules can put many KiB of source in a stack URL.
                        # Compact those URLs before truncation so the actual cause survives.
                        diagnostics = re.sub(r'data:[^\s,]*;base64,[A-Za-z0-9+/=]+',
                                             '<inline-module>', result.stderr)
                        print(diagnostics[-4000:], file=sys.stderr, end='')
                        raise ValueError('Native SSH smoke failed: ' + script)
                    # Local bridge bookkeeping can be empty while an SSH remote
                    # command is still stuck. Assert against the sandbox PID
                    # namespace so the production leak is covered directly.
                    for _ in range(50):
                        after = bridge_processes(container)
                        if after == before:
                            break
                        import time
                        time.sleep(0.1)
                    assert after == before, f'Remote SSH bridges leaked: before={before}, after={after}'
            finally:
                docker('rm', '-f', host)
    print('PASS sandbox SSH: actual manager key setup; owner accepted; wrong key rejected; UID=1000 CapEff=0')


if __name__ == '__main__':
    try:
        if len(sys.argv) not in (2, 3):
            raise ValueError('Usage: smoke-sandbox-ssh.py CONTAINER_ID [HOST_IMAGE]')
        verify(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None)
    except subprocess.CalledProcessError as error:
        # Inputs contain fresh fixture keys; never print command arguments or input.
        print(f'FAIL sandbox SSH (exit={error.returncode}):\n{error.stdout or ""}{error.stderr or ""}', file=sys.stderr)
        raise SystemExit(1)
