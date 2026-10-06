import importlib.util
import io
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('launcher', 'compartilhar.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTest(unittest.TestCase):
    def test_occupied_unresponsive_port_does_not_start_tunnel(self):
        with patch.object(launcher, 'ensure_cloudflared', return_value='cloudflared'), \
             patch.object(launcher, 'port_in_use', return_value=True), \
             patch.object(launcher, 'board_responds', return_value=False), \
             patch.object(launcher.subprocess, 'Popen') as start:
            self.assertEqual(launcher.main(), 1)
            start.assert_not_called()

    def test_server_exit_aborts_readiness_wait(self):
        process = Mock()
        process.poll.return_value = 1
        with self.assertRaises(RuntimeError), patch.object(launcher, 'board_responds') as health:
            launcher.wait_for_board(launcher.LOCAL_URL, [process], 15)
        health.assert_not_called()

    def test_public_link_is_verified_and_interrupt_cleans_both_children(self):
        server, tunnel = Mock(), Mock()
        tunnel.stdout = io.StringIO('https://test-board.trycloudflare.com\nRegistered tunnel connection\n')
        with patch.object(launcher, 'ensure_cloudflared', return_value='cloudflared'), \
             patch.object(launcher, 'port_in_use', return_value=False), \
             patch.object(launcher.subprocess, 'Popen', side_effect=[server, tunnel]) as start, \
             patch.object(launcher, 'wait_for_board') as health, \
             patch.object(launcher, 'copy_to_clipboard', side_effect=KeyboardInterrupt), \
             patch.object(launcher, 'stop_process') as stop:
            self.assertEqual(launcher.main(), 0)
            self.assertEqual(health.call_args_list[0].args[0], 'http://127.0.0.1:8765')
            self.assertEqual(health.call_args_list[1].args[0], 'https://test-board.trycloudflare.com')
            self.assertIn('http://127.0.0.1:8765', start.call_args_list[1].args[0])
            self.assertEqual([call.args[0] for call in stop.call_args_list], [tunnel, server])

    def test_stop_process_resumes_suspended_child(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        try:
            import os
            os.kill(process.pid, signal.SIGSTOP)
            launcher.stop_process(process)
            self.assertIsNotNone(process.poll())
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()

    def test_close_script_kills_stubborn_project_process_only(self):
        import os
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'whiteboard').mkdir()
            script = root / 'whiteboard/server.py'
            script.write_text('import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint("ready", flush=True)\ntime.sleep(60)\n')
            close = root / 'fechar_servidor.sh'
            close.write_text(Path('fechar_servidor.sh').read_text())
            target = subprocess.Popen([sys.executable, str(script)], cwd=root, stdout=subprocess.PIPE, text=True)
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], cwd=root)
            try:
                self.assertEqual(target.stdout.readline().strip(), 'ready')
                os.kill(target.pid, signal.SIGSTOP)
                result = subprocess.run(['bash', str(close)], capture_output=True, text=True, timeout=12)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                target.wait(timeout=2)
                self.assertIsNone(unrelated.poll())
                self.assertIn('encerrados', result.stdout)
            finally:
                for process in (target, unrelated):
                    if process.poll() is None:
                        process.kill()
                    process.wait()
                target.stdout.close()


if __name__ == '__main__':
    unittest.main()
