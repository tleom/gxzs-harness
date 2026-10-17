"""Append native events once even if an observer restarts before saving its cursor."""
import json
import os
import re


def select_owners(bindings, count):
    rows = list(bindings.values())[:count]
    assert 1 <= count <= 30 and len(rows) == count, 'Fixture owner count differs from the requested load'
    return rows


def validate_case_ids(cases):
    for case in cases:
        # Reserve room for generated child or schedule-delivery identifiers.
        maximum = {'mixed':48, 'schedule-delivery':55, 'scheduled-delivery':55}.get(case.get('kind'),64)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,' + str(maximum) + r'}', case.get('id','')):
            raise ValueError('Case ID exceeds its scenario family limit')


def validate_resume(tasks, prepared):
    expected = {(row['owner'], row['chat']['id'], row['case']['id']): row['case'] for row in prepared}
    actual = {(row['owner'], row['chat'], row['case']['id']): row['case'] for row in tasks}
    if not tasks or len(expected) != len(prepared) or len(actual) != len(tasks) or actual != expected:
        raise ValueError('Incomplete submission checkpoint; inspect accepted runs before recovery')


def missing_cases(tasks, snapshot):
    cases = {case['id']: case for case in snapshot['cases']}
    required = {task['case']['id'] for task in tasks}
    for task in tasks:
        case = task['case']
        if case.get('kind') in ('schedule-delivery', 'scheduled-delivery'):
            required.add(case['id'] + '_delivery')
        if case.get('kind') == 'mixed':
            rounds = max(1, cases.get(case['id'], {}).get('maxStep', 0) // 40)
            required.update(case['id'] + '_child' + str(cycle) for cycle in range(rounds))
    return sorted(case for case in required if not cases.get(case, {}).get('completed'))


def require_complete(tasks, snapshot):
    if not tasks or any(task.get('status') != 'completed' or task.get('complete') is not True for task in tasks):
        raise ValueError('Native tasks or their event histories are incomplete')
    missing = missing_cases(tasks, snapshot)
    if missing:
        raise ValueError('Some required synthetic cases did not complete: ' + ', '.join(missing))


class EventJournal:
    def __init__(self, path):
        self.path = path
        self.ids = set()
        if not path.exists():
            return
        with path.open('rb+') as stream:
            while True:
                offset = stream.tell()
                line = stream.readline()
                if not line:
                    break
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    if not line.endswith(b'\n') and not stream.read(1):
                        stream.truncate(offset)
                        break
                    raise ValueError('Corrupt completed event record: ' + path.name) from None
                event_id = self.event_id(event)
                if event_id in self.ids:
                    raise ValueError('Duplicate persisted event ID: ' + path.name)
                self.ids.add(event_id)
                if not line.endswith(b'\n'):
                    stream.write(b'\n')

    @staticmethod
    def event_id(event):
        value = event.get('_id')
        if not isinstance(value, str) or not value:
            raise ValueError('Native event has no stable ID')
        return value

    def append(self, events):
        # Validate the whole batch before writing any part of it.
        values = [(self.event_id(event), event) for event in events]
        pending = {event_id: event for event_id, event in values if event_id not in self.ids}
        try:
            with self.path.open('a', encoding='utf-8', newline='\n') as stream:
                stream.write(''.join(json.dumps(event, ensure_ascii=False) + '\n' for event in pending.values()))
                stream.flush()
                os.fsync(stream.fileno())
        except OSError:
            self.__init__(self.path)
            raise
        self.ids.update(pending)
        return len(self.ids)
