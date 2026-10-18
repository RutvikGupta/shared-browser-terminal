"""Focused tests for terminal authentication and safe process/session selection."""
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import tempfile
import os
import socket
import ssl
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


class OpenWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.config = {'session': 'test', 'port': 7682}
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)

    def mock(self, name, **kwargs):
        return self.stack.enter_context(patch.object(terminal, name, **kwargs))

    def prepare_wait(self, old=False):
        (self.state / 'url.txt').write_text('https://test.trycloudflare.com')
        (self.state / 'tunnel.pid').write_text('123')
        if old:
            os.utime(self.state / 'tunnel.pid', (1, 1))
        clock = [0.0]
        self.stack.enter_context(patch.object(terminal.time, 'monotonic', side_effect=lambda: clock[0]))
        self.stack.enter_context(patch.object(terminal.time, 'sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)))
        self.mock('owned_process', return_value=True)
        self.ensure = self.mock('ensure_tunnel')
        self.stop = self.mock('stop_process')
        self.mock('public_address', return_value=('104.16.230.132', 'system'))
        self.http = self.mock('verify_http')
        self.ws = self.mock('verify_websocket')

    def test_healthy_tunnel_returns_without_wait_or_restart(self):
        self.prepare_wait(old=True)
        self.assertEqual(terminal.wait_for_public(self.state, self.config, 45), (None, 'system'))
        self.assertEqual(terminal.time.monotonic(), 0)
        self.stop.assert_not_called()
        self.http.assert_called_once()
        self.ws.assert_called_once()

    def test_transient_edge_failure_retries_same_tunnel(self):
        self.prepare_wait(old=True)
        self.http.side_effect = [terminal.PublicPending('HTTP 530'), None]
        self.assertEqual(terminal.wait_for_public(self.state, self.config, 45), (None, 'system'))
        self.stop.assert_not_called()
        self.assertEqual(self.http.call_count, 2)

    def test_old_unavailable_tunnel_replaced_at_most_once(self):
        self.prepare_wait(old=True)
        self.http.side_effect = OSError('connection unavailable')
        error, _ = terminal.wait_for_public(self.state, self.config, 12)
        self.assertIn('unavailable', error)
        self.stop.assert_called_once_with(self.state, self.config, 'tunnel')
        self.assertEqual(self.ensure.call_count, 2)

    def test_recent_tunnel_preserved_on_retry(self):
        self.prepare_wait()
        self.http.side_effect = OSError('DNS pending')
        error, _ = terminal.wait_for_public(self.state, self.config, 12)
        self.assertIn('pending', error)
        self.stop.assert_not_called()
        self.ensure.assert_called_once()

    def test_auth_failure_is_fatal_not_a_restart_trigger(self):
        self.prepare_wait(old=True)
        self.http.side_effect = RuntimeError('anonymous: HTTP 200')
        with self.assertRaisesRegex(RuntimeError, 'HTTP 200'):
            terminal.wait_for_public(self.state, self.config, 45)
        self.stop.assert_not_called()
        self.ws.assert_not_called()

    def test_tls_failure_is_fatal(self):
        self.prepare_wait(old=True)
        self.http.side_effect = terminal.urllib.error.URLError(ssl.SSLCertVerificationError('certificate failed'))
        with self.assertRaisesRegex(RuntimeError, 'TLS certificate'):
            terminal.wait_for_public(self.state, self.config, 45)
        self.stop.assert_not_called()

    def test_url_assigned_after_initial_wait_is_discovered(self):
        self.prepare_wait()
        (self.state / 'url.txt').unlink()
        (self.state / 'tunnel.log').write_text('Visit https://late.trycloudflare.com')
        self.ensure.side_effect = terminal.PublicPending('address pending')
        self.assertEqual(terminal.wait_for_public(self.state, self.config, 45), (None, 'system'))
        self.assertEqual(terminal.read_url(self.state), 'https://late.trycloudflare.com')

    def test_pending_result_does_not_claim_url_or_create_extra_window(self):
        for name in ['require_tools', 'apply_tmux_theme', 'save_config', 'ensure_credentials']:
            self.mock(name)
        self.mock('find_session', return_value='$1')
        self.mock('owned_process', return_value=True)
        restart = self.mock('restart_ttyd')
        self.mock('verify_http')
        self.mock('wait_for_public', return_value=('DNS pending', None))
        window = self.mock('requested_window')
        self.mock('status', return_value={'url': 'https://unready.trycloudflare.com'})
        result = terminal.open_terminal(self.state, self.config, self.state, new_window=True, request_id='retry-me')
        self.assertEqual(result['readiness'], 'pending')
        self.assertIsNone(result['url'])
        window.assert_not_called()
        restart.assert_not_called()

    def test_same_request_id_reuses_window_but_new_id_creates_one(self):
        run = self.mock('run', side_effect=['@1', '@2', '@1\n@2', '', '@1\n@2', '@3'])
        self.assertEqual(terminal.requested_window(self.state, '$1', self.state, 'one'), '@2')
        self.assertEqual(terminal.requested_window(self.state, '$1', self.state, 'one'), '@2')
        self.assertEqual(terminal.requested_window(self.state, '$1', self.state, 'two'), '@3')
        creates = [call for call in run.call_args_list if call.args[1] == 'new-window']
        self.assertEqual(len(creates), 2)

    def test_concurrent_mutations_are_rejected(self):
        with terminal.operation_lock(self.state):
            with self.assertRaises(RuntimeError):
                with terminal.operation_lock(self.state):
                    self.fail('second mutation acquired lock')


class DNSVerificationTests(unittest.TestCase):
    def test_fallback_sends_only_hostname_and_returns_public_address(self):
        with tempfile.TemporaryDirectory() as name:
            state = Path(name)
            (state / 'url.txt').write_text('https://test.trycloudflare.com')
            response = unittest.mock.MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps({
                'Status': 0, 'Answer': [{'type': 1, 'data': '104.16.230.132'}]}).encode()
            opener = unittest.mock.Mock()
            opener.open.return_value = response
            with patch.object(terminal.socket, 'getaddrinfo', side_effect=socket.gaierror()), patch.object(terminal.urllib.request, 'build_opener', return_value=opener), patch.object(terminal, 'credentials') as credentials:
                self.assertEqual(terminal.public_address(state, 2), ('104.16.230.132', 'cloudflare'))
                request = opener.open.call_args.args[0]
                self.assertEqual(request.full_url, 'https://cloudflare-dns.com/dns-query?name=test.trycloudflare.com&type=A')
                self.assertNotIn('Authorization', request.headers)
                credentials.assert_not_called()

    def test_fresh_hostname_waits_for_public_dns_before_querying_router(self):
        with tempfile.TemporaryDirectory() as name:
            state = Path(name)
            (state / 'url.txt').write_text('https://test.trycloudflare.com')
            (state / 'tunnel.pid').write_text('123')
            with patch.object(terminal, 'cloudflare_address', side_effect=terminal.PublicPending('not assigned')), patch.object(terminal.socket, 'getaddrinfo') as lookup:
                with self.assertRaises(terminal.PublicPending):
                    terminal.public_address(state, 2)
                lookup.assert_not_called()

    def test_resolved_connection_keeps_original_tls_hostname(self):
        context = unittest.mock.Mock()
        raw = unittest.mock.Mock()
        with patch.object(terminal.ssl, 'create_default_context', return_value=context), patch.object(terminal.socket, 'create_connection', return_value=raw) as connect:
            conn = terminal.ResolvedHTTPSConnection('test.trycloudflare.com', '104.16.230.132', 2)
            conn.connect()
            connect.assert_called_once_with(('104.16.230.132', 443), timeout=2)
            context.wrap_socket.assert_called_once_with(raw, server_hostname='test.trycloudflare.com')

    def test_public_http_failure_classification_and_no_redirect_following(self):
        with tempfile.TemporaryDirectory() as name:
            state = Path(name)
            (state / 'url.txt').write_text('https://test.trycloudflare.com')
            terminal.ensure_credentials(state)
            conn = unittest.mock.Mock()
            with patch.object(terminal, 'ResolvedHTTPSConnection', return_value=conn):
                for code, expected in [(530, terminal.PublicPending), (302, RuntimeError), (200, RuntimeError)]:
                    conn.getresponse.return_value.status = code
                    conn.request.reset_mock()
                    with self.assertRaises(expected):
                        terminal.verify_http(state, {}, public=True, quiet=True, address='104.16.230.132')
                    conn.request.assert_called_once_with('GET', '/', headers={})
                    self.assertTrue(conn.close.called)



class StateMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.root / 'tmp/terminal'
        self.new = self.root / 'Application Support/shared-browser-terminal'
        self.old.mkdir(parents=True)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(terminal, 'LEGACY_STATE', self.old))
        self.stack.enter_context(patch.object(terminal, 'DEFAULT_STATE', self.new))

    def test_migration_preserves_credentials_locks_and_open_logs(self):
        terminal.ensure_credentials(self.old)
        login = terminal.credentials(self.old)
        (self.old / 'window-requests.json').write_text('{"request":"@7"}')
        with (self.old / 'ttyd.log').open('a') as log:
            log.write('before\n'); log.flush()
            self.assertEqual(terminal.resolve_state(), self.new)
            log.write('after\n'); log.flush()
        self.assertTrue(self.old.is_symlink())
        self.assertEqual(terminal.credentials(self.new), login)
        self.assertEqual((self.new / 'ttyd.log').read_text(), 'before\nafter\n')
        self.assertEqual((self.new / 'window-requests.json').read_text(), '{"request":"@7"}')
        self.assertEqual(self.new.stat().st_mode & 0o777, 0o700)
        self.assertEqual(terminal.resolve_state(self.old), self.new)
        with terminal.operation_lock(self.old):
            with self.assertRaises(RuntimeError):
                with terminal.operation_lock(self.new):
                    self.fail('Legacy and durable paths must share one operation lock')

    def test_migration_refuses_active_operation(self):
        with terminal.operation_lock(self.old):
            with self.assertRaises(RuntimeError):
                terminal.resolve_state()
        self.assertTrue(self.old.is_dir())
        self.assertFalse(self.new.exists())

    def test_conflicting_state_is_never_overwritten(self):
        self.new.mkdir(parents=True)
        (self.new / 'login.txt').write_text('keep this')
        with self.assertRaisesRegex(RuntimeError, 'Both legacy'):
            terminal.resolve_state()
        self.assertEqual((self.new / 'login.txt').read_text(), 'keep this')
        self.assertFalse(self.old.is_symlink())

    def test_custom_state_does_not_migrate_default(self):
        custom = self.root / 'custom'
        self.assertEqual(terminal.resolve_state(custom), custom)
        self.assertTrue(self.old.is_dir())
        self.assertFalse(self.new.exists())

    def test_unexpected_legacy_symlink_is_rejected(self):
        self.old.rmdir()
        self.old.symlink_to(self.root / 'unrelated')
        with self.assertRaisesRegex(RuntimeError, 'unexpected'):
            terminal.resolve_state()

    def test_fresh_default_needs_no_legacy_directory(self):
        self.old.rmdir()
        self.assertEqual(terminal.resolve_state(), self.new)
        self.assertTrue(self.new.is_dir())
        self.assertFalse(self.old.exists())


class TrackingRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='state with spaces ')
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.config = {'port': 7682}
        terminal.ensure_credentials(self.state)
        self.command = ('/opt/homebrew/bin/ttyd -W -O -a -I ' + str(self.state / 'index.html')
                        + ' -i 127.0.0.1 -p 7682 -c ' + terminal.credentials(self.state) + ' -t theme truncated')
        # Only exercise ttyd in tests that do not explicitly remove this record.
        (self.state / 'tunnel.pid').write_text('456')

    def recover(self, command=None, listeners=None, verify_error=None):
        with patch.object(terminal, 'listening_pids', side_effect=listeners or [{123}, {123}]), \
             patch.object(terminal, 'process_command', return_value=command or self.command), \
             patch.object(terminal, 'verify_http', side_effect=verify_error) as verify:
            terminal.recover_tracking(self.state, self.config)
        return verify

    def test_matching_authenticated_server_recovers_without_restart(self):
        with patch.object(terminal.os, 'kill') as kill:
            self.assertEqual(self.recover().call_count, 1)
        kill.assert_not_called()
        self.assertEqual((self.state / 'ttyd.pid').read_text(), '123')
        self.assertEqual((self.state / 'ttyd.pid').stat().st_mode & 0o777, 0o600)

    def test_other_page_login_port_and_executable_are_not_adopted(self):
        for command in [self.command.replace('index.html', 'other.html'),
                        self.command.replace(terminal.credentials(self.state), 'other:password'),
                        self.command.replace('7682', '7683'), self.command.replace('/ttyd ', '/bash ')]:
            with self.subTest(command_kind=command.split()[0]):
                self.recover(command).assert_not_called()
                self.assertFalse((self.state / 'ttyd.pid').exists())

    def test_authentication_failure_does_not_record_pid(self):
        with self.assertRaisesRegex(RuntimeError, 'authentication failed'):
            self.recover(verify_error=RuntimeError('authentication failed'))
        self.assertFalse((self.state / 'ttyd.pid').exists())

    def test_listener_change_does_not_record_pid(self):
        with self.assertRaisesRegex(RuntimeError, 'listener changed'):
            self.recover(listeners=[{123}, {999}])
        self.assertFalse((self.state / 'ttyd.pid').exists())

    def test_existing_record_is_not_overwritten(self):
        (self.state / 'ttyd.pid').write_text('789')
        with patch.object(terminal, 'listening_pids') as inspect:
            terminal.recover_tracking(self.state, self.config)
        inspect.assert_not_called()
        self.assertEqual((self.state / 'ttyd.pid').read_text(), '789')

    def test_other_users_process_is_not_recognized(self):
        with patch.object(terminal.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, f'{os.getuid()+1} {self.command}', '')):
            self.assertIsNone(terminal.process_command(123))

    def test_tunnel_requires_its_open_log_not_just_the_port(self):
        (self.state / 'ttyd.pid').write_text('123')
        (self.state / 'tunnel.pid').unlink()
        (self.state / 'tunnel.log').write_text('log')
        command = '/opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:7682 --no-autoupdate'
        for logfile, expected in [(self.state / 'other.log', False), (self.state / 'tunnel.log', True)]:
            with patch.object(terminal.subprocess, 'check_output', return_value=f'456 {os.getuid()} {command}\n'), \
                 patch.object(terminal.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'p456\nf1\nn'+str(logfile)+'\n', '')), \
                 patch.object(terminal, 'process_command', return_value=command):
                terminal.recover_tracking(self.state, self.config)
            self.assertEqual((self.state / 'tunnel.pid').exists(), expected)
        self.assertEqual((self.state / 'tunnel.pid').read_text(), '456')
        self.assertLess((self.state / 'tunnel.pid').stat().st_mtime, 120)


if __name__ == '__main__':
    unittest.main()
