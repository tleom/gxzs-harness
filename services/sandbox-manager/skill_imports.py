"""Owner-local staged uploads and durable publication receipts.

The manager reuses MCP's supervisor for execution and fencing. A per-import
flock proves that recovery cannot race a live installer; inode identities
distinguish an unpublished new tree from an exchanged old package.
"""
from contextlib import contextmanager
import fcntl
import json
import os
import re
import stat
import time
import tempfile
import uuid

from file_ops import read_file, version
from resource_ops import (atomic_write, directory, discard_staging,
                          members, package_version, rename_directory,
                          resource_directory, safe_name, skill_text)

TERMINAL = {'completed', 'cancelled', 'failed', 'conflict'}
STAGING_RETENTION = 24 * 60 * 60
RECEIPT_RETENTION = 7 * 24 * 60 * 60
SWEEP_INTERVAL = 300
MAX_SKILL_JSON_BYTES = 140 * 1024 * 1024  # 100 MiB plus Base64 and JSON framing.


class SkillImportFailure(Exception):
    """Preserve a confirmed terminal outcome across the legacy HTTP wrapper."""
    def __init__(self, result):
        status = result.get('status')
        self.http_status, self.code, message = {
            'failed': (400, 'SKILL_IMPORT_FAILED', '技能导入失败'),
            'cancelled': (409, 'SKILL_IMPORT_CANCELLED', '技能导入已停止'),
            'conflict': (409, 'RESOURCE_CONFLICT', '技能已修改，请重新导入'),
        }.get(status, (503, 'SKILL_IMPORT_UNCERTAIN', '导入结果待确认，请刷新技能列表后重试查询'))
        self.import_id = result.get('import_id')
        super().__init__(result.get('error') or message)


def import_id(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{32}', value):
        raise ValueError('技能导入标识无效')
    return value


def identity(info):
    return [info.st_dev, info.st_ino]


def entry_identity(fd, name):
    try:
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        return identity(info) if stat.S_ISDIR(info.st_mode) else None
    except FileNotFoundError:
        return None


class Store:
    def __init__(self, root, token):
        self.root = root
        self.token = import_id(token)
        self.fds = []

    def __enter__(self):
        try:
            self.rootfd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            self.fds.append(self.rootfd)
            parent = self._directory(self.rootfd, '.skill-imports')
            self.fds.append(parent)
            self.pending = self._directory(parent, '.pending')
            self.fds.append(self.pending)
            self.fd = self._directory(parent, self.token)
            self.fds.append(self.fd)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        for fd in reversed(self.fds):
            os.close(fd)

    @staticmethod
    def _directory(parent, name):
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        else:
            os.fsync(parent)
        return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)

    def track(self, active=True):
        if active:
            try:
                fd = os.open(self.token, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=self.pending)
            except FileExistsError:
                return
            os.close(fd)
        else:
            try:
                os.unlink(self.token, dir_fd=self.pending)
            except FileNotFoundError:
                return
        os.fsync(self.pending)

    @contextmanager
    def lock(self, name='state.lock', *, blocking=True):
        fd = os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:
                yield False
                return
            yield True
        finally:
            os.close(fd)

    def read(self):
        raw = read_file(self.fd, 'state.json')
        return json.loads(raw) if raw else {'import_id': self.token, 'status': 'pending'}

    def save(self, state):
        # All callers hold state.lock. Index before the receipt so a crash can
        # leave an extra recovery candidate, never an untracked publication.
        self.track()
        state['updated_at'] = time.time()
        if state['status'] in TERMINAL:
            state.setdefault('terminal_at', state['updated_at'])
        atomic_write(self.fd, 'state.json', json.dumps(state).encode())

    def cleanup(self, state):
        """A cleanup error cannot change the authoritative terminal outcome."""
        if state['status'] not in TERMINAL:
            return
        try:
            self.remove_body()
        except OSError:
            if not state.get('cleanup_pending'):
                state['cleanup_pending'] = True
                try:
                    self.save(state)
                except OSError:
                    pass  # The existing pending index still schedules a retry.
            return
        if state.pop('cleanup_pending', None):
            try:
                self.save(state)
            except OSError:
                return
        try:
            self.track(False)
        except OSError:
            pass

    def cancelled(self):
        return read_file(self.fd, 'cancel', max_bytes=1) is not None

    def remove_body(self):
        changed = False
        for name in os.listdir(self.fd):
            if name != 'body' and not re.fullmatch(r'\.body-[a-f0-9]{32}', name):
                continue
            try:
                os.unlink(name, dir_fd=self.fd)
                changed = True
            except FileNotFoundError:
                pass
        if changed:
            os.fsync(self.fd)


def public(state):
    result = {key: state[key] for key in ('import_id', 'status', 'error', 'name') if key in state}
    result.update(state.get('result', {}))
    if state['status'] in {'unknown', 'running', 'pending', 'uploading'}:
        result['uncertain'] = state['status'] == 'unknown'
    return result


def stage(payload, source, *, root='/workspace'):
    from binary_upload import package_files, package_size
    total = package_size(payload)
    with Store(root, payload.get('import_id')) as store, store.lock('upload.lock'):
        with store.lock():
            state = store.read()
            if state['status'] != 'pending' or store.cancelled():
                raise ValueError('技能导入已开始或已停止，请重新选择技能包')
            state.update(status='uploading')
            store.save(state)
        temporary = '.body-' + uuid.uuid4().hex
        try:
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=store.fd)
            with os.fdopen(fd, 'w+b') as target:
                remaining = total
                while remaining:
                    if store.cancelled():
                        raise ValueError('技能导入已停止')
                    chunk = source.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError('文件上传不完整')
                    target.write(chunk)
                    remaining -= len(chunk)
                if source.read(1):
                    raise ValueError('文件大小与声明不一致')
                target.flush()
                with package_files(payload, target) as entries, members({}, supplied=entries) as files:
                    content = skill_text(files)
                os.fsync(target.fileno())
            with store.lock():
                if store.cancelled():
                    raise ValueError('技能导入已停止')
                os.rename(temporary, 'body', src_dir_fd=store.fd, dst_dir_fd=store.fd)
                os.fsync(store.fd)
                state.update(status='staged', package={key: payload[key] for key in ('archive', 'files')},
                             content=content, manifest=version(content.encode()))
                store.save(state)
            return {'import_id': store.token, 'content': content, 'status': 'staged'}
        except BaseException:
            with store.lock():
                state.update(status='cancelled' if store.cancelled() else 'failed', error='技能包暂存未完成')
                store.save(state)
                store.cleanup(state)
            raise
        finally:
            try:
                os.unlink(temporary, dir_fd=store.fd)
            except FileNotFoundError:
                pass


def stage_json(payload, *, root='/workspace', supplied=None):
    """Compatibility JSON is decoded once, then uses the binary stage format."""
    from resource_ops import decode_base64
    metadata = {'import_id': payload.get('import_id') or uuid.uuid4().hex,
                'archive': bool(payload.get('archive')), 'files': []}
    with tempfile.TemporaryFile() as source:
        if supplied is not None:
            metadata['archive'] = False
            for path, member in supplied.items():
                with member.open() as stream:
                    while chunk := stream.read(65536):
                        source.write(chunk)
                metadata['files'].append({'path': path, 'size': member.size})
        elif metadata['archive']:
            decode_base64(payload['archive'], source)
            metadata['files'] = [{'path': 'package.zip', 'size': source.tell()}]
        else:
            for item in payload.get('files', []):
                offset = source.tell()
                decode_base64(item['data'], source)
                metadata['files'].append({'path': item['path'], 'size': source.tell() - offset})
        source.seek(0)
        return stage(metadata, source, root=root)


def legacy(payload, *, root='/workspace', supplied=None):
    staged = stage_json(payload, root=root, supplied=supplied)
    return commit_legacy(payload, staged['import_id'], root=root)


def commit_legacy(payload, token, *, root='/workspace'):
    request = {'import_id': token, 'name': payload.get('name'), 'version': payload.get('version')}
    try:
        prepared = prepare(request, root=root)
        if prepared.get('conflict'):
            status(request, root=root, cancel=True)
            return {'conflict': True}
        result = run(request, root=root, raise_errors=True)
        return {key: result[key] for key in ('id', 'version', 'path', 'conflict') if key in result}
    except BaseException:
        status(request, root=root, cancel=True)
        raise


def prepare(payload, *, root='/workspace'):
    with Store(root, payload.get('import_id')) as store, store.lock():
        state = store.read()
        if state['status'] not in {'staged', 'ready'} or store.cancelled():
            raise ValueError('技能包暂存不可用，请重新导入')
        name = safe_name(payload['name'])
        skills = resource_directory(store.rootfd, 'skills')
        try:
            expected = package_version(skills, name)
        finally:
            os.close(skills)
        if 'version' in payload and payload['version'] != expected:
            return {'conflict': True}
        state.update(status='ready', name=name, expected=expected)
        store.save(state)
        return {'import_id': store.token, 'name': name, 'version': expected}


class Transaction:
    def __init__(self, store):
        self.store = store

    def extracting(self, name, info):
        self.checkpoint(phase='extracting', staging=name, new_identity=identity(info))

    def publishing(self, fingerprint, old, backup):
        self.checkpoint(phase='publishing', new_version=fingerprint,
                        old_identity=identity(old) if old is not None else None, backup=backup)

    def checkpoint(self, **changes):
        with self.store.lock():
            state = self.store.read()
            if self.store.cancelled():
                raise ValueError('技能导入已停止')
            state.update(changes)
            self.store.save(state)


def recover(store, state, *, stopped=False):
    """Caller holds run.lock; finish a published exchange, never delete its old tree."""
    if state['status'] in TERMINAL:
        return state
    phase = state.get('phase')
    if phase == 'publishing':
        skills = resource_directory(store.rootfd, 'skills')
        try:
            # Recovery must serialize its identity checks and backup move with
            # publication, edits, renames and uninstall of the active package.
            fcntl.flock(skills, fcntl.LOCK_EX)
            active = entry_identity(skills, state['name'])
            staged = entry_identity(store.rootfd, state['staging'])
            if active == state['new_identity']:
                old = state['old_identity']
                if old is not None:
                    backups = directory(skills, '.backups')
                    try:
                        if staged == old:
                            rename_directory(store.rootfd, state['staging'], backups, state['backup'])
                        elif entry_identity(backups, state['backup']) != old:
                            state.update(status='unknown', error='技能已发布，旧版本备份位置待确认')
                            return state
                        os.fsync(backups)
                    finally:
                        os.close(backups)
                os.fsync(skills)
                os.fsync(store.rootfd)
                state.update(status='completed', result={'id': state['name'], 'version': state['new_version'],
                             'path': '/workspace/skills/' + state['name']})
                state.pop('error', None)
            elif active != state.get('old_identity'):
                state.update(status='unknown', error='技能目录已变化，导入结果待确认')
                return state
        finally:
            fcntl.flock(skills, fcntl.LOCK_UN)
            os.close(skills)
    if state['status'] != 'completed':
        if state.get('staging') and entry_identity(store.rootfd, state['staging']) == state['new_identity']:
            fd = os.open(state['staging'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=store.rootfd)
            try:
                discard_staging(store.rootfd, state['staging'], fd)
            finally:
                os.close(fd)
        state.update(status='cancelled' if stopped or store.cancelled() else 'failed')
        state.setdefault('error', '技能导入已停止' if state['status'] == 'cancelled' else '技能导入中断，原技能已保留')
    return state


def status(payload, *, root='/workspace', cancel=False, confirmed=True, expire=False):
    with Store(root, payload.get('import_id')) as store:
        if cancel and not store.cancelled():
            atomic_write(store.fd, 'cancel', b'1')
        with store.lock('run.lock', blocking=False) as idle, store.lock():
            state = store.read()
            previous = dict(state)
            if (expire and state['status'] in {'pending', 'uploading', 'staged', 'ready'}
                    and time.time() - state.get('updated_at', os.fstat(store.fd).st_mtime) > STAGING_RETENTION):
                cancel = True
                atomic_write(store.fd, 'cancel', b'1')
            if state['status'] not in TERMINAL and idle:
                # Uploads use their own lock. A late upload sees the cancel flag.
                with store.lock('upload.lock', blocking=False) as not_uploading:
                    if (state['status'] in {'running', 'unknown', 'uploading'} or cancel) and not_uploading:
                        state = recover(store, state, stopped=cancel)
            if cancel and (not idle or not confirmed) and state['status'] not in TERMINAL:
                state = {**state, 'status': 'unknown', 'error': '停止尚未确认，导入结果待确认'}
            if state != previous:
                store.save(state)
            if state['status'] in TERMINAL and idle:
                with store.lock('upload.lock', blocking=False) as not_uploading:
                    if not_uploading:
                        store.cleanup(state)
            return public(state)


def sweep_receipt(root, entry, parent, now):
    with Store(root, entry) as store, store.lock('run.lock', blocking=False) as idle, \
            store.lock('upload.lock', blocking=False) as not_uploading, store.lock():
        state = store.read()
        if state['status'] not in TERMINAL or state.get('cleanup_pending'):
            store.track()
        elif idle and not_uploading:
            store.cleanup(state)
            if (not state.get('cleanup_pending') and
                    read_file(store.pending, store.token, max_bytes=1) is None and
                    now - state.get('terminal_at', state.get('updated_at', now)) > RECEIPT_RETENTION):
                # Unknown content and ambiguous publication trees are retained.
                names = os.listdir(store.fd)
                if set(names) <= {'state.json', 'state.lock', 'run.lock', 'upload.lock', 'cancel'}:
                    for name in names:
                        os.unlink(name, dir_fd=store.fd)
                    os.rmdir(entry, dir_fd=parent)
                    os.fsync(parent)


def recover_pending(root='/workspace'):
    """Opportunistic recovery on catalog reads; live imports retain their lock."""
    warnings = []
    try:
        _recover_pending(root, warnings)
    except (OSError, ValueError, KeyError, TypeError):
        warnings.append('技能导入维护暂未完成，已安装技能仍可读取')
    return list(dict.fromkeys(warnings))


def _recover_pending(root, warnings):
    rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            parent = os.open('.skill-imports', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
        except FileNotFoundError:
            return warnings
        try:
            # A periodic sweep migrates pre-index receipts and expires abandoned
            # uploads/history. Catalog reads normally visit only pending work.
            maintenance = os.open('.maintenance.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                try:
                    fcntl.flock(maintenance, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    pass
                else:
                    raw = read_file(parent, '.swept', max_bytes=64)
                    now = time.time()
                    try:
                        last_sweep = float(raw) if raw else 0
                    except ValueError:
                        last_sweep = 0
                    if now - last_sweep > SWEEP_INTERVAL:
                        for entry in os.listdir(parent):
                            if not re.fullmatch('[a-f0-9]{32}', entry):
                                continue
                            try:
                                sweep_receipt(root, entry, parent, now)
                            except (OSError, ValueError, KeyError, TypeError):
                                warnings.append('技能导入回执异常，相关文件已保留：' + entry)
                                try:
                                    with Store(root, entry) as store:
                                        store.track()
                                except OSError:
                                    pass
                        atomic_write(parent, '.swept', str(now).encode())
            finally:
                os.close(maintenance)
            pending = Store._directory(parent, '.pending')
            try:
                entries = os.listdir(pending)
            finally:
                os.close(pending)
            for entry in entries:
                if re.fullmatch('[a-f0-9]{32}', entry):
                    try:
                        result = status({'import_id': entry}, root=root, expire=True)
                        if result['status'] == 'unknown':
                            warnings.append('技能导入结果待确认：' + entry)
                    except (OSError, ValueError, KeyError, TypeError):
                        warnings.append('技能导入回执异常，相关文件已保留：' + entry)
        finally:
            os.close(parent)
    finally:
        os.close(rootfd)


def inspect(payload, *, root='/workspace'):
    with Store(root, payload.get('import_id')) as store, store.lock():
        state = store.read()
        if state['status'] not in {'staged', 'ready'} or store.cancelled():
            raise ValueError('技能包暂存不可用，请重新导入')
        return {'content': state['content'], 'import_id': store.token}


def run(payload, *, root='/workspace', raise_errors=False):
    from binary_upload import package_files
    from resource_ops import install_personal, members
    with Store(root, payload.get('import_id')) as store, store.lock('run.lock', blocking=False) as idle:
        if not idle:
            return {'import_id': store.token, 'status': 'running'}
        with store.lock():
            state = store.read()
            if state['status'] in TERMINAL:
                store.cleanup(state)
                return public(state)
            if state['status'] == 'running':
                state = recover(store, state)
                store.save(state)
                store.cleanup(state)
                return public(state)
            if store.cancelled():
                state = recover(store, state, stopped=True)
                store.save(state)
                store.cleanup(state)
                return public(state)
            if state['status'] != 'ready' or payload.get('name') != state['name']:
                raise ValueError('技能包尚未完成检查')
            if 'version' not in payload or payload['version'] != state['expected']:
                state.update(status='conflict', result={'conflict': True})
                store.save(state)
                store.cleanup(state)
                return public(state)
            state.update(status='running')
            store.save(state)
        try:
            fd = os.open('body', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=store.fd)
            with os.fdopen(fd, 'rb') as source, package_files(state['package'], source) as entries, members({}, supplied=entries) as files:
                if version(skill_text(files).encode()) != state['manifest']:
                    raise ValueError('暂存技能内容已改变，请重新导入')
                skills = resource_directory(store.rootfd, 'skills')
                try:
                    result = install_personal(store.rootfd, skills, state['name'], state['expected'], files,
                                              transaction=Transaction(store))
                finally:
                    os.close(skills)
            with store.lock():
                state = store.read()
                state.update(status='conflict' if result.get('conflict') else 'completed', result=result)
                state.pop('error', None)
                store.save(state)
                store.cleanup(state)
                return public(state)
        except BaseException as error:
            with store.lock():
                state = store.read()
                if state['status'] not in TERMINAL:
                    state['error'] = str(error)
                state = recover(store, state)
                store.save(state)
                if state['status'] in TERMINAL:
                    store.cleanup(state)
                if raise_errors:
                    raise
                return public(state)
