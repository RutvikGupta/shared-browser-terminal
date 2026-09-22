"""Exercise completion in an isolated tmux server using synthetic history only."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time
import uuid

from browser_terminal import bash_executable


def main():
    socket_name = 'browser-shell-test-' + uuid.uuid4().hex
    tmux = ['tmux', '-L', socket_name, '-f', '/dev/null']
    env = dict(os.environ)
    env.pop('TMUX', None)

    def run(*args):
        return subprocess.check_output([*tmux, *args], env=env, text=True)

    def send(*keys):
        run('send-keys', '-t', 'test:0.0', *keys)

    def type_text(value):
        for char in value:
            send('-l', char)
            time.sleep(0.04)

    def screen():
        return run('capture-pane', '-p', '-t', 'test:0.0').rstrip()

    def wait_for(predicate, description):
        for _ in range(50):
            if predicate():
                return
            time.sleep(0.1)
        raise AssertionError(description + '\n' + screen())

    try:
        with tempfile.TemporaryDirectory(prefix='browser-shell-test-') as directory:
            work = Path(directory)
            history = work / 'history'
            history.write_text('echo AUTOCOMPLETE_VERIFIED_12345\n')
            features = Path(__file__).with_name('shell-features.bash').resolve()
            rc = work / 'rc'
            rc.write_text('HISTFILE=' + shlex.quote(str(history)) + '\n'
                          + "PS1='test> '\n"
                          + 'source ' + shlex.quote(str(features)) + '\n')
            command = shlex.join(['/usr/bin/env', '-u', 'NO_COLOR', 'COLORTERM=truecolor',
                                 'TERM=xterm-256color', bash_executable(), '--noprofile',
                                 '--rcfile', str(rc), '-i'])
            run('new-session', '-d', '-s', 'test', '-x', '220', '-y', '30', command)
            wait_for(lambda: screen().splitlines()[-1:] == ['test>'], 'Clean shell startup failed')
            type_text('echo AUTOCOMPLETE_VER')
            wait_for(lambda: 'AUTOCOMPLETE_VERIFIED_12345' in screen(), 'No history suggestion')
            before = int(run('display-message', '-p', '-t', 'test:0.0', '#{cursor_x}'))
            send('Tab')
            wait_for(lambda: int(run('display-message', '-p', '-t', 'test:0.0', '#{cursor_x}')) > before,
                     'Tab did not accept the suggestion')
            assert screen().count('test>') == 1, 'Tab executed the suggestion'
            print('PASS: history suggestion and Tab acceptance without execution')

            send('C-c')
            time.sleep(0.3)
            prompt_count = screen().count('test>')
            send('-l', 'bleopt complete_auto_complete=')
            send('Enter')
            wait_for(lambda: screen().endswith('test>') and screen().count('test>') > prompt_count,
                     'Unable to disable suggestions for fallback test')
            filename = work / 'completion-file-example'
            filename.touch()
            send('-l', 'cat ' + shlex.quote(str(filename))[:-5])
            time.sleep(0.5)
            send('Tab')
            wait_for(lambda: screen().splitlines()[-1].endswith('completion-file-example'),
                     'Normal filename completion failed')
            print('PASS: ordinary Tab completion without a visible suggestion')

            send('C-c')
            time.sleep(0.3)
            send('C-r')
            type_text('AUTOCOMPLETE_')
            wait_for(lambda: 'AUTOCOMPLETE_VERIFIED_12345' in '\n'.join(screen().splitlines()[-2:])
                     and 'AUTOCOMPLETE_' in screen().splitlines()[-1],
                     'History search failed')
            print('PASS: Ctrl+R finds synthetic command history')
    finally:
        subprocess.run([*tmux, 'kill-server'], env=env, capture_output=True)


if __name__ == '__main__':
    main()
