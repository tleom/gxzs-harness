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
from mcp_policy import current

BASE = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == 'linux', 'Linux process groups required')
class SupervisorTests(unittest.TestCase):
    def test_reaping_adopted_children_preserves_the_main_worker_exit_status(self):
        from mcp_exec import reap_exited
        process = subprocess.Popen([sys.executable, '-I', '-c', 'raise SystemExit(7)'])
        try:
            deadline = time.monotonic()+3
            while process.returncode is None and time.monotonic()<deadline:
                reap_exited(process)
                time.sleep(.01)
            self.assertEqual(process.returncode, 7)
            self.assertEqual(process.wait(timeout=1), 7)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)

    def test_live_supervisor_reaps_adopted_children_without_ending_the_worker(self):
        source = '''import os,json,time
for _ in range(12):
 child=os.fork()
 if child==0:
  if os.fork()==0:os._exit(0)
  os._exit(0)
 os.waitpid(child,0)
print(json.dumps({'ready':True}),flush=True)
time.sleep(30)
'''
        process = self.start(source)
        try:
            self.assertTrue(json.loads(process.stdout.readline())['ready'])
            deadline = time.monotonic()+2
            while True:
                zombies = []
                for entry in Path('/proc').iterdir():
                    if not entry.name.isdecimal():
                        continue
                    try:
                        fields = (entry/'stat').read_text().rsplit(')',1)[1].split()
                        if fields[0] == 'Z' and int(fields[1]) == process.pid:
                            zombies.append(entry.name)
                    except (OSError, ValueError):
                        pass
                if not zombies or time.monotonic() >= deadline:
                    break
                time.sleep(.02)
            self.assertEqual(zombies, [])
            self.assertIsNone(process.poll())
        finally:
            process.stdin.close()
            process.wait(timeout=5)
            process.stdout.close()

    def test_large_bundled_source_uses_the_existing_supervisor_without_argv_overflow(self):
        from mcp_exec import command_source
        source = '# bundled module\n' * 20000 + 'print("ready", flush=True)'
        supervisor = (BASE / 'mcp_exec.py').read_text()
        process = subprocess.Popen([sys.executable, '-I', '-u', '-c',
            command_source(supervisor + '\nsupervise(' + repr(source) + ',[],limits=' + repr(current()) + ')')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            self.assertEqual(process.stdout.readline(), b'ready\n')
            process.wait(timeout=5)
            self.assertTrue(json.loads(process.stdout.readline())['worker_group_fenced'])
            self.assertEqual(process.returncode, 0)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=3)

    def start(self, source):
        supervisor = (BASE / 'mcp_exec.py').read_text()
        return subprocess.Popen([sys.executable, '-I', '-u', '-c', supervisor + '\nsupervise(' + repr(source) + ',[],limits=' + repr(current()) + ')'],
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
            process = subprocess.Popen([sys.executable, '-I', '-u', '-c', source + '\nsupervise(' + repr(worker)
                                        + ',[],' + repr(token) + ',' + repr(time.time() + 25) + ',limits=' + repr(current()) + ')', marker],
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
                delayed = subprocess.run([sys.executable, '-I', '-c', source + '\nsupervise("raise SystemExit(9)",[],'
                                          + repr(token) + ',' + repr(time.time() + 25) + ',limits=' + repr(current()) + ')', marker],
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
        result = subprocess.run([sys.executable, '-I', '-u', '-c', source + '\nsupervise("import time; time.sleep(60)",[],limits=' + repr(current()) + ')'],
                                input='', capture_output=True, text=True, timeout=5)
        self.assertTrue(json.loads(result.stdout)['worker_group_fenced'])


if __name__ == '__main__':
    unittest.main()
