"""Migrate live isolated servers and recover missing PID files without restarting them."""
import argparse
import os
from pathlib import Path
import socket
import sys
import subprocess
import tempfile
from unittest.mock import patch

import browser_terminal as terminal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publish', action='store_true', help='Also test a real temporary Cloudflare tunnel')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='sbt-state-', dir='/private/tmp') as name:
        root = Path(name)
        old, durable = root / 'legacy', root / 'Application Support/terminal'
        env = dict(os.environ, TMUX_TMPDIR=name)
        env.pop('TMUX', None)
        with patch.dict(os.environ, env, clear=True), patch.object(terminal, 'LEGACY_STATE', old), patch.object(terminal, 'DEFAULT_STATE', durable):
            state = old
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
            config = {'session': 'state-test', 'port': port, 'font_size': 14, 'cwd': name}
            terminal.prepare_state(state)
            terminal.save_config(state, config)
            terminal.ensure_credentials(state)
            try:
                terminal.run('tmux', '-f', '/dev/null', 'new-session', '-d', '-s', config['session'], '/bin/sleep 300')
                terminal.restart_ttyd(state, config)
                terminal.verify_http(state, config)
                kinds = ['ttyd']
                if args.publish:
                    terminal.ensure_tunnel(state, config, timeout=20)
                    kinds.append('tunnel')
                pids = {kind: (state / (kind + '.pid')).read_text() for kind in kinds}
                login, url = terminal.credentials(state), terminal.read_url(state)
                pane = terminal.run('tmux', 'display-message', '-p', '-t', '=state-test:', '#{pane_pid}')
                terminal.remember_window(state, 'keep-request', '@0')
                state = terminal.resolve_state()
                assert state == durable and old.is_symlink()
                assert terminal.credentials(state) == login
                assert terminal.read_url(state) == url
                assert (state / 'window-requests.json').read_text() == '{"keep-request": "@0"}\n'
                terminal.verify_http(state, config)
                for kind in kinds:
                    (state / (kind + '.pid')).unlink()
                # Exercise recovery through the normal CLI entry point, while
                # retaining the patched default/legacy paths of this isolated test.
                with patch.object(sys, 'argv', ['browser_terminal.py', '--state-dir', str(state), 'start', '--cwd', name]):
                    assert terminal.main() == 0
                for kind, pid in pids.items():
                    assert (state / (kind + '.pid')).read_text() == pid, kind + ' restarted or not recovered'
                terminal.verify_http(state, config)
                assert terminal.run('tmux', 'display-message', '-p', '-t', '=state-test:', '#{pane_pid}') == pane
                # Restarting ttyd later must also work with spaces in its durable page path.
                terminal.restart_ttyd(state, config)
                pid = (state / 'ttyd.pid').read_text()
                (state / 'ttyd.pid').unlink()
                with terminal.operation_lock(state):
                    terminal.recover_tracking(state, config)
                assert (state / 'ttyd.pid').read_text() == pid
                terminal.verify_http(state, config)
                print('PASS: live migration preserves shell, login, URL, logs and request IDs; missing records recover the same server PIDs, including paths with spaces.')
            finally:
                for kind in ['ttyd', 'tunnel']:
                    # Recovery also makes cleanup safe if an assertion failed after unlink.
                    with terminal.operation_lock(state):
                        terminal.recover_tracking(state, config)
                        terminal.stop_process(state, config, kind)
                subprocess.run(['tmux', 'kill-server'], capture_output=True)


if __name__ == '__main__':
    main()
