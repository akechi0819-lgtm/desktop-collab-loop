#!/usr/bin/env python3
"""离线回归：替身模拟模型，实际运行夜间脚本和 Git。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class NightRunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.env = {**os.environ, 'HOME': str(self.home), 'AI_COLLAB_CAFFEINATED': '1'}
        subprocess.run([ROOT / 'install.sh'], env=self.env, check=True, stdout=subprocess.DEVNULL)
        self.project = self.home / 'project'
        self.project.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'user.name', 'Test')
        (self.project / 'file.txt').write_text('initial\n')
        self.git('add', 'file.txt')
        self.git('commit', '-qm', 'initial')
        handoff = self.project / '.local/collab/handoff.md'
        handoff.parent.mkdir(parents=True)
        handoff.write_text('目标：完成任务\n测试命令: true\n')
        self.handoff = handoff
        fake = '''#!/usr/bin/env python3
import os, pathlib, sys
p = pathlib.Path(os.environ['HOME']) / 'calls'
args = sys.argv[1:]
prompt = sys.stdin.read()
name = pathlib.Path(sys.argv[0]).name
with p.open('a') as f: f.write(name + ' ' + ' '.join(args) + '\\n')
if name == 'codex-ask' and ('--work' in args or '--hard' in args):
 print('施工完成')
elif name == 'codex-ask':
 marker = pathlib.Path(os.environ['HOME']) / 'reviewed'
 if os.environ.get('BLOCK_ONCE') and not marker.exists():
  marker.touch(); print('BLOCKER file.txt:1 修复问题')
 else: print('NO BLOCKER')
elif '晨报' in prompt: print('任务完成。测试通过。请验收。')
else: print('NO BLOCKER')
'''
        for name in ('agy-ask', 'codex-ask'):
            path = self.home / '.local/bin' / name
            path.write_text(fake)
            path.chmod(0o755)

    def git(self, *args):
        subprocess.run(['git', *args], cwd=self.project, env=self.env, check=True, stdout=subprocess.DEVNULL)

    def run_night(self):
        return subprocess.run([self.home / '.local/bin/night-run', '--mode', 'resume', self.project], env=self.env, capture_output=True, text=True)

    def test_success(self):
        result = self.run_night()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        text = self.handoff.read_text()
        self.assertIn('第 1 轮测试通过', text)
        self.assertIn('NO BLOCKER', text)
        self.assertIn('晨报', text)
        self.assertTrue((self.project / '.local/collab/latest-run.json').is_file())

    def test_test_failure_stops_before_review(self):
        self.handoff.write_text('测试命令: false\n')
        result = self.run_night()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('停止：第 1 轮测试', self.handoff.read_text())
        calls = (self.home / 'calls').read_text()
        self.assertEqual(calls.count('codex-ask'), 1)
        self.assertNotIn('agy-ask', calls)

    def test_blocker_is_fixed_and_reviewed_again(self):
        self.env['BLOCK_ONCE'] = '1'
        result = self.run_night()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        text = self.handoff.read_text()
        self.assertIn('BLOCKER file.txt:1', text)
        self.assertIn('第 2 轮联审', text)
        self.assertIn('晨报', text)
        calls = (self.home / 'calls').read_text()
        self.assertEqual(calls.count('codex-ask --work'), 2)

if __name__ == '__main__':
    unittest.main()
