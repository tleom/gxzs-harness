import importlib.util
import json
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location('soak_evidence', Path(__file__).parents[3] / 'scripts/soak/evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
EventJournal = module.EventJournal


def test_resume_deduplicates_events_appended_before_cursor_checkpoint(tmp_path):
    path = tmp_path / 'events.jsonl'
    batch = [{'_id': '1-0', 'text': '中文😀'}, {'_id': '2-0'}]
    assert EventJournal(path).append(batch) == 2
    assert EventJournal(path).append([*batch, {'_id': '3-0'}]) == 3
    assert [json.loads(line)['_id'] for line in path.read_text(encoding='utf-8').splitlines()] == ['1-0', '2-0', '3-0']


@pytest.mark.parametrize('tail', [b'{"_id": "2-', b'{"_id":"2-0","text":"\xe4\xb8'])
def test_resume_discards_only_a_torn_last_record(tmp_path, tail):
    path = tmp_path / 'events.jsonl'
    path.write_bytes(b'{"_id":"1-0"}\n' + tail)
    assert EventJournal(path).append([{'_id':'1-0'}, {'_id':'2-0'}]) == 2
    assert len(path.read_text().splitlines()) == 2


def test_complete_corrupt_records_are_not_silently_removed(tmp_path):
    path = tmp_path / 'events.jsonl'
    path.write_bytes(b'{bad}\n')
    with pytest.raises(ValueError, match='Corrupt completed'):
        EventJournal(path)
    assert path.read_bytes() == b'{bad}\n'


def test_missing_event_identity_does_not_partially_append_a_batch(tmp_path):
    path = tmp_path / 'events.jsonl'
    journal = EventJournal(path)
    with pytest.raises(ValueError, match='stable ID'):
        journal.append([{'_id':'1-0'}, {'event':'missing id'}])
    assert not path.exists()
