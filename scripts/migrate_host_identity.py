"""Offline 6.1.0 host identity migration on the Linux Docker host."""

import argparse
from contextlib import closing
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
from tempfile import NamedTemporaryFile
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services/sandbox-manager'))
from runtime_names import MAX_USER_ID, match_owner_id


LEGACY_OWNER = re.compile(r'000000:([1-9][0-9]{0,18})')
NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}')
CONTAINER_ID = re.compile(r'[0-9a-f]{64}')
FIELDS = {'old_owner_id', 'new_owner_id', 'workspace_id', 'generation', 'instance_id'}
BASELINE_PROOF = 'legacy-platform-baseline.json'
BASELINE_PATCH = 'legacy-platform-baseline.patch.yml'


def manifest_entries(path):
    rows = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(rows, list) or not rows:
        raise ValueError('Expected a nonempty schema migration manifest')
    for row in rows:
        if not isinstance(row, dict) or row.keys() != FIELDS:
            raise ValueError('Unexpected manifest fields')
        old = row['old_owner_id']
        match = LEGACY_OWNER.fullmatch(old) if isinstance(old, str) else None
        if (not match or not match_owner_id(row['new_owner_id']) or row['new_owner_id'] != 'gxzs-' + match[1]
                or str(UUID(row['workspace_id'])) != row['workspace_id'] or not NAME.fullmatch(row['instance_id'])
                or type(row['generation']) is not int or not 0 < row['generation'] < MAX_USER_ID):
            raise ValueError('Invalid manifest identity')
    for key in FIELDS - {'generation'}:
        if len({row[key] for row in rows}) != len(rows):
            raise ValueError(f'Duplicate manifest {key}')
    return sorted(rows, key=lambda row: row['workspace_id'])


def docker(*command, missing=False):
    result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *command],
                            capture_output=True, text=True, timeout=45, check=False)
    if not result.returncode:
        return result.stdout
    if missing and ('no such container' in result.stderr.lower() or 'no such object' in result.stderr.lower()):
        return None
    raise RuntimeError(f'Docker {command[0]} could not be verified')


def container(name):
    if not NAME.fullmatch(name):
        raise ValueError('Invalid container name in migration metadata')
    raw = docker('container', 'inspect', name, missing=True)
    if raw is None:
        return None
    item, = json.loads(raw)
    if not CONTAINER_ID.fullmatch(item['Id']):
        raise ValueError('Invalid Docker container identity')
    return item


def env_fields(item):
    return dict(part.split('=', 1) for part in item['Config']['Env'] if '=' in part)


def mount_name(item, destination):
    names = {mount.get('Name') for mount in item['Mounts']
             if mount['Type'] == 'volume' and mount['Destination'] == destination}
    if len(names) != 1 or not NAME.fullmatch(next(iter(names)) or ''):
        raise ValueError(f'Cannot verify the existing volume mounted at {destination}')
    return names.pop()


def host_plan(state, entry, default_prefix, docker_root):
    workspace, old, new = (entry[key] for key in ('workspace_id', 'old_owner_id', 'new_owner_id'))
    generation, instance = (entry[key] for key in ('generation', 'instance_id'))
    record = state / 'hosts' / workspace / 'host.json'
    if not record.resolve().is_relative_to(state) or record.is_symlink():
        raise ValueError('Host record is outside the manager state')
    current = json.loads(record.read_text(encoding='utf-8')) if record.is_file() else None
    if current is not None:
        if (current.get('owner_id') not in (old, new) or current.get('workspace_id') != workspace
                or current.get('generation') != generation or current.get('instance_id') != instance):
            raise ValueError('Host record disagrees with the migration manifest')
        if (current.get('profile_upgrade') or current.get('mcp_fence_pending')
                or current.get('state') in {'draining', 'fencing'}
                or (current.get('replacement') or {}).get('generation', generation) > generation):
            raise ValueError('Finish the existing host maintenance operation before migrating')
    elif not re.fullmatch(r'gxzs-migration-host-[0-9]+', instance):
        raise ValueError('No managed host or recognized migration host matches the manifest')

    desired = dict(current or {}, owner_id=new, workspace_id=workspace, generation=generation,
                   instance_id=instance, state='stopped', ready=False, endpoint='', initial_creation=False)
    host = container(desired.get('container_name') or instance)
    if host is not None:
        expected = {'GXZS_HOST_OWNER_ID':old, 'GXZS_HOST_GENERATION':str(generation),
                    'GXZS_HOST_INSTANCE_ID':instance, 'GXZS_SANDBOX_WORKSPACE_ID':workspace}
        actual = env_fields(host)
        if any(actual.get(key) != value for key, value in expected.items()):
            raise ValueError('Existing container is no longer the legacy host named by the manifest')
        home = mount_name(host, '/srv/dsh')
        if desired.get('home_volume', home) != home:
            raise ValueError('Host home volume disagrees with its stored binding')
        if desired.get('image_digest') and desired['image_digest'] != host['Image']:
            raise ValueError('Host image digest disagrees with its stored binding')
        desired['home_volume'] = home
        desired['image_digest'] = host['Image']
        sandbox_name = desired.get('sandbox_name') or actual.get('GXZS_SANDBOX_SSH_HOST') or default_prefix + '-' + workspace
        files = mount_name(host, '/workspace')
    elif current is None or not desired.get('home_volume'):
        raise ValueError('Cannot locate the legacy host home')
    else:
        sandbox_name = desired.get('sandbox_name') or default_prefix + '-' + workspace
        files = (desired.get('sandbox_volume_prefix') or sandbox_name) + '-files'
    if not files.endswith('-files'):
        raise ValueError('Cannot resolve the existing workspace volume prefix')
    prefix = files.removesuffix('-files')
    if desired.get('sandbox_volume_prefix', prefix) != prefix:
        raise ValueError('Stored sandbox volume prefix disagrees with its mounts')
    desired.update(sandbox_volume_prefix=prefix, sandbox_name=sandbox_name)
    sandbox = container(sandbox_name)
    if sandbox and (mount_name(sandbox, '/workspace') != files
                    or (sandbox['Config'].get('Labels') or {}).get('gxzs.workspace', workspace) != workspace):
        raise ValueError('Existing Sandbox belongs to another workspace')
    volumes = [desired['home_volume'], files, prefix + '-home', prefix + '-env']
    home_volume, = json.loads(docker('volume', 'inspect', desired['home_volume']))
    mount = Path(home_volume['Mountpoint']).resolve(strict=True)
    db = mount / 'workbench.sqlite3'
    if (home_volume['Driver'] != 'local' or not mount.is_relative_to(docker_root)
            or not db.is_file() or db.is_symlink()):
        raise ValueError('Cannot verify the Workbench SQLite in the registered Docker home volume')
    return record, desired, db, volumes, [item for item in (host, sandbox) if item is not None]


def identifier(name):
    return '"' + name.replace('"', '""') + '"'


def owner_tables(db):
    return [name for name, in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")
            if 'owner_id' in {col[1] for col in db.execute('PRAGMA table_info(' + identifier(name) + ')')}]


def directory_receipts(db, entry):
    old, new = entry['old_owner_id'], entry['new_owner_id']
    for owner, key, payload in db.execute("SELECT owner_id,workspace_id,plan_json FROM workspace_deletions "
                                         "WHERE workspace_id LIKE 'file:%'"):
        plan = json.loads(payload)
        path = plan.get('path')
        if plan.get('fileOnly') is not True or not isinstance(path, str) or not path or '\0' in path:
            raise ValueError('Invalid directory deletion receipt')
        expected = 'file:' + sha256((owner + '\0' + path).encode()).hexdigest()
        if key != expected:
            raise ValueError('Directory deletion receipt disagrees with its owner and path')
        if owner == old:
            yield ('file:' + sha256((new + '\0' + path).encode()).hexdigest(), key)


def verify_workbench(db, entry):
    if db.execute('SELECT version FROM schema_migrations').fetchall() != [(3,)]:
        raise ValueError('Unsupported Workbench SQLite schema')
    tables = owner_tables(db)
    if not {'chats', 'runs', 'platform_schedule_sync', 'workspace_deletions'} <= set(tables):
        raise ValueError('Incomplete Workbench SQLite ownership schema')
    owners = {owner for table in tables for owner, in db.execute(
        'SELECT DISTINCT owner_id FROM ' + identifier(table))}
    if owners - {entry['old_owner_id'], entry['new_owner_id']} or len(owners) > 1:
        raise ValueError('Workbench data belongs to multiple or unexpected owners')
    if db.execute("SELECT 1 FROM runs WHERE status IN ('queued','running','waiting_input','stopping') LIMIT 1").fetchone():
        raise ValueError('Drain active Workbench runs before migration')
    return tables, list(directory_receipts(db, entry))


def verify_admission(db, entries):
    owners = {row['old_owner_id'] for row in entries}
    remaining = {owner for owner, in db.execute('SELECT DISTINCT owner FROM task_admission') if not match_owner_id(owner)}
    if remaining - owners:
        raise ValueError('Manager admission contains a legacy owner missing from the manifest')
    for entry in entries:
        old, new = entry['old_owner_id'], entry['new_owner_id']
        if db.execute("SELECT 1 FROM task_admission WHERE owner IN (?,?) AND state<>'done' LIMIT 1", (old,new)).fetchone():
            raise ValueError('Drain active manager admission before migration')
        if db.execute('SELECT 1 FROM task_admission o JOIN task_admission n ON o.run=n.run '
                      'WHERE o.owner=? AND n.owner=? LIMIT 1', (old,new)).fetchone():
            raise ValueError('Manager admission identities collide')


def readonly(path):
    return sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)


def profile_identity(home, entry):
    """Validate the existing profile proof before handing its owner to the new identity."""
    directory = home / 'profiles' / 'workbench'
    if directory.resolve() != directory or (home / 'profiles').is_symlink():
        raise ValueError('Profile directory is outside the registered home')
    proof, baseline = directory / BASELINE_PROOF, directory / BASELINE_PATCH
    if proof.is_symlink() or baseline.is_symlink():
        raise ValueError('Profile baseline must not be a symbolic link')
    if not proof.exists():
        if baseline.exists():
            raise ValueError('Profile baseline has no identity proof')
        return None
    metadata = json.loads(proof.read_text(encoding='utf-8'))
    if (not isinstance(metadata, dict) or metadata.get('schemaVersion') != 1
            or metadata.get('ownerId') not in (entry['old_owner_id'], entry['new_owner_id'])
            or metadata.get('sourcePath') != '/opt/workbench/profiles/workbench/cordis.runtime.patch.yml'
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', str(metadata.get('imageId', '')))
            or not baseline.is_file()
            or sha256(baseline.read_bytes()).hexdigest() != metadata.get('baselineSha256')):
        raise ValueError('Profile baseline identity or content is invalid')
    return proof, dict(metadata, ownerId=entry['new_owner_id'])


def backup(path, destination):
    if destination.is_symlink():
        raise ValueError('Backup destination is a symbolic link')
    if destination.exists():
        return
    with NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
        stage = Path(handle.name)
    try:
        with closing(readonly(path)) as original, closing(sqlite3.connect(stage)) as copy:
            original.backup(copy)
            if copy.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('SQLite backup failed integrity check')
        stage.replace(destination)
    finally:
        stage.unlink(missing_ok=True)


def migrate_workbench(path, entry):
    with closing(sqlite3.connect(path)) as db, db:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN IMMEDIATE')
        tables, receipts = verify_workbench(db, entry)
        db.executemany('UPDATE workspace_deletions SET workspace_id=? WHERE workspace_id=?', receipts)
        for table in tables:
            db.execute('UPDATE ' + identifier(table) + ' SET owner_id=? WHERE owner_id=?',
                       (entry['new_owner_id'],entry['old_owner_id']))
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('Workbench owner migration violates a foreign key')


def migrate_admission(path, entries):
    with closing(sqlite3.connect(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        verify_admission(db, entries)
        for entry in entries:
            db.execute('UPDATE task_admission SET owner=? WHERE owner=?', (entry['new_owner_id'],entry['old_owner_id']))


def write_json(path, value, preserve=False):
    original = path.stat() if preserve else None
    with NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        stage = Path(handle.name)
    try:
        with stage.open('w', encoding='utf-8') as output:
            json.dump(value, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
        if original is not None:
            os.chmod(stage, original.st_mode)
            if hasattr(os, 'chown'):
                os.chown(stage, original.st_uid, original.st_gid)
        stage.replace(path)
    finally:
        stage.unlink(missing_ok=True)


def running_users(volumes):
    return {item for volume in volumes for item in docker('ps','--no-trunc','-q','--filter','volume='+volume).splitlines()}


def migrate(state, manager_name, prefix, entries, output, apply):
    manager = container(manager_name)
    if (manager is None or manager['State']['Running'] is not False
            or not any(Path(m['Source']).resolve() == state and m['Destination'] == '/state' for m in manager['Mounts'])):
        raise ValueError('The manager with the requested state mount must be stopped')
    docker_root = Path(docker('info','--format','{{.DockerRootDir}}').strip()).resolve(strict=True)
    if output.is_relative_to(state) or output.is_relative_to(docker_root):
        raise ValueError('Choose a separate, protected backup directory')
    pending = {row['workspace_id'] for row in entries}
    for record in (state/'hosts').glob('*/host.json'):
        current = json.loads(record.read_text(encoding='utf-8'))
        if not match_owner_id(current['owner_id']) and record.parent.name not in pending:
            raise ValueError('A manager host with legacy identity is missing from the manifest')
    plans = [host_plan(state,row,prefix,docker_root) for row in entries]
    volumes = [volume for plan in plans for volume in plan[3]]
    if len(set(volumes)) != len(volumes):
        raise ValueError('Migration workspaces share a volume')
    expected = {item['Id'] for plan in plans for item in plan[4]}
    if running_users(volumes) - expected:
        raise ValueError('An unrelated container uses a migration volume')
    admission = state/'admission.sqlite3'
    if not admission.is_file() or admission.is_symlink():
        raise ValueError('Cannot verify the manager admission database')
    with closing(readonly(admission)) as db:
        verify_admission(db, entries)
    for entry, plan in zip(entries,plans,strict=True):
        with closing(readonly(plan[2])) as db:
            verify_workbench(db, entry)
        profile_identity(plan[2].parent, entry)
    outcomes = state/'mcp-outcomes.sqlite3'
    if outcomes.is_symlink():
        raise ValueError('Manager outcomes database is a symbolic link')
    if outcomes.is_file():
        with closing(readonly(outcomes)) as db:
            if any(db.execute('SELECT 1 FROM unconfirmed_calls WHERE workspace=? LIMIT 1', (workspace,)).fetchone()
                   for workspace in pending):
                raise ValueError('Confirm outstanding tool stops before migration')
    if not apply:
        print(f'Validated {len(plans)} host mappings without changing them.')
        return

    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    manifest = output/'host-identity-manifest.json'
    if manifest.is_symlink():
        raise ValueError('Backup manifest is a symbolic link')
    if manifest.exists():
        if manifest_entries(manifest) != entries:
            raise ValueError('This backup directory belongs to a different migration')
    else:
        write_json(manifest, entries)
    for plan in plans:
        for item in plan[4]:
            if item['State']['Running']:
                docker('stop','--time','10',item['Id'])
    if running_users(volumes) or any(container(item)['State']['Running'] is not False for item in expected):
        raise ValueError('Runtime stop could not be confirmed')

    backup(admission,output/'admission.sqlite3')
    for entry, (record, desired, db, _, _) in zip(entries, plans, strict=True):
        folder = output/desired['workspace_id']
        if folder.is_symlink():
            raise ValueError('Backup workspace is a symbolic link')
        folder.mkdir(mode=0o700,exist_ok=True)
        if record.exists() and not (folder/'host.json').exists():
            original = json.loads(record.read_text(encoding='utf-8'))
            if original['owner_id'] != desired['owner_id']:
                write_json(folder/'host.json',original)
        backup(db, folder/'workbench.sqlite3')
        profile = profile_identity(db.parent, entry)
        if profile:
            for name in (BASELINE_PROOF, BASELINE_PATCH):
                destination = folder / name
                if destination.is_symlink():
                    raise ValueError('Profile backup is a symbolic link')
                if not destination.exists():
                    shutil.copy2(profile[0].parent / name, destination)
    migrate_admission(admission,entries)
    for entry,(record,desired,db,_,items) in zip(entries,plans,strict=True):
        migrate_workbench(db,entry)
        profile = profile_identity(db.parent, entry)
        if profile and json.loads(profile[0].read_text(encoding='utf-8')) != profile[1]:
            write_json(*profile, preserve=True)
        record.parent.mkdir(mode=0o750,parents=True,exist_ok=True)
        write_json(record,desired)
        for item in items:
            # Vacate the old name while retaining the stopped container and its volumes.
            docker('rename',item['Id'],item['Name'].lstrip('/')+'-previous-'+item['Id'][:12])
    print(f'Migrated {len(plans)} host identities. Use the backed-up manifest in GXZS migration 01.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manager-state',required=True,type=Path)
    parser.add_argument('--manager-container',required=True)
    parser.add_argument('--sandbox-prefix',default='dify-wb-dev')
    parser.add_argument('--manifest',required=True,type=Path)
    parser.add_argument('--backup-dir',required=True,type=Path)
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    try:
        migrate(args.manager_state.resolve(strict=True),args.manager_container,args.sandbox_prefix,
                manifest_entries(args.manifest),args.backup_dir.resolve(),args.apply)
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, RuntimeError) as error:
        parser.exit(1,f'Migration stopped: {error}\n')


if __name__ == '__main__':
    main()
