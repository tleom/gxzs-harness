#!/usr/bin/env python3
"""Read-only, bounded storage accounting on the Linux Docker daemon host.

No server imports, file contents (except host records), container exec, writes,
volume creation, deletion, or automatic retention. JSON is emitted to stdout.
"""
import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import time
from uuid import UUID


SCHEMA = 'gxzs-storage-inventory-v1'
VOLUME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{1,200}')


class BudgetExceeded(Exception):
    pass


class Budget:
    def __init__(self, entries=100000, seconds=30, depth=64):
        self.limit, self.seconds, self.depth = entries, seconds, depth
        self.used = 0
        self.started = time.monotonic()

    def remaining(self):
        left = self.seconds - (time.monotonic() - self.started)
        if left <= 0:
            raise BudgetExceeded('time_budget')
        return left

    def step(self):
        self.remaining()
        if self.used >= self.limit:
            raise BudgetExceeded('entry_budget')
        self.used += 1


def open_directory(path):
    """Reject symlinks in every component, including an administratively supplied root."""
    path = Path(os.path.abspath(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_json(path, maximum):
    parent = open_directory(Path(path).parent)
    try:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError('not_regular')
            raw = stream.read(maximum + 1)
            if len(raw) > maximum:
                raise ValueError('too_large')
            def reject_constant(_):
                raise ValueError('nonfinite_json')
            return json.loads(raw, parse_constant=reject_constant)
    finally:
        os.close(parent)


def scan(path, budget, exclude=()):
    """Metadata-only traversal; hard links count once per root, links are not followed."""
    counts = dict(apparent_bytes=0, allocated_bytes=0, inodes=0, files=0,
                  directories=0, symlinks=0, special=0, hardlink_duplicates=0)
    reasons, seen = Counter(), set()
    result = {'status': 'complete', 'counts': counts, 'excluded_top_level': list(exclude)}

    def account(info):
        key = (info.st_dev, info.st_ino)
        if key in seen:
            counts['hardlink_duplicates'] += 1
            return False
        seen.add(key)
        counts['inodes'] += 1
        counts['allocated_bytes'] += info.st_blocks * 512
        if stat.S_ISREG(info.st_mode):
            counts['files'] += 1
            counts['apparent_bytes'] += info.st_size
        elif stat.S_ISDIR(info.st_mode):
            counts['directories'] += 1
        elif stat.S_ISLNK(info.st_mode):
            counts['symlinks'] += 1
        else:
            counts['special'] += 1
        return True

    def walk(fd, depth, device):
        before = os.fstat(fd)
        with os.scandir(fd) as entries:
            for entry in entries:
                budget.step()
                if depth == 0 and entry.name in exclude:
                    continue
                try:
                    info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                    if info.st_dev != device:
                        reasons['different_device'] += 1
                        continue
                    if not account(info) or not stat.S_ISDIR(info.st_mode):
                        continue
                    if depth >= budget.depth:
                        reasons['depth_budget'] += 1
                        continue
                    child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        opened = os.fstat(child)
                        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                            reasons['changed_during_scan'] += 1
                        else:
                            walk(child, depth + 1, device)
                    finally:
                        os.close(child)
                except OSError as error:
                    reasons['os_error_' + str(error.errno)] += 1
        after = os.fstat(fd)
        if (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
            reasons['changed_during_scan'] += 1

    try:
        budget.step()
        fd = open_directory(path)
        try:
            info = os.fstat(fd)
            result['root_identity'] = [info.st_dev, info.st_ino]
            fs = os.fstatvfs(fd)
            result['filesystem'] = {'available_bytes': fs.f_bavail * fs.f_frsize,
                                    'available_inodes': fs.f_favail if fs.f_files else None}
            account(info)
            walk(fd, 0, info.st_dev)
        finally:
            os.close(fd)
    except BudgetExceeded as error:
        reasons[str(error)] += 1
    except OSError as error:
        reasons['os_error_' + str(error.errno)] += 1
    result['reasons'] = dict(reasons)
    if reasons:
        result['status'] = 'partial'
    return result


def inspect_volume(name, socket, timeout):
    # Explicit local endpoint: never inherit a remote DOCKER_HOST/context and
    # accidentally attribute a same-named local path to a remote volume.
    result = subprocess.run(['docker', '--host', 'unix://' + socket, 'volume', 'inspect', name],
                            capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise ValueError('volume_unavailable')
    values = json.loads(result.stdout)
    if not isinstance(values, list) or len(values) != 1:
        raise ValueError('invalid_volume')
    value = values[0]
    if (value.get('Name') != name or value.get('Driver') != 'local' or value.get('Options')
            or not os.path.isabs(value.get('Mountpoint', '')) or not value.get('CreatedAt')):
        # Remote/bind/plugin volumes need a storage-specific accounting source.
        raise ValueError('unsupported_volume')
    return {'mountpoint': value['Mountpoint'], 'created_at': value['CreatedAt'],
            'owner_label': (value.get('Labels') or {}).get('gxzs.owner')}


def inventory(state, prefix, workspaces, all_owners, max_owners, socket, budget, inspect=inspect_volume):
    started = time.time()
    roots, issues, bindings = [], [], {}
    unrecognized = 0
    registry = Path(state) / 'hosts'
    selected = list(dict.fromkeys(workspaces))
    try:
        if all_owners:
            fd = open_directory(registry)
            try:
                with os.scandir(fd) as entries:
                    for entry in entries:
                        budget.step()
                        try:
                            workspace = str(UUID(entry.name))
                            if workspace != entry.name:
                                raise ValueError()
                        except ValueError:
                            unrecognized += 1
                            continue
                        if len(selected) >= max_owners:
                            issues.append({'reason': 'owner_budget'})
                            break
                        selected.append(workspace)
            finally:
                os.close(fd)
    except (OSError, BudgetExceeded) as error:
        issues.append({'reason': str(error) if isinstance(error, BudgetExceeded) else 'registry_unavailable'})
    if unrecognized:
        issues.append({'reason': 'unrecognized_registry_entry', 'count': unrecognized})
    for workspace in sorted(selected):
        try:
            budget.step()
            record = read_json(registry / workspace / 'host.json', 65536)
            owner = record['owner_id']
            if (record['workspace_id'] != workspace or not isinstance(owner, str)
                    or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}:[0-9]{1,64}', owner)):
                raise ValueError('invalid_owner_record')
            # Same authority/fallback as ensure_sandbox and hosts._create.
            volumes = record.get('sandbox_volume_prefix') or record.get('sandbox_name') or prefix + '-' + workspace
            names = {'host_home': record.get('home_volume'), 'sandbox_home': volumes + '-home',
                     'workspace': volumes + '-files', 'environment': volumes + '-env'}
            if any(not isinstance(name, str) or not VOLUME.fullmatch(name) for name in names.values()):
                raise ValueError('invalid_volume_name')
            bindings[workspace] = {key: record.get(key) for key in
                                   ('owner_id', 'workspace_id', 'home_volume', 'sandbox_volume_prefix', 'sandbox_name')}
            for category, name in names.items():
                roots.append({'owner_id': owner, 'workspace_id': workspace, 'category': category, 'volume': name})
            roots.append({'owner_id': owner, 'workspace_id': workspace, 'category': 'manager_owner_state',
                          'path': str(registry / workspace)})
        except (OSError, ValueError, KeyError, TypeError, BudgetExceeded) as error:
            issues.append({'workspace_id': workspace, 'reason':
                           str(error) if isinstance(error, BudgetExceeded) else 'invalid_or_unavailable_record'})
    references = Counter(root['volume'] for root in roots if 'volume' in root)
    roots.append({'owner_id': None, 'workspace_id': None, 'category': 'manager_shared_state',
                  'path': str(Path(state)), 'exclude': ['hosts']})
    for root in roots:
        root['observed_at'] = time.time()
        try:
            budget.remaining()
            if 'volume' in root:
                if references[root['volume']] > 1:
                    raise ValueError('ambiguous_shared_volume')
                value = inspect(root['volume'], socket, min(5, budget.remaining()))
                if value.get('owner_label') and value['owner_label'] != root['owner_id']:
                    raise ValueError('volume_owner_mismatch')
                root['path'], root['volume_created_at'] = value['mountpoint'], value['created_at']
            root.update(scan(root['path'], budget, root.get('exclude', ())))
        except BudgetExceeded as error:
            root.update(status='partial', reasons={str(error): 1})
        except subprocess.TimeoutExpired:
            root.update(status='partial', reasons={'docker_timeout': 1})
        except (OSError, ValueError, TypeError, AttributeError) as error:
            safe_reasons = {'volume_unavailable', 'invalid_volume', 'unsupported_volume',
                            'ambiguous_shared_volume', 'volume_owner_mismatch'}
            reason = str(error) if type(error) is ValueError and str(error) in safe_reasons else 'volume_inspection_failed'
            root.update(status='partial', reasons={reason: 1})
        root['finished_at'] = time.time()
    for workspace, binding in bindings.items():
        try:
            budget.step()
            latest = read_json(registry / workspace / 'host.json', 65536)
            if {key: latest.get(key) for key in binding} != binding:
                raise ValueError('binding_changed')
        except (OSError, ValueError, TypeError, AttributeError, BudgetExceeded):
            issues.append({'workspace_id': workspace, 'reason': 'binding_not_confirmed_after_scan'})
    owners = []
    for owner in sorted({root['owner_id'] for root in roots if root['owner_id']}):
        items = [root for root in roots if root['owner_id'] == owner]
        owners.append({'owner_id': owner, 'status': 'complete' if not issues and all(r['status'] == 'complete' for r in items) else 'partial',
                       'observed_counts': {key: sum(r.get('counts', {}).get(key, 0) for r in items)
                                           for key in ('apparent_bytes', 'allocated_bytes', 'inodes')}})
    return {'schema': SCHEMA, 'started_at': started, 'finished_at': time.time(),
            'scope': {'state': str(Path(state)), 'docker_socket': socket, 'sandbox_prefix': prefix,
                      'selection': 'all' if all_owners else 'explicit', 'workspaces': sorted(selected)},
            'budget': {'entries': budget.limit, 'seconds': budget.seconds, 'depth': budget.depth,
                       'max_owners': max_owners, 'entries_used': budget.used},
            'status': 'partial' if issues or any(r['status'] != 'complete' for r in roots) else 'complete',
            'issues': issues, 'owners': owners, 'roots': roots}


def compare(current, previous):
    """Never turn a partial scan, replaced volume or scope change into a growth rate."""
    if not isinstance(previous, dict):
        return {'status': 'unavailable', 'reason': 'invalid_previous_snapshot'}
    if previous.get('schema') != SCHEMA or previous.get('scope') != current['scope']:
        return {'status': 'unavailable', 'reason': 'schema_or_scope_changed'}
    if previous.get('status') != 'complete' or current['status'] != 'complete':
        return {'status': 'unavailable', 'reason': 'partial_inventory'}
    if not isinstance(previous.get('roots'), list):
        return {'status': 'unavailable', 'reason': 'invalid_previous_snapshot'}
    for root in previous['roots']:
        if not isinstance(root, dict) or root.get('status') != 'complete' or not isinstance(root.get('counts'), dict):
            return {'status': 'unavailable', 'reason': 'invalid_previous_snapshot'}
        for name in ('apparent_bytes', 'allocated_bytes', 'inodes'):
            value = root['counts'].get(name)
            if type(value) is not int or not 0 <= value <= 2 ** 127:
                return {'status': 'unavailable', 'reason': 'invalid_previous_snapshot'}
        for name in ('observed_at', 'finished_at'):
            value = root.get(name)
            if type(value) not in (int, float) or not 0 <= value <= 2 ** 53 or not math.isfinite(value):
                return {'status': 'unavailable', 'reason': 'invalid_previous_snapshot'}
        if root['observed_at'] > root['finished_at']:
            return {'status': 'unavailable', 'reason': 'invalid_previous_snapshot'}
    def key(root):
        return (root['owner_id'], root['workspace_id'], root['category'])
    before = {key(root): root for root in previous['roots']}
    if len(before) != len(previous['roots']) or set(before) != {key(r) for r in current['roots']}:
        return {'status': 'unavailable', 'reason': 'root_set_changed'}
    output = []
    for root in current['roots']:
        old = before[key(root)]
        identity = ('path', 'volume', 'volume_created_at', 'root_identity', 'excluded_top_level')
        interval = root['observed_at'] - old['observed_at']
        if (any(root.get(k) != old.get(k) for k in identity) or not math.isfinite(interval) or interval <= 0
                or root['observed_at'] <= old['finished_at']):
            return {'status': 'unavailable', 'reason': 'identity_or_time_changed'}
        delta = {k: root['counts'][k] - old['counts'][k] for k in ('apparent_bytes', 'allocated_bytes', 'inodes')}
        output.append({'owner_id': root['owner_id'], 'workspace_id': root['workspace_id'], 'category': root['category'],
                       'interval_seconds': interval, 'delta': delta,
                       'per_day': {k: v * 86400 / interval for k, v in delta.items()}})
    return {'status': 'available', 'roots': output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, help='Manager STATE path on the Docker host')
    parser.add_argument('--sandbox-prefix', required=True, help='Actual WORKBENCH_SANDBOX_PREFIX')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--workspace', action='append', default=[], type=lambda v: str(UUID(v)))
    group.add_argument('--all', action='store_true', dest='all_owners')
    parser.add_argument('--max-owners', type=int, default=100)
    parser.add_argument('--max-entries', type=int, default=100000)
    parser.add_argument('--max-seconds', type=float, default=30)
    parser.add_argument('--max-depth', type=int, default=64)
    parser.add_argument('--docker-socket', default='/var/run/docker.sock')
    parser.add_argument('--previous', help='Previous JSON snapshot, at most 8 MiB')
    args = parser.parse_args()
    if os.name != 'posix' or not hasattr(os, 'O_NOFOLLOW'):
        parser.error('Run on the Linux Docker daemon host')
    if (not 1 <= args.max_owners <= 1000 or len(set(args.workspace)) > args.max_owners
            or not 1 <= args.max_entries <= 10000000 or not 0 < args.max_seconds <= 3600
            or not 1 <= args.max_depth <= 128 or not os.path.isabs(args.state)
            or not os.path.isabs(args.docker_socket) or not VOLUME.fullmatch(args.sandbox_prefix)):
        parser.error('Invalid paths or budget (owners <= 1000, entries <= 10M, seconds <= 3600, depth <= 128)')
    result = inventory(os.path.abspath(args.state), args.sandbox_prefix, args.workspace, args.all_owners,
                       args.max_owners, args.docker_socket, Budget(args.max_entries, args.max_seconds, args.max_depth))
    if args.previous:
        try:
            result['growth'] = compare(result, read_json(args.previous, 8 * 1024 * 1024))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            result['growth'] = {'status': 'unavailable', 'reason': 'invalid_previous_snapshot'}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2))
    return 0 if result['status'] == 'complete' else 2


if __name__ == '__main__':
    raise SystemExit(main())
