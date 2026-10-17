"""Append native events once even if an observer restarts before saving its cursor."""
import json
import os


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
