import importlib.util
import json
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location('soak_evidence', Path(__file__).parents[3] / 'scripts/soak/evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
EventJournal = module.EventJournal


@pytest.mark.parametrize('change', ['missing', 'duplicate', 'different_owner', 'different_scenario'])
def test_resume_rejects_partial_or_changed_submission_manifests(change):
    prepared = [{'owner':'owner', 'chat':{'id':str(i)}, 'case':{'id':str(i),'rounds':40}} for i in range(3)]
    tasks = [{'owner':r['owner'], 'chat':r['chat']['id'], 'case':dict(r['case'])} for r in prepared]
    module.validate_resume(tasks, prepared)
    if change == 'missing': tasks.pop()
    elif change == 'duplicate': tasks[-1] = tasks[0]
    elif change == 'different_owner': tasks[-1]['owner'] = 'another'
    else: tasks[-1]['case']['rounds'] = 1
    with pytest.raises(ValueError, match='Incomplete submission checkpoint'):
        module.validate_resume(tasks, prepared)


def test_requested_owner_count_cannot_silently_shrink():
    with pytest.raises(AssertionError, match='requested load'):
        module.select_owners({'one': {'owner':'one'}}, 30)
    assert len(module.select_owners({str(i): {} for i in range(30)}, 30)) == 30


def test_schedule_parent_is_not_proof_of_delivered_child_completion():
    tasks = [{'case':{'id':'schedule','kind':'schedule-delivery'}}]
    snapshot = {'cases':[{'id':'schedule','completed':True}]}
    assert module.missing_cases(tasks,snapshot) == ['schedule_delivery']
    snapshot['cases'].append({'id':'schedule_delivery','completed':False})
    assert module.missing_cases(tasks,snapshot) == ['schedule_delivery']
    snapshot['cases'][-1]['completed'] = True
    assert module.missing_cases(tasks,snapshot) == []


def test_each_mixed_parent_requires_every_observed_child_cycle():
    tasks = [{'case':{'id':'a','kind':'mixed'}},{'case':{'id':'b','kind':'mixed'}}]
    snapshot = {'cases':[{'id':'a','maxStep':80,'completed':True},{'id':'b','maxStep':40,'completed':True},
                         {'id':'a_child0','completed':True},{'id':'a_child1','completed':True}]}
    assert module.missing_cases(tasks,snapshot) == ['b_child0']


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
