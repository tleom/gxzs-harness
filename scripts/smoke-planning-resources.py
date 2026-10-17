"""Verify real readonly skill copying into an inspection container without capabilities."""
import json
import subprocess
import sys

manager_image, sandbox_image = sys.argv[1:]
def docker(*args):
    try:
        return subprocess.check_output(['docker', *args], stderr=subprocess.PIPE, timeout=60)
    except subprocess.CalledProcessError as error:
        print(error.stderr.decode(errors='replace')[-2000:], file=sys.stderr)
        raise
containers = []
def inspection(readonly=True):
    isolated = ['--read-only', '--tmpfs', '/opt/workbench-global:rw,nosuid,nodev,noexec,size=256m,mode=0755'] if readonly else []
    identifier = docker('run', '-d', '--network', 'none', *isolated, '--user', '1000',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '1',
        '--pids-limit', '64',
        '--entrypoint', '/bin/sleep', sandbox_image, '120').decode().strip()
    containers.append(identifier)
    return identifier
try:
    source, destination = inspection(False), inspection()
    docker('exec', '--user', '0', source, '/usr/local/bin/python', '-I', '-S', '-c',
        "from pathlib import Path; p=Path('/opt/workbench-global/skills/readonly-fixture/nested'); "
        "p.mkdir(parents=True); f=p/'SKILL.md'; f.write_text('readonly fixture'); f.chmod(0o444); "
        "[(d.chmod(0o555)) for d in (p,p.parent,p.parent.parent)]")
    docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m',
        '-v', '/var/run/docker.sock:/var/run/docker.sock', '--entrypoint', 'python', manager_image,
        '-I', '-S', '-c', "import sys;sys.path.insert(0,'/app');from planning import copy_global_resources;"
        "copy_global_resources(sys.argv[1],sys.argv[2],('/usr/local/bin/python','-I','-S'))", source, destination)
    docker('exec', '--user', '1000', destination, '/usr/local/bin/python', '-I', '-S', '-c',
        "import os,pathlib; p=pathlib.Path('/opt/workbench-global/skills/readonly-fixture/nested/SKILL.md'); "
        "assert p.read_text(); assert p.stat().st_uid==0; assert not os.access(p,os.W_OK); "
        "assert not os.access(p.parent,os.W_OK)")
    info = json.loads(docker('inspect', destination))[0]
    assert info['HostConfig']['ReadonlyRootfs'] and info['HostConfig']['CapDrop']==['ALL']
    print('Readonly planning resources copied without adding capabilities')
finally:
    for identifier in reversed(containers):
        docker('rm', '-f', identifier)
