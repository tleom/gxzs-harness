"""Linux process tests without MCP or Docker dependencies."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import tempfile
import time
from uuid import uuid4

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

    def test_remote_receipt_survives_broken_output_and_blocks_late_start(self):
        with tempfile.TemporaryDirectory() as folder:
            source = (BASE / 'mcp_exec.py').read_text() + '\nSTATE=Path(' + repr(folder) + ')\n'
            token = uuid4().hex
            marker = 'gxzs-mcp-worker:' + token
            worker = "import os,time,json; print(json.dumps({'pid':os.getpid()}),flush=True); time.sleep(60)"
            process = subprocess.Popen([sys.executable, '-u', '-c', source + '\nsupervise(' + repr(worker)
                                        + ',[],' + repr(token) + ',' + repr(time.time() + 25) + ')', marker],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            try:
                pid = json.loads(process.stdout.readline())['pid']
                process.stdout.close()
                result = subprocess.run([sys.executable, '-c', source + '\nprint(fence_worker(' + repr(token) + '))'],
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.stdout.strip(), 'True', result.stderr)
                process.wait(timeout=5)
                self.assertFalse((Path('/proc') / str(pid)).exists())
                self.assertTrue(json.loads((Path(folder) / (token + '.json')).read_text())['fenced'])
                delayed = subprocess.run([sys.executable, '-c', source + '\nsupervise("raise SystemExit(9)",[],'
                                          + repr(token) + ',' + repr(time.time() + 25) + ')', marker],
                                         input='', capture_output=True, text=True, timeout=5)
                self.assertTrue(json.loads(delayed.stdout)['worker_group_fenced'])
            finally:
                process.stdin.close()
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=3)

    def test_missing_start_is_tombstoned_without_killing_another_process(self):
        with tempfile.TemporaryDirectory() as folder:
            source = (BASE / 'mcp_exec.py').read_text() + '\nSTATE=Path(' + repr(folder) + ')\n'
            token = uuid4().hex
            result = subprocess.run([sys.executable, '-c', source + '\nprint(fence_worker(' + repr(token) + '))'],
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.stdout.strip(), 'True', result.stderr)
            record = Path(folder) / (token + '.json')
            record.write_text(json.dumps({'pid':os.getpid(),'started':'invalid','fenced':False}))
            result = subprocess.run([sys.executable, '-c', source + '\nprint(fence_worker(' + repr(token) + '))'],
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.stdout.strip(), 'False', result.stderr)

    def test_io_setup_failure_after_spawn_still_stops_the_worker(self):
        source = (BASE / 'mcp_exec.py').read_text()
        source += '\nclass BrokenSelector:\n def __enter__(self): raise OSError("resource unavailable")\n def __exit__(self,*args): pass\nselectors.DefaultSelector=BrokenSelector\n'
        result = subprocess.run([sys.executable, '-u', '-c', source + '\nsupervise("import time; time.sleep(60)",[])'],
                                input='', capture_output=True, text=True, timeout=5)
        self.assertTrue(json.loads(result.stdout)['worker_group_fenced'])


if __name__ == '__main__':
    unittest.main()
