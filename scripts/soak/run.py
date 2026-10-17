#!/usr/bin/env python3
"""Run native tasks using synthetic model output; capture all run events locally."""
import argparse
import concurrent.futures
import json
import pathlib
import re
import subprocess
import time
import uuid
from client import FixtureClient
from evidence import EventJournal, missing_cases, select_owners, validate_resume

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('action', choices=['fixtures', 'pilot', 'soak', 'resume'])
parser.add_argument('--root', required=True)
parser.add_argument('--case', default='mixed001')
parser.add_argument('--case-file', help='JSON scenario for a single pilot task')
parser.add_argument('--owners', type=int, default=2)
parser.add_argument('--minutes', type=int, default=120)
args = parser.parse_args()
assert re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args.case), 'Invalid case identifier'
assert 1 <= args.minutes <= 1440
client = FixtureClient(args.root)
root = client.root
rows = select_owners(client.bindings(), args.owners)
journals = {}


def save(name, value):
    target = root / name
    temporary = target.with_suffix(target.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.replace(target)


def install(row):
    workspace = row['workspace_id']
    sandbox = row.get('sandbox_name') or client.config['prefix'] + '-sbx-' + workspace
    skill = '---\nname: soak-skill\ndescription: Synthetic stability validation\nmetadata:\n  display-name: 稳定性验收技能\n---\nGXZS_SIM_SKILL_OK\n'
    script = "import pathlib,sys; p=pathlib.Path('/workspace/skills/soak-skill'); p.mkdir(parents=True,exist_ok=True); (p/'SKILL.md').write_text(sys.stdin.read())"
    subprocess.run(['docker', 'exec', '--user', '1000', '-i', sandbox, 'python3', '-c', script], input=skill, text=True, check=True)
    config = {'name': 'soak-personal', 'display_name': '模拟个人插件', 'description': '320 tool catalog fixture',
        'transport': 'streamable-http', 'url': client.config['publicURL'] + '/mcp',
        'headers': {'Authorization': 'Bearer ' + client.config['token']}}
    current = client.manager('/sandboxes/' + workspace + '/personal-mcp', {'operation': 'mcp_list'})
    existing = next((item for item in current.get('mcp', []) if item['id'] == 'soak-personal'), None)
    if not existing:
        result = client.manager('/sandboxes/' + workspace + '/personal-mcp', {'operation': 'mcp_save', 'name': 'soak-personal', 'content': json.dumps(config), 'version': None})
        assert not result.get('conflict'), result
    current = client.manager('/sandboxes/' + workspace + '/personal-mcp', {'operation': 'mcp_read', 'name': 'soak-personal'})
    result = client.manager('/sandboxes/' + workspace + '/personal-mcp', {'operation': 'mcp_test', 'name': 'soak-personal', 'version': current['version']})
    if result.get('error'): raise RuntimeError('Personal MCP fixture failed: ' + str(result))
    assert result.get('ready') is True and len(result.get('tools', [])) == 320, 'Personal MCP catalog is incomplete'
    return {'owner': row['owner_id'], 'fixtureInstalled': True}


def submit(row, case, chat):
    start = time.time()
    task = {'owner': row['owner_id'], 'chat': chat['id'], 'case': case, 'submittedAt': start,
        'cursor': '0-0', 'events': 0, 'requestKey': 'sim-' + uuid.uuid4().hex}
    try:
        run = client.host(row, 'POST', '/chats/' + chat['id'] + '/runs', {
            'query': 'GXZS_SIM_CASE ' + json.dumps(case), 'request_key': task['requestKey'], 'version': chat['version']})
        task.update(run=run['id'], status=run['status'])
    except Exception as error:
        task.update(status='submission_failed', complete=True, submissionError=str(error))
    return task


def poll(task, bindings):
    value = client.host(bindings[task['owner']], 'GET', '/runs/' + task['run'] + '?after=' + task['cursor'])
    case = task['case']['id']
    if case not in journals:
        journals[case] = EventJournal(root / ('events-' + case + '.jsonl'))
    task['events'] = journals[case].append(value['events'])
    task['cursor'] = value['events_cursor']
    task['status'] = value['status']
    task['complete'] = value['history_complete'] and value['status'] not in ['running', 'queued', 'stopping']
    task['lastPollAt'] = time.time()
    if task['complete']: task['endedAt'] = time.time()
    return task


if args.action == 'fixtures':
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for result in pool.map(install, rows): print(json.dumps(result), flush=True)
else:
    cases = []
    if args.action == 'pilot':
        case = json.loads(pathlib.Path(args.case_file).read_text()) if args.case_file else {'id': args.case, 'kind': 'mixed', 'rounds': 40, 'stepDelayMs': 100, 'browser': True}
        args.case = case['id']
        assert re.fullmatch(r'[A-Za-z0-9_-]{1,64}', args.case), 'Invalid case identifier'
        cases = [(rows[0], case)]
    elif args.action == 'soak':
        # Thirty independent owners; four simultaneously submitted root chats each.
        # Native global limits remain 10 owners / 30 root tasks, 3 per owner.
        for lane in range(4):
            for index, row in enumerate(rows):
                duration = args.minutes * 60000 if index == 0 and lane == 0 else 20 * 60000
                cases.append((row, {'id': f'{args.case}_o{index+1}_l{lane}', 'kind': 'mixed', 'rounds': 40,
                    'durationMs': duration, 'stepDelayMs': 10000, 'browser': lane == 0}))
    manifest = root / ('tasks-' + args.case + '.json')
    if args.action == 'resume':
        # Resume observation only: never create chats or resubmit a measured run.
        tasks = json.loads(manifest.read_text())
        validate_resume(tasks, json.loads((root / ('prepared-' + args.case + '.json')).read_text()))
        bindings = client.bindings()
        assert tasks and all(task['owner'] in bindings for task in tasks)
        assert all(task['case']['id'].startswith(args.case + '_') for task in tasks)
    else:
        assert not manifest.exists(), 'Existing run: use resume after stopping its previous observer'
        tasks = []
        # Opening the page/chat is preparation; the measured burst is submission of runs.
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            chats = list(pool.map(lambda pair: client.host(pair[0], 'POST', '/chats', {}), cases))
        save('prepared-' + args.case + '.json', [{'owner': pair[0]['owner_id'], 'case': pair[1], 'chat': chat} for pair, chat in zip(cases, chats)])
        with concurrent.futures.ThreadPoolExecutor(max_workers=30) as pool:
            futures = [pool.submit(submit, *pair, chat) for pair, chat in zip(cases, chats)]
            for future in concurrent.futures.as_completed(futures):
                tasks.append(future.result())
                save('tasks-' + args.case + '.json', tasks)
    save('tasks-' + args.case + '.json', tasks)
    deadline = time.monotonic() + (240 if args.action == 'pilot' else args.minutes * 60 + 2400)
    last_report = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        while time.monotonic() < deadline:
            bindings = client.bindings()
            pending = [task for task in tasks if not task.get('complete')]
            if not pending:
                if all(task['status'] == 'completed' for task in tasks) and missing_cases(tasks, client.platform('/__test/status')):
                    time.sleep(1)
                    continue
                break
            futures = {pool.submit(poll, task, bindings): task for task in pending}
            for future, task in futures.items():
                try: future.result()
                except Exception as error:
                    task.setdefault('pollErrors', []).append({'at': time.time(), 'error': str(error)[:1000]})
            save('tasks-' + args.case + '.json', tasks)
            if time.monotonic() - last_report >= 30:
                counts = {status: sum(task['status'] == status for task in tasks) for status in sorted({task['status'] for task in tasks})}
                print(json.dumps({'at': time.time(), 'status': counts, 'events': sum(task['events'] for task in tasks)}), flush=True)
                last_report = time.monotonic()
            time.sleep(2 if args.action == 'pilot' else 10)
    proof = {'tasks': len(tasks), 'completed': sum(task['status'] == 'completed' for task in tasks),
        'terminal': sum(task.get('complete', False) for task in tasks), 'events': sum(task['events'] for task in tasks),
        'simulator': client.platform('/__test/status'), 'paidModelCalls': 0}
    save('proof-' + args.case + '.json', proof)
    print(json.dumps({key: value for key, value in proof.items() if key != 'simulator'}), flush=True)
    assert proof['completed'] == len(tasks), 'Some native synthetic tasks failed; inspect recorded events'
    missing = missing_cases(tasks, proof['simulator'])
    assert not missing, 'Some required synthetic cases did not complete: ' + ', '.join(missing)
