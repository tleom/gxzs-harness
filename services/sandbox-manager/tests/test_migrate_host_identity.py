import hashlib
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[3] / 'scripts'))
import migrate_host_identity as migration


WORKSPACE = '78232f3b-9dc7-42ae-a0d9-4a879599e34e'
OLD = '000000:42'
NEW = 'gxzs-42'
DIRECTORY = '业务文件/草稿'


def receipt(owner):
    return 'file:' + hashlib.sha256(f'{owner}\0{DIRECTORY}'.encode()).hexdigest()


@pytest.fixture
def offline(tmp_path, monkeypatch):
    return make_fixture(tmp_path, monkeypatch, managed=True)


def make_fixture(tmp_path, monkeypatch, managed):
    instance = 'host-identity-fixture' if managed else 'gxzs-migration-host-0'
    entry = dict(old_owner_id=OLD, new_owner_id=NEW, workspace_id=WORKSPACE,
                 generation=7, instance_id=instance)
    state = tmp_path / 'state'
    record = state / 'hosts' / WORKSPACE / 'host.json'
    record.parent.mkdir(parents=True)
    digest = 'sha256:fixture'
    sandbox_name = 'migration-sandbox'
    if managed:
        record.write_text(json.dumps(dict(owner_id=OLD, workspace_id=WORKSPACE, generation=7,
            instance_id=instance, home_volume='migration-home', sandbox_name=sandbox_name,
            sandbox_volume_prefix='workspace-fixture', image_digest=digest, state='ready', ready=True,
            endpoint='http://127.0.0.1:7182', custom_resource=5)))
    docker_root = tmp_path / 'docker'
    home = docker_root / 'volumes' / 'migration-home' / '_data'
    home.mkdir(parents=True)
    database = home / 'workbench.sqlite3'
    adapter = Path(__file__).parents[3] / 'packages/workbench-adapter/src/persistence.js'
    ddl = adapter.read_text(encoding='utf-8').split('this.db.exec(`', 1)[1].split('`)', 1)[0]
    with closing(sqlite3.connect(database)) as db, db:
        db.executescript(ddl)
        db.execute('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (3,1)')
        db.execute('INSERT INTO chats(id,owner_id,session_id,title,created_at,updated_at,selection_json) VALUES (?,?,?,?,?,?,?)',
                   ('chat-1', OLD, 'session-1', 'historical chat', 1, 3, '{}'))
        db.execute('INSERT INTO runs(id,owner_id,chat_id,session_id,query,status,selection_json,created_at,updated_at) '
                   'VALUES (?,?,?,?,?,?,?,?,?)', ('run-1', OLD, 'chat-1', 'session-1', 'synthetic question', 'completed', '{}', 1, 3))
        db.execute('INSERT INTO platform_schedule_sync(owner_id,sequence,fingerprint) VALUES (?,?,?)', (OLD, 17, 'fixed'))
        db.execute('INSERT INTO workspace_deletions(workspace_id,owner_id,plan_json) VALUES (?,?,?)',
                   (receipt(OLD), OLD, json.dumps({'path':DIRECTORY, 'fileOnly':True, 'chatIds':[], 'workspaceIds':[]})))
        db.execute('INSERT INTO chat_deletions(chat_id,owner_id,session_ids_json,created_at,completed_at) VALUES (?,?,?,?,?)',
                   ('deleted-chat', OLD, '[]', 1, 3))
        db.execute('INSERT INTO chat_drafts(owner_id,draft_id,state_json) VALUES (?,?,?)', (OLD, 'draft-1', '{}'))
        db.execute('INSERT INTO command_receipts(owner_id,chat_id,request_key,result_json,created_at) VALUES (?,?,?,?,?)',
                   (OLD, 'chat-1', 'receipt-1', '{}', 3))
        db.execute('INSERT INTO host_command_receipts(owner_id,request_key,result_json,created_at) VALUES (?,?,?,?)',
                   (OLD, 'host-receipt-1', '{}', 3))
    with closing(sqlite3.connect(state/'admission.sqlite3')) as db, db:
        db.executescript('CREATE TABLE task_admission(owner TEXT, run TEXT, state TEXT, UNIQUE(owner,run));')
        db.execute('INSERT INTO task_admission VALUES (?, ?, ?)', (OLD, 'run-1', 'done'))
    files = {'Destination':'/workspace', 'Type':'volume', 'Name':'workspace-fixture-files'}
    manager = dict(Name='/fixture-manager', Id='a'*64, State={'Running':False},
                   Mounts=[{'Source':str(state), 'Destination':'/state'}])
    host = dict(Name='/'+instance, Id='b'*64, State={'Running':True}, Image=digest,
                Config={'Env':[f'GXZS_HOST_OWNER_ID={OLD}', 'GXZS_HOST_GENERATION=7',
                     f'GXZS_HOST_INSTANCE_ID={instance}', f'GXZS_SANDBOX_WORKSPACE_ID={WORKSPACE}',
                     f'GXZS_SANDBOX_SSH_HOST={sandbox_name}']},
                Mounts=[files, {'Destination':'/srv/dsh', 'Type':'volume', 'Name':'migration-home'}])
    sandbox = dict(Name='/'+sandbox_name, Id='c'*64, State={'Running':True},
                   Config={'Labels':{'gxzs.workspace':WORKSPACE}}, Mounts=[files])
    containers = [manager, host, sandbox]
    calls = []

    def docker(*command, missing=False):
        calls.append(command)
        if command[0] == 'info':
            return str(docker_root)
        if command[:2] == ('container', 'inspect'):
            return next((json.dumps([item]) for item in containers
                         if command[2] in (item['Id'],item['Name'].lstrip('/'))), None)
        if command[:2] == ('volume','inspect'):
            assert command[2] == 'migration-home'
            return json.dumps([{'Mountpoint':str(home), 'Driver':'local'}])
        if command[0] == 'ps':
            return '\n'.join(item['Id'] for item in containers if item['State']['Running']
                             and any(command[-1] == 'volume='+mount.get('Name','') for mount in item['Mounts']))
        item = next(item for item in containers if item['Id'] == command[-1 if command[0] == 'stop' else 1])
        if command[0] == 'stop':
            item['State']['Running'] = False
        elif command[0] == 'rename':
            item['Name'] = '/'+command[2]
        else:
            pytest.fail(f'Unexpected Docker command {command}')

    monkeypatch.setattr(migration, 'docker', docker)
    return state, record, database, entry, containers, calls


@pytest.mark.parametrize('managed', [True, False])
def test_migration_preserves_sqlite_history_and_exact_volumes(tmp_path, monkeypatch, managed):
    state, record, database, entry, containers, calls = make_fixture(tmp_path, monkeypatch, managed)
    output = tmp_path/'separate-backup'
    migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, False)
    assert not output.exists()
    assert not [call for call in calls if call[0] in ('rename','stop')]
    migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    migrated = json.loads(record.read_text())
    assert migrated['home_volume'] == 'migration-home' and migrated['sandbox_volume_prefix'] == 'workspace-fixture'
    assert (migrated['owner_id'], migrated['generation'], migrated['instance_id'], migrated['ready']) == (
        NEW, 7, entry['instance_id'], False)
    if managed:
        assert migrated['custom_resource'] == 5
    assert all(not item['State']['Running'] and '-previous-' in item['Name'] for item in containers[1:])
    for path, owner in [(output/WORKSPACE/database.name, OLD), (database, NEW)]:
        with closing(sqlite3.connect(path)) as db:
            assert db.execute('SELECT owner_id,session_id,title FROM chats').fetchone() == (owner,'session-1','historical chat')
            assert db.execute('SELECT owner_id,workspace_id FROM workspace_deletions').fetchone() == (owner, receipt(owner))
            assert db.execute('SELECT owner_id,sequence FROM platform_schedule_sync').fetchone() == (owner, 17)
            assert len(migration.owner_tables(db)) == 8
            for table in migration.owner_tables(db):
                assert db.execute('SELECT DISTINCT owner_id FROM '+migration.identifier(table)).fetchone() == (owner,)
    with closing(sqlite3.connect(state/'admission.sqlite3')) as db:
        assert db.execute('SELECT * FROM task_admission').fetchone() == (NEW,'run-1','done')
    migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    assert len([call for call in calls if call[0] == 'stop']) == 2
    assert (output/WORKSPACE/'host.json').exists() is managed
    assert migration.manifest_entries(output/'host-identity-manifest.json') == [entry]


@pytest.mark.parametrize('case,reason', [
    ('active','Drain active Workbench runs'), ('container','An unrelated container'),
    ('schema','Unsupported Workbench SQLite schema'), ('receipt','receipt disagrees'),
    ('other-admission','legacy owner missing'), ('manager','must be stopped'),
])
def test_preflight_preserves_original_state(offline, tmp_path, case, reason):
    state, record, database, entry, containers, calls = offline
    if case == 'active':
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("UPDATE runs SET status='running'")
    elif case == 'container':
        containers.append(dict(containers[2], Id='d'*64, Name='/unrelated'))
    elif case == 'schema':
        with closing(sqlite3.connect(database)) as db, db:
            db.execute('UPDATE schema_migrations SET version=2')
    elif case == 'receipt':
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("UPDATE workspace_deletions SET workspace_id='file:invalid'")
    elif case == 'other-admission':
        with closing(sqlite3.connect(state/'admission.sqlite3')) as db, db:
            db.execute("INSERT INTO task_admission VALUES ('000000:43','another-run','done')")
    elif case == 'manager':
        containers[0]['State']['Running'] = True
    output = tmp_path/'unused-backup'
    with pytest.raises(ValueError, match=reason):
        migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    assert json.loads(record.read_text())['owner_id'] == OLD
    assert not output.exists()
    assert not [call for call in calls if call[0] in ('rename','stop')]


def profile_fixture(database):
    profile = database.parent / 'profiles' / 'workbench'
    profile.mkdir(parents=True)
    baseline = b'- id: generated-preset\n  disabled: true\n'
    proof = dict(schemaVersion=1, ownerId=OLD, imageId='sha256:'+'1'*64,
                 baselineSha256=hashlib.sha256(baseline).hexdigest(),
                 sourcePath='/opt/workbench/profiles/workbench/cordis.runtime.patch.yml')
    (profile/migration.BASELINE_PATCH).write_bytes(baseline)
    (profile/migration.BASELINE_PROOF).write_text(json.dumps(proof))
    (profile/'cordis.patch.yml').write_text('- id: user-setting\n')
    return profile, proof


def test_migrates_profile_proof_preserving_baseline_settings_permissions_and_backup(offline, tmp_path):
    state, record, database, entry, containers, calls = offline
    profile, original = profile_fixture(database)
    proof = profile/migration.BASELINE_PROOF
    before = proof.stat()
    output = tmp_path/'separate-backup'
    migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    assert json.loads(proof.read_text()) == dict(original, ownerId=NEW)
    assert json.loads((output/WORKSPACE/migration.BASELINE_PROOF).read_text()) == original
    assert (output/WORKSPACE/migration.BASELINE_PATCH).read_bytes() == (profile/migration.BASELINE_PATCH).read_bytes()
    assert (proof.stat().st_uid, proof.stat().st_gid, proof.stat().st_mode) == (before.st_uid, before.st_gid, before.st_mode)
    assert (profile/'cordis.patch.yml').read_text() == '- id: user-setting\n'
    migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    assert json.loads((output/WORKSPACE/migration.BASELINE_PROOF).read_text()) == original


@pytest.mark.parametrize('failure', ['owner', 'digest', 'missing-proof'])
def test_rejects_unverified_profile_before_stopping_or_mutating(offline, tmp_path, failure):
    state, record, database, entry, containers, calls = offline
    profile, proof = profile_fixture(database)
    if failure == 'owner':
        proof['ownerId'] = '000000:43'
    elif failure == 'digest':
        proof['baselineSha256'] = '0'*64
    (profile/migration.BASELINE_PROOF).write_text(json.dumps(proof))
    if failure == 'missing-proof':
        (profile/migration.BASELINE_PROOF).unlink()
    output = tmp_path/'unused-backup'
    with pytest.raises(ValueError, match='Profile baseline'):
        migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    assert not output.exists() and json.loads(record.read_text())['owner_id'] == OLD
    assert not [call for call in calls if call[0] in ('rename','stop')]


def uncertain_outcomes(state):
    path = state/'mcp-outcomes.sqlite3'
    rows = [('call-completed', WORKSPACE, 'run-1', 1), ('call-deleted', WORKSPACE, 'deleted-run', 2)]
    with closing(sqlite3.connect(path)) as db, db:
        db.execute('CREATE TABLE unconfirmed_calls(call_id TEXT PRIMARY KEY, workspace TEXT, binding TEXT, started_at INTEGER)')
        db.executemany('INSERT INTO unconfirmed_calls VALUES (?,?,?,?)', rows)
    return path, rows


def test_stopped_host_preserves_uncertain_completed_and_deleted_runs(offline, tmp_path):
    state, record, database, entry, containers, calls = offline
    outcomes, original = uncertain_outcomes(state)
    before = outcomes.read_bytes()
    for item in containers:
        item['State']['Running'] = False
    output = tmp_path/'separate-backup'
    migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, False)
    assert not output.exists()
    migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    assert outcomes.read_bytes() == before
    for path in [outcomes, output/outcomes.name]:
        with closing(sqlite3.connect(path)) as db:
            assert db.execute('SELECT * FROM unconfirmed_calls ORDER BY started_at').fetchall() == original
    with closing(sqlite3.connect(database)) as db:
        assert db.execute('SELECT owner_id,status FROM runs').fetchone() == (NEW, 'completed')
    migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    assert outcomes.read_bytes() == before


@pytest.mark.parametrize('live', ['host', 'sandbox', 'admission', 'queued', 'running', 'waiting_input', 'stopping'])
def test_uncertain_outcome_does_not_allow_active_execution(offline, tmp_path, live):
    state, record, database, entry, containers, calls = offline
    outcomes, _ = uncertain_outcomes(state)
    before = outcomes.read_bytes()
    for item in containers:
        item['State']['Running'] = False
    if live in {'host','sandbox'}:
        containers[1 if live == 'host' else 2]['State']['Running'] = True
        reason = 'Stop Host and Sandbox'
    elif live == 'admission':
        with closing(sqlite3.connect(state/'admission.sqlite3')) as db, db:
            db.execute("UPDATE task_admission SET state='running'")
        reason = 'Drain active manager admission'
    else:
        with closing(sqlite3.connect(database)) as db, db:
            db.execute('UPDATE runs SET status=?', (live,))
        reason = 'Drain active Workbench runs'
    output = tmp_path/'unused-backup'
    with pytest.raises(ValueError, match=reason):
        migration.migrate(state, 'fixture-manager', 'workspace-fixture', [entry], output, True)
    assert not output.exists() and outcomes.read_bytes() == before
    assert json.loads(record.read_text())['owner_id'] == OLD
    assert not [call for call in calls if call[0] in ('rename','stop')]
