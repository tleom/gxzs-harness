#!/usr/bin/env python3
"""Bounded resource, admission and redacted log capture for an owned fixture stack."""
import argparse
import json
import pathlib
import re
import subprocess
import time
from client import FixtureClient

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', required=True)
parser.add_argument('--minutes', type=int, default=160)
args = parser.parse_args()
client = FixtureClient(args.root)
prefix = client.config['prefix']


def docker(*args):
    return subprocess.run(['docker', *args], capture_output=True, text=True, timeout=60)


def append(name, value):
    with (client.root / name).open('a') as target:
        target.write(json.dumps(value, ensure_ascii=False) + '\n')


def redact(text):
    for secret in [client.config['token'], client.config['assertionKey']]: text = text.replace(secret, '[redacted]')
    text = re.sub(r'([?&](?:token|authorization)=)[^\s&]+', r'\1[redacted]', text, flags=re.I)
    text = re.sub(r'Bearer\s+[^\s"\']+', 'Bearer [redacted]', text, flags=re.I)
    return text


start = time.time()
previous = str(int(start))
while time.time() - start < args.minutes * 60:
    now = time.time()
    names = docker('ps', '-a', '--filter', 'name=' + prefix, '--format', '{{.Names}}').stdout.split()
    assert all(name.startswith(prefix + '-') for name in names)
    states = json.loads(docker('inspect', *names).stdout)
    state_rows = [{'name': item['Name'][1:], 'running': item['State']['Running'], 'oom': item['State']['OOMKilled'],
        'restarts': item['RestartCount'], 'health': item['State'].get('Health', {}).get('Status'), 'image': item['Image']} for item in states]
    stat_rows = [json.loads(line) for line in docker('stats', '--no-stream', '--format', '{{json .}}', *names).stdout.splitlines()]
    query = "import sqlite3,json; c=sqlite3.connect('file:/state/admission.sqlite3?mode=ro',uri=True); print(json.dumps({'states':c.execute('SELECT state,count(*) FROM task_admission GROUP BY state').fetchall(),'activeOwners':c.execute(\"SELECT owner,count(*) FROM task_admission WHERE state='running' GROUP BY owner\").fetchall(),'tickets':c.execute('SELECT seq,owner,run,state,heartbeat FROM task_admission ORDER BY seq').fetchall()}))"
    admission = docker('exec', prefix + '-manager', 'python3', '-c', query)
    admission = json.loads(admission.stdout) if admission.returncode == 0 else {'error': redact(admission.stderr)[-300:]}
    memory = {parts[0].rstrip(':'): int(parts[1]) for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if len(parts := line.split()) >= 2}
    sample = {'at': now, 'containers': state_rows, 'stats': stat_rows, 'admission': admission,
        'memAvailableKiB': memory['MemAvailable'], 'load': pathlib.Path('/proc/loadavg').read_text().strip()}
    append('monitor.jsonl', sample)
    for name in names:
        # A busy tool loop can emit more than 150 lines per interval. Capture
        # the whole bounded interval so an early error cannot be truncated.
        logs = docker('logs', '--since', previous, '--until', str(int(now)), name)
        text = redact(logs.stdout + logs.stderr)
        if text.strip(): append('runtime-logs.jsonl', {'at': now, 'container': name, 'text': text})
    previous = str(int(now))
    counts = dict(admission.get('states', []))
    print(json.dumps({'at': now, 'containers': len(names), 'admission': counts,
        'activeOwners': len(admission.get('activeOwners', [])), 'memAvailableGiB': round(memory['MemAvailable'] / 1048576, 2)}), flush=True)
    if memory['MemAvailable'] < 6 * 1048576: append('pressure-alerts.jsonl', {'at': now, 'availableKiB': memory['MemAvailable']})
    time.sleep(max(1, 30 - (time.time() - now)))
