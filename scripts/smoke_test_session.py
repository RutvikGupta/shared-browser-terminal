"""Verify skill defaults in first windows, additional windows, and splits on macOS."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time
from unittest.mock import patch

import browser_terminal as terminal


def main():
    # A short private socket path avoids macOS's Unix socket path-length limit.
    with tempfile.TemporaryDirectory(prefix='sbt-', dir='/private/tmp') as name:
        work = Path(name)
        history = work / 'history'
        history.touch()
        env = dict(os.environ, TMUX_TMPDIR=name, HISTFILE=str(history))
        env.pop('TMUX', None)
        with patch.dict(os.environ, env, clear=True):
            try:
                terminal.run('tmux', '-f', '/dev/null', 'new-session', '-d',
                             '-s', 'fixture', '/bin/sleep 300')
                config = {'session': 'defaults-test', 'cwd': name}
                session = terminal.create_session(config)
                terminal.apply_tmux_theme(session)
                assert terminal.run('tmux', 'show-options', '-v', '-t', session, 'status') == 'off'
                assert terminal.run('tmux', 'show-options', '-v', '-t', session, 'mouse') == 'on'
                panes = terminal.run('tmux', 'list-panes', '-s', '-t', session,
                                     '-F', '#{pane_id}').splitlines()
                assert len(panes) == 1, 'Temporary bootstrap pane was not removed'
                panes.append(terminal.run('tmux', 'new-window', '-d', '-P', '-F', '#{pane_id}',
                                          '-t', session + ':', '-c', name))
                panes.append(terminal.run('tmux', 'split-window', '-d', '-P', '-F', '#{pane_id}',
                                          '-t', panes[-1], '-c', name))
                for i, pane in enumerate(panes):
                    assert terminal.run('tmux', 'display-message', '-p', '-t', pane,
                                        '#{history_limit}') == '50000'
                    # Verify the shell actually loads ble.sh, rather than only inspecting config.
                    result = work / ('shell-' + str(i))
                    command = ('declare -p BASH_VERSION BROWSER_TERMINAL_FEATURES_LOADED COLORTERM; '
                               'command -v trz')
                    command = '{ ' + command + '; } > ' + shlex.quote(str(result))
                    terminal.run('tmux', 'send-keys', '-t', pane, '-l', command)
                    terminal.run('tmux', 'send-keys', '-t', pane, 'Enter')
                    for _ in range(100):
                        if result.exists() and '/trz' in result.read_text():
                            break
                        time.sleep(0.1)
                    output = result.read_text() if result.exists() else ''
                    assert 'BROWSER_TERMINAL_FEATURES_LOADED="1"' in output, output
                    assert 'COLORTERM="truecolor"' in output, output
                    assert '/trz' in output, output
                print('PASS: first window, new window, and split all load suggestions, truecolor, and upload command')
                print('PASS: all panes have 50,000-line history; status bar hidden and mouse scrolling enabled')
            finally:
                subprocess.run(['tmux', 'kill-server'], capture_output=True)


if __name__ == '__main__':
    main()
