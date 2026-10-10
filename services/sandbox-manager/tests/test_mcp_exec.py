"""Linux process tests without MCP or Docker dependencies."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

BASE = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == 'linux', 'Linux process groups required')
class SupervisorTests(unittest.TestCase):
    def start(self, source):
        supervisor = (BASE / 'mcp_exec.py').read_text()
        return subprocess.Popen([sys.executable, '-u', '-c', supervisor + '\nsupervise(' + repr(source) + ',[])'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def test_nonzero_worker_exit_is_fenced(self):
        process = self.start('raise SystemExit(1)')
        try:
            process.wait(timeout=5)
            self.assertEqual(json.loads(process.stdout.readline()), {'worker_group_fenced': True})
            self.assertEqual(process.returncode, 0)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)

    def test_eof_stops_worker_and_descendant(self):
        process = self.start("import subprocess,sys,time,json,os; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True); print(json.dumps({'parent':os.getpid(),'child':child.pid}),flush=True); time.sleep(60)")
        try:
            pids = json.loads(process.stdout.readline())
            process.stdin.close()
            process.wait(timeout=5)
            self.assertEqual(json.loads(process.stdout.readline()), {'worker_group_fenced': True})
            for pid in pids.values():
                stat = Path('/proc') / str(pid) / 'stat'
                if stat.exists():
                    self.assertEqual(stat.read_text().rsplit(')', 1)[1].split()[0], 'Z')
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
            process.stdout.close()

    def test_failed_worker_adopts_and_stops_detached_descendant(self):
        process = self.start("import subprocess,sys,json; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True,stdout=subprocess.DEVNULL); print(json.dumps({'child':child.pid}),flush=True); raise SystemExit(1)")
        try:
            pid = json.loads(process.stdout.readline())['child']
            process.wait(timeout=5)
            self.assertEqual(json.loads(process.stdout.readline()), {'worker_group_fenced': True})
            self.assertFalse((Path('/proc') / str(pid)).exists())
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)


if __name__ == '__main__':
    unittest.main()
