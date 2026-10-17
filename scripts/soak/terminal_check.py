#!/usr/bin/env python3
"""Real alpha.5 terminal ACK/reconnect verification, without model calls."""
import argparse
import json
import queue
import subprocess
import threading
import time
import traceback
import uuid
from client import FixtureClient

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', required=True)
args = parser.parse_args()
client = FixtureClient(args.root)
row = sorted(client.bindings().values(), key=lambda item: item['owner_id'])[-1]
chat = client.host(row, 'POST', '/chats', {})
terminal = str(uuid.uuid4())
path = '/chats/' + chat['id'] + '/terminals/' + terminal
client.host(row, 'POST', '/chats/' + chat['id'] + '/terminals', {'id': terminal, 'cols': 120, 'rows': 40})
latencies = []
connections = []
frames = []


def follow(attachment):
    messages = queue.Queue()
    response = client.open_host(row, 'GET', path + '/events?attachment=' + attachment, timeout=30)
    def reader():
        try:
            for raw in response:
                if raw.startswith(b'data:'):
                    value = json.loads(raw[5:])
                    frames.append(value)
                    messages.put(value)
        except Exception as error: messages.put(error)
    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    first = messages.get(timeout=15)
    assert not isinstance(first, Exception), str(first)
    assert first['value']['type'] == 'snapshot' and first['value']['info']['controllerId'] == attachment
    return response, thread, messages


failure = None
try:
    for cycle in range(10):
        attachment = str(uuid.uuid4())
        response, thread, messages = follow(attachment)
        for offset in range(10):
            number = cycle * 10 + offset
            # ACK promises mean the input was accepted by the native controller.
            command = "node -e 'require(\"node:fs\").appendFileSync(\"terminal-proof.jsonl\",\"" + str(number) + "\\n\")'\r"
            start = time.monotonic()
            client.host(row, 'POST', path + '/write', {'attachment_id': attachment, 'data': command})
            latencies.append(time.monotonic() - start)
        connections.append(attachment)
        # Connecting the next controller replaces the previous one. No input is replayed.
        if cycle < 9:
            next_attachment = str(uuid.uuid4())
            replacement, replacement_thread, _ = follow(next_attachment)
            response.close()
            replacement.close()
            thread.join(timeout=2)
            replacement_thread.join(timeout=2)
    sandbox = row.get('sandbox_name') or client.config['prefix'] + '-sbx-' + row['workspace_id']
    target = '/workspace/' + chat['file_directory'] + '/terminal-proof.jsonl'
    deadline = time.monotonic() + 30
    while True:
        result = subprocess.run(['docker', 'exec', '--user', '1000', sandbox, 'cat', target], capture_output=True, text=True, timeout=10)
        if result.returncode and 'no such file or directory' not in result.stderr.lower():
            raise RuntimeError('Cannot read terminal ledger: ' + result.stderr[-500:])
        numbers = [int(line) for line in result.stdout.splitlines()] if result.returncode == 0 else []
        if len(numbers) >= 100 or time.monotonic() >= deadline: break
        time.sleep(0.25)
    assert numbers == list(range(100)), 'Terminal ledger differs: ' + json.dumps(numbers)
    proof = {'writes': len(numbers), 'distinctWrites': len(set(numbers)), 'reconnectCycles': 10,
        'maximumAckSeconds': max(latencies), 'owner': row['owner_id'], 'chat': chat['id'], 'paidModelCalls': 0}
    (client.root / 'terminal-proof.json').write_text(json.dumps(proof, indent=2))
    print(json.dumps(proof), flush=True)
except BaseException as error:
    failure = error
    (client.root / 'terminal-failure.txt').write_text(traceback.format_exc())
    raise
finally:
    (client.root / 'terminal-frames.json').write_text(json.dumps(frames, ensure_ascii=False))
    try: client.host(row, 'DELETE', path)
    except Exception as error:
        print(json.dumps({'cleanupError': str(error), 'chat': chat['id'], 'terminal': terminal}), flush=True)
        if failure is None: raise
    try: response.close()
    except Exception: pass
