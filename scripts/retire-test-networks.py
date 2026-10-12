"""Retire explicitly named legacy fault-test bridges, with all-container guards."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from uuid import UUID


def docker(*args, check=True):
    return subprocess.run(['docker', *args], text=True, capture_output=True, check=check, timeout=30)


def protected(manager):
    info = json.loads(docker('inspect', manager).stdout)[0]
    env = dict(value.split('=', 1) for value in info['Config']['Env'])
    root = env.get('WORKBENCH_MANAGER_STATE', '/state')
    code = "import json,pathlib,sys; print(json.dumps([json.loads(p.read_text())['workspace_id'] for p in (pathlib.Path(sys.argv[1])/'hosts').glob('*/host.json')]))"
    workspaces = {str(UUID(value)) for value in json.loads(docker('exec', manager, 'python', '-c', code, root).stdout)}
    prefix = env.get('WORKBENCH_SANDBOX_NETWORK', 'dify-workbench-sandboxes')
    return workspaces, {prefix + '-' + hashlib.sha256(value.encode()).hexdigest()[:16] for value in workspaces}, env.get('WORKBENCH_SANDBOX_PREFIX', 'dify-workbench')


def candidate(name, manager, expected_id=None):
    if not re.fullmatch(r'wb-(integration|recovery|postmerge)-fault-(qa|final)-20\d{6}', name):
        raise ValueError('Only explicitly named legacy fault-test bridges are eligible')
    info = json.loads(docker('network', 'inspect', name).stdout)[0]
    if expected_id and info['Id'] != expected_id:
        raise ValueError('Network identity changed after preparation')
    workspaces, names, prefix = protected(manager)
    labels = info.get('Labels') or {}
    if (info.get('Driver') != 'bridge' or info.get('Scope') != 'local' or info.get('Containers')
            or name in names or labels.get('gxzs.workspace') in workspaces or labels.get('workbench') == prefix):
        raise ValueError('Network is active, registered, or not a legacy test bridge')
    identifiers = docker('ps', '-aq').stdout.split()
    for index in range(0, len(identifiers), 128):
        containers = json.loads(docker('inspect', *identifiers[index:index + 128]).stdout)
        if any(name in (item.get('NetworkSettings', {}).get('Networks') or {})
               or any(network.get('NetworkID') == info['Id'] for network in
                      (item.get('NetworkSettings', {}).get('Networks') or {}).values()) for item in containers):
            raise ValueError('A container still references this network, including stopped containers')
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manager', default='gxzs-sandbox-manager')
    parser.add_argument('--network', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup-dir', type=Path)
    args = parser.parse_args()
    if len(set(args.network)) != len(args.network):
        parser.error('Duplicate network selection')
    prepared = [candidate(name, args.manager) for name in args.network]
    summary = {'networks': [{'name': item['Name'], 'id': item['Id'], 'subnets': item['IPAM']['Config']} for item in prepared],
               'all_container_references_checked': True, 'registered_owners_protected': True}
    if args.apply:
        if not args.backup_dir:
            parser.error('--apply requires --backup-dir')
        args.backup_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
        path = args.backup_dir / 'networks-before.json'
        path.write_text(json.dumps(prepared, indent=2), encoding='utf-8')
        os.chmod(path, 0o600)
        removed = []
        for item in prepared:
            candidate(item['Name'], args.manager, item['Id'])
            docker('network', 'rm', item['Id'])
            removed.append(item['Name'])
            (args.backup_dir / 'removed.json').write_text(json.dumps(removed), encoding='utf-8')
        summary['removed'] = removed
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
