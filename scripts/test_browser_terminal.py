"""Focused tests for terminal authentication and safe process/session selection."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

spec = importlib.util.spec_from_file_location('browser_terminal', Path(__file__).with_name('browser_terminal.py'))
terminal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal)


class BrowserTerminalTests(unittest.TestCase):
    def test_session_matching_does_not_attach_to_server_logs(self):
        result = subprocess.CompletedProcess([], 0, '$1 codex-browser-server\n$2 codex-browser\n', '')
        with patch.object(terminal.subprocess, 'run', return_value=result):
            self.assertEqual(terminal.find_session('codex-browser'), '$2')
            self.assertIsNone(terminal.find_session('codex'))

    def test_ttyd_mutated_argv_is_recognized_but_wrong_port_is_not(self):
        config = {'port': 7682, 'session': 'codex-browser'}
        command = '/opt/homebrew/bin/ttyd -W -O -i 127.0.0.1 -p 7682 -c secret -t titleFixed Shared Terminal'
        self.assertTrue(terminal.process_matches(command, config, 'ttyd'))
        self.assertFalse(terminal.process_matches(command.replace('7682', '7681'), config, 'ttyd'))
        self.assertFalse(terminal.process_matches(command.replace('/ttyd ', '/bash '), config, 'ttyd'))

    def test_stop_refuses_reused_pid(self):
        with tempfile.TemporaryDirectory() as name:
            state = Path(name)
            (state / 'ttyd.pid').write_text('123')
            with patch.object(terminal, 'owned_process', return_value=False), patch.object(terminal.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)), patch.object(terminal.os, 'kill') as kill:
                with self.assertRaises(RuntimeError):
                    terminal.stop_process(state, {'port': 7682}, 'ttyd')
                kill.assert_not_called()

    def test_credentials_private_and_stable(self):
        with tempfile.TemporaryDirectory() as name:
            state = Path(name)
            terminal.ensure_credentials(state)
            first = terminal.credentials(state)
            terminal.ensure_credentials(state)
            self.assertEqual(first, terminal.credentials(state))
            self.assertEqual((state / 'login.txt').stat().st_mode & 0o777, 0o600)
            self.assertGreaterEqual(len(first.split(':')[1]), 32)

    def test_unexpected_hosts_never_receive_credentials(self):
        with tempfile.TemporaryDirectory() as name:
            state = Path(name)
            for url in ['http://example.com', 'https://x.trycloudflare.com.evil.test', 'https://x.trycloudflare.com/path']:
                (state / 'url.txt').write_text(url)
                with self.assertRaises(ValueError):
                    terminal.read_url(state)
            (state / 'url.txt').write_text('https://random-name.trycloudflare.com')
            self.assertEqual(terminal.read_url(state), 'https://random-name.trycloudflare.com')

    def test_redirects_are_not_followed_with_credentials(self):
        self.assertIsNone(terminal.NoRedirect().redirect_request(None, None, 302, None, None, 'https://example.com'))

    def test_anonymous_access_is_rejected_before_publication(self):
        with tempfile.TemporaryDirectory() as name:
            state = Path(name)
            terminal.ensure_credentials(state)
            response = unittest.mock.MagicMock()
            response.__enter__.return_value.status = 200
            opener = unittest.mock.Mock()
            opener.open.return_value = response
            with patch.object(terminal.urllib.request, 'build_opener', return_value=opener):
                with self.assertRaisesRegex(RuntimeError, 'anonymous: HTTP 200'):
                    terminal.verify_http(state, {'port': 7682})


if __name__ == '__main__':
    unittest.main()
